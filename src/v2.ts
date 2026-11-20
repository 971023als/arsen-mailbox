import { ASSISTANT_DEFAULTS, assistantDefault, DEFAULT_INTERVAL_MINUTES } from "../public/js/assistant-defaults.js";
import {
  allow,
  authenticate,
  currentEpoch,
  EPOCH_NOT_LOWERED,
  exhausted,
  issued,
  json,
  newId,
  newKey,
  nowSeconds,
  readBody,
  readWithTicket,
  SECURITY_HEADERS,
  sendMessage,
  sha256hex,
  sinceOf,
  sourceOf,
  TRUST_NOTICE,
  type Env,
  type Participant,
} from "./app";
import { MAX_ROOM_PARTICIPANTS, MAX_ROOMS, SPACE_LIMITS } from "./brand";
import { dayCount, dayStart } from "./budget";
import { enroll, newRecoveryCodes } from "./enrollment";
import { exportPage } from "./export";
import { cleanName, cleanText, isPreviewBot, LIMITS, Refused } from "./policy";
import { retentionCutoff, retentionGuard } from "./retention";
import { avatarFields, readAvatars } from "./avatars";
import { requireSql, refusal } from "./transaction";

export async function serveAsset(request: Request, env: Env, url: URL) {
  // Credentials belong only on the API. Never forward headers, search or fragments to asset storage.
  if (request.headers.has("authorization") || request.headers.has("x-mailbox-key") || url.searchParams.has("k"))
    return json({ error: "not_found" }, 404);
  const shell = ["/", "/app", "/app/"].includes(url.pathname) || /^\/(?:app|r)\/[\w-]+\/?$/.test(url.pathname);
  const path = shell ? "/index.html" : url.pathname;
  const asset = await env.ASSETS!.fetch(new Request(url.origin + path, { method: request.method }));
  const headers = new Headers(asset.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  );
  const response = new Response(asset.body, { status: asset.status, headers });
  if (path === "/index.html" && request.method === "GET" && asset.ok && env.TURNSTILE_SITEKEY) {
    const sitekey = env.TURNSTILE_SITEKEY;
    return new HTMLRewriter()
      .on('meta[name="turnstile-sitekey"]', { element: (meta) => { meta.setAttribute("content", sitekey); } })
      .transform(response);
  }
  return response;
}

export function apiError(e: unknown) {
  const reason = refusal(e);
  const code = reason?.code;
  const status: Record<string, number> = {
    unauthorized: 401,
    forbidden: 403,
    rate_limited: 429,
    quota: 429,
    not_found: 404,
    signup_closed: 503,
    key_epoch_invalid: 503,
    invalid: 400,
    question_ambiguous: 400,
    policy_changed: 409,
    name_taken: 409,
  };
  const error =
    code === "key_missing"
      ? "unauthorized"
      : code === "preview_refused"
        ? "forbidden"
        : code && Object.hasOwn(status, code)
          ? code
          : "invalid";
  const response = json(
    reason?.retryAfter ? { error, retry_after: reason.retryAfter } : { error },
    reason ? status[error] : 500,
  );
  if (reason?.retryAfter) response.headers.set("retry-after", String(reason.retryAfter));
  return response;
}

async function spaceCredential(request: Request, env: Env, revoke: boolean) {
  const auth = request.headers.get("authorization");
  if (!auth) throw new Refused("unauthorized");
  const source = await sourceOf(request, env);
  if (await exhausted(env, "auth_fail", source)) throw new Refused("rate_limited");
  const key = /^Bearer (ams_[\w-]{32})$/i.exec(auth)?.[1];
  // Only these two revocation routes may match the currently stored key during an explicit maintenance closure.
  const requiredEpoch = revoke && env.KEY_EPOCH === "closed" ? null : await currentEpoch(env);
  const hash = key ? await sha256hex(key) : "";
  const space = await env.DB.prepare(
    "SELECT id,key_epoch,retention_days,retention_rev FROM spaces WHERE key_hash=? AND status='active' AND (? IS NULL OR key_epoch=?)",
  )
    .bind(hash, requiredEpoch, requiredEpoch)
    .first<{ id: string; key_epoch: number; retention_days: number | null; retention_rev: number }>();
  if (!space) {
    if (!(await allow(env, "auth_fail", source))) throw new Refused("rate_limited");
    throw new Refused("forbidden");
  }
  const epoch = space.key_epoch;
  for (const bucket of ["space", "space_day"]) {
    if (!(await allow(env, bucket, space.id))) {
      const window = LIMITS[bucket][1];
      throw new Refused("rate_limited", window - (nowSeconds() % window));
    }
  }
  const guard = requireSql(
    env.DB,
    "forbidden",
    "EXISTS(SELECT 1 FROM spaces WHERE id=? AND key_hash=? AND key_epoch=? AND status='active') AND " +
      EPOCH_NOT_LOWERED,
    space.id,
    hash,
    epoch,
    epoch,
  );
  return { id: space.id, guard, epoch, retentionDays: space.retention_days, retentionRev: space.retention_rev };
}

type Space = Awaited<ReturnType<typeof spaceCredential>>;
type Body = Record<string, unknown>;

function guestRoomGuard(db: D1Database, who: Participant) {
  return requireSql(db, "forbidden",
    "EXISTS(SELECT 1 FROM participants p JOIN rooms r ON r.id=p.room_id JOIN spaces s ON s.id=r.owner_id" +
      " WHERE p.id=? AND p.room_id=? AND p.key_hash=? AND p.key_epoch=? AND p.revoked=0 AND s.status='active')" +
      " AND " + EPOCH_NOT_LOWERED,
    who.id, who.room_id, who.key_hash, who.key_epoch, who.key_epoch);
}

function roomExport(
  db: D1Database, guards: D1PreparedStatement[], room: string, url: URL, spaceId: string, days: number | null, rev: number,
) {
  return exportPage(db, [...guards, retentionGuard(db, spaceId, days, rev)], room, url,
    retentionCutoff(days, nowSeconds()), sinceOf(url) ?? 0, `${days ?? "permanent"}:${rev}`);
}

async function messages(request: Request, env: Env, url: URL, room: string, body: Body, space?: Space) {
  let who: Participant;
  if (space) {
    const owner = await env.DB.prepare(
      "SELECT p.*,r.name AS room_name,r.owner_id AS space_id FROM participants p JOIN rooms r ON r.id=p.room_id" +
        " WHERE r.id=? AND r.owner_id=? AND p.is_owner=1 AND p.revoked=0",
    )
      .bind(room, space.id)
      .first<Participant>();
    if (!owner) throw new Refused("not_found");
    who = { ...owner, space_guard: space.guard, retention_days: space.retentionDays, retention_rev: space.retentionRev };
    if (request.method === "POST" && !(await allow(env, "send", who.id))) throw new Refused("rate_limited");
  } else {
    who = await authenticate(
      env,
      request,
      room,
      request.headers.get("x-mailbox-key"),
      request.method === "GET" ? "read" : "send",
    );
    if (!who.space_id) throw new Refused("not_found");
  }
  if (request.method === "GET") {
    const [page, more, , questions, turns] = await readWithTicket(env, who, sinceOf(url), false);
    return json({
      room: { id: room, name: who.room_name },
      retention_days: who.retention_days,
      retention_revision: who.retention_rev,
      me: { id: who.id, name: who.name, kind: who.kind },
      notice: TRUST_NOTICE.join(" "),
      more,
      questions,
      relay_turns: turns,
      messages: page.map(({ body, ...m }) => ({
        ...m,
        text: body,
        relay_label: m.relayed_for ? "사용자가 대신 올림" : null,
      })),
    });
  }
  if (body.relayed_for != null && !space) throw new Refused("forbidden");
  if (body.relayed_for != null && typeof body.relayed_for !== "string") throw new Refused("invalid");
  const id = await sendMessage(
    env,
    who,
    body.text,
    body.reply_to,
    null,
    false,
    (body.relayed_for as string | undefined) ?? null,
  );
  return json({ ok: true, id });
}

async function mySpace(db: D1Database, space: Space, action: string, method: string, body: Body) {
  const { id, guard } = space;
  if (action === "me" && method === "GET") {
    const [, info, usage] = await db.batch<Record<string, unknown>>([
      guard,
      db.prepare("SELECT id AS space_id,plan,status,created_at,last_seen_at,room_limit,participant_limit,retention_days," +
        "retention_rev AS retention_revision,assistant_defaults FROM spaces WHERE id=?").bind(id),
      db
        .prepare("SELECT (SELECT COUNT(*) FROM rooms WHERE owner_id=?) AS rooms," + dayCount + " AS messages_today")
        .bind(id, "space_posts", id, dayStart()),
      db.prepare("UPDATE spaces SET last_seen_at=unixepoch() WHERE id=? AND last_seen_at<unixepoch()-60").bind(id),
    ]);
    const { assistant_defaults, ...row } = info.results[0];
    return json({ ...row, assistant_defaults: JSON.parse(assistant_defaults as string), limits: {
      ...SPACE_LIMITS, rooms: row.room_limit, participants: row.participant_limit, retention_days: row.retention_days,
      max_rooms: MAX_ROOMS, max_participants: MAX_ROOM_PARTICIPANTS,
    }, usage: usage.results[0] });
  }
  if (action === "me" && method === "PATCH") {
    const limit = (value: unknown, max: number) => {
      if (value === undefined) return null;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new Refused("invalid");
      return value;
    };
    const rooms = limit(body.room_limit, MAX_ROOMS);
    const people = limit(body.participant_limit, MAX_ROOM_PARTICIPANTS);
    const days = body.retention_days;
    if (days !== undefined && days !== null && days !== 7 && days !== 30 && days !== 90) throw new Refused("invalid");
    if (rooms === null && people === null && days === undefined) throw new Refused("invalid");
    const [, updated] = await db.batch([
      guard,
      db.prepare("UPDATE spaces SET room_limit=COALESCE(?1,room_limit),participant_limit=COALESCE(?2,participant_limit)," +
        " retention_rev=CASE WHEN ?3=1 AND retention_days IS NOT ?4 THEN retention_rev+1 ELSE retention_rev END," +
        " retention_days=CASE WHEN ?3=1 THEN ?4 ELSE retention_days END WHERE id=?5" +
        " AND (?3=0 OR ?6=1 OR COALESCE(?4,91)>=COALESCE(retention_days,91))" +
        " RETURNING room_limit,participant_limit,retention_days,retention_rev AS retention_revision",
      ).bind(rooms, people, days === undefined ? 0 : 1, days ?? null, id, body.confirm === "보관 기간 단축" ? 1 : 0),
    ]);
    if (!updated.results.length) throw new Refused("invalid");
    return json(updated.results[0]);
  }
  if (action === "me/assistant-defaults" && method === "PATCH") {
    const { ai_type, delivery } = body;
    const interval = parseIntervalMinutes(body);
    if (Object.keys(body).some((field) => !["ai_type", "delivery", "interval_minutes", "check_interval_minutes"].includes(field)) ||
        typeof ai_type !== "string" || !Object.hasOwn(ASSISTANT_DEFAULTS, ai_type) ||
        assistantDefault(ai_type).delivery === "manual" ||
        (delivery !== "header" && delivery !== "get") || interval === undefined) throw new Refused("invalid");
    const settings = { delivery, interval_minutes: interval };
    await db.batch([
      guard,
      db.prepare("UPDATE spaces SET assistant_defaults=json_set(assistant_defaults,?,json(?)) WHERE id=?")
        .bind("$." + ai_type, JSON.stringify(settings), id),
    ]);
    return json({ ai_type, ...settings });
  }
  if (action === "me/participants/revoke-all" && method === "POST") {
    const target = "is_owner=0 AND room_id IN (SELECT id FROM rooms WHERE owner_id=?)";
    const [, , updated] = await db.batch([
      guard,
      db
        .prepare("DELETE FROM send_tickets WHERE participant_id IN (SELECT id FROM participants WHERE " + target + ")")
        .bind(id),
      db
        .prepare("UPDATE participants SET revoked=1,key_hash=lower(hex(randomblob(32))) WHERE revoked=0 AND " + target + " RETURNING id")
        .bind(id),
    ]);
    return json({ revoked_count: updated.results.length });
  }
  if (action === "me/rotate" && method === "POST") {
    const key = newKey("ams_");
    await db.batch([guard, db.prepare("UPDATE spaces SET key_hash=? WHERE id=?").bind(await sha256hex(key), id)]);
    return json({ space_id: id, key });
  }
  if (action === "me/recovery-codes" && method === "POST") {
    const { codes, inserts } = await newRecoveryCodes(db, id, space.epoch, nowSeconds());
    await db.batch([guard, db.prepare("DELETE FROM recovery_codes WHERE space_id=?").bind(id), ...inserts]);
    return json({ recovery_codes: codes });
  }
  if (action === "me" && method === "DELETE") {
    if (body.confirm !== "삭제") throw new Refused("invalid");
    await db.batch([
      guard,
      db.prepare("UPDATE spaces SET status='deleted',deleted_at=unixepoch() WHERE id=?").bind(id),
      db.prepare("UPDATE participants SET revoked=1 WHERE room_id IN(SELECT id FROM rooms WHERE owner_id=?)").bind(id),
      db.prepare("DELETE FROM recovery_codes WHERE space_id=?").bind(id),
    ]);
    return json({ deleted: true });
  }
  throw new Refused("not_found");
}

async function rooms(db: D1Database, space: Space, method: string, body: Body) {
  if (method === "GET") {
    const [, rows] = await db.batch<{ participants_json: string }>([
      space.guard,
      db
        .prepare(
          "SELECT r.id AS room_id,r.name,r.created_at,m.body AS last_message,m.created_at AS last_message_at," +
            "(SELECT json_group_array(json_object('participant_id',p2.id,'name',p2.name,'kind',p2.kind,'ai_type',p2.ai_type," +
            " 'is_owner',p2.is_owner,'avatar_preset',p2.avatar_preset,'avatar_rev',p2.avatar_rev," +
            " 'device_label',p2.device_label,'role_note',p2.role_note))" +
            " FROM participants p2 WHERE p2.room_id=r.id AND p2.revoked=0) AS participants_json," +
            "(SELECT count(*) FROM messages u WHERE u.room_id=r.id AND u.id>p.last_read_id AND u.participant_id!=p.id" +
            " AND u.created_at>COALESCE(?1-s.retention_days*86400,?2)) AS unread_count" +
            " FROM rooms r JOIN spaces s ON s.id=r.owner_id JOIN participants p ON p.room_id=r.id AND p.is_owner=1 LEFT JOIN messages m ON m.id=(" +
            "SELECT id FROM messages WHERE room_id=r.id AND created_at>COALESCE(?1-s.retention_days*86400,?2)" +
            " ORDER BY id DESC LIMIT 1) WHERE r.owner_id=?3 ORDER BY COALESCE(m.created_at,r.created_at) DESC,r.id",
        )
        .bind(
          nowSeconds(), Number.MIN_SAFE_INTEGER,
          space.id,
        ),
    ]);
    return json({ rooms: rows.results.map(({ participants_json, ...room }) => ({
      ...room, participants: JSON.parse(participants_json),
    })) });
  }
  if (method !== "POST") throw new Refused("not_found");
  const name = cleanName(body.name);
  const id = newId();
  const owner = newId();
  await db.batch([
    space.guard,
    requireSql(db, "quota", "(SELECT count(*) FROM rooms WHERE owner_id=?1)<(SELECT room_limit FROM spaces WHERE id=?1)", space.id),
    db.prepare("INSERT INTO rooms(id,owner_id,name,created_at) VALUES(?,?,?,unixepoch())").bind(id, space.id, name),
    db
      .prepare(
        "INSERT INTO participants(id,room_id,name,kind,is_owner,key_hash,key_epoch,created_at) VALUES(?,?,'공간 주인','human',1,?,?,unixepoch())",
      )
      .bind(owner, id, await sha256hex(newKey("internal_")), space.epoch),
  ]);
  return json({ room_id: id, name, owner_participant_id: owner });
}

const MAX_INTERVAL_MINUTES = SPACE_LIMITS.retention_days * 1440;
const ASSISTANT_AI_TYPES = Object.keys(ASSISTANT_DEFAULTS);

function parseIntervalMinutes(body: Body): number | undefined {
  const primary = body.interval_minutes;
  const legacy = body.check_interval_minutes;
  if (primary !== undefined && legacy !== undefined && primary !== legacy) throw new Refused("invalid");
  const raw = primary !== undefined ? primary : legacy;
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > MAX_INTERVAL_MINUTES) {
    throw new Refused("invalid");
  }
  return raw;
}

function profileText(value: unknown, limit: number, singleLine = false): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === "string" && !value.trim())) return null;
  const text = cleanText(value);
  if ([...text].length > limit || (singleLine && text.includes("\n"))) throw new Refused("invalid");
  return text;
}

async function members(
  env: Env,
  url: URL,
  space: Space,
  room: string,
  guards: D1PreparedStatement[],
  tail: string[],
  method: string,
  body: Body,
) {
  const db = env.DB;
  if (!tail.length && method === "GET") {
    const rows = (
      await db.batch<Record<string, unknown>>([
        ...guards,
        db
          .prepare(
            "SELECT id AS participant_id,name,kind,ai_type,delivery,COALESCE(interval_minutes,10) AS interval_minutes," +
              "is_owner,revoked,issued_at_message_id,first_read_at,last_read_at,last_read_at AS last_seen_at,created_at,avatar_preset,avatar_rev,device_label,role_note," +
              " CASE WHEN first_read_at IS NULL THEN 'created' WHEN last_read_at>=unixepoch()-300 THEN 'connected' ELSE 'last_seen' END AS status" +
              " FROM participants WHERE room_id=? ORDER BY is_owner DESC,created_at,rowid",
          )
          .bind(room),
      ])
    ).at(-1)!;
    return json({ participants: rows.results.map((r) => ({ ...r, is_owner: !!r.is_owner, revoked: !!r.revoked })) });
  }
  if (method === "PATCH" && tail.length === 1) {
    if (body.kind !== undefined || body.delivery !== undefined) throw new Refused("invalid");
    const interval = parseIntervalMinutes(body);
    const ai = body.ai_type;
    if (ai !== undefined && (typeof ai !== "string" || !ASSISTANT_AI_TYPES.includes(ai))) {
      throw new Refused("invalid");
    }
    const avatar = avatarFields(body, newId());
    const changes: ReadonlyArray<readonly [string, string | number | null | undefined]> = [
      ["name", body.name === undefined ? undefined : cleanName(body.name)],
      ["ai_type", ai as string | undefined],
      ["interval_minutes", interval],
      ["device_label", profileText(body.device_label, 64, true)],
      ["role_note", profileText(body.role_note, 240)],
      ...avatar,
    ];
    const fields = changes.filter((row): row is readonly [string, string | number | null] => row[1] !== undefined);
    if (!fields.length) throw new Refused("invalid");
    const assistantEdit = ai !== undefined || interval !== undefined;
    const [, , update] = await db.batch<{ interval_minutes: number | null }>([
      ...guards,
      db.prepare(
        "UPDATE participants SET " + fields.map(([name]) => name + "=?").join(",") +
          " WHERE id=? AND room_id=?" + (assistantEdit ? " AND kind='assistant' AND is_owner=0" : "") +
          (avatar.length ? " AND revoked=0" : "") +
          " RETURNING id AS participant_id,name,ai_type,delivery,interval_minutes,device_label,role_note,avatar_preset,avatar_rev",
      ).bind(...fields.map(([, value]) => value), tail[0], room),
    ]);
    const row = update.results[0];
    if (!row) {
      const existing = await db.prepare("SELECT kind FROM participants WHERE id=? AND room_id=?")
        .bind(tail[0], room).first<{ kind: string }>();
      if (existing && assistantEdit && existing.kind !== "assistant") throw new Refused("invalid");
      throw new Refused("not_found");
    }
    return json({ ...row, interval_minutes: row.interval_minutes ?? DEFAULT_INTERVAL_MINUTES });
  }
  if (method !== "POST" || (tail.length && !(tail.length === 2 && ["reissue", "revoke"].includes(tail[1]))))
    throw new Refused("not_found");
  const key = newKey("amk_");
  const hash = await sha256hex(key);
  const pid = tail[0] ?? newId();
  if (tail.length) {
    guards.push(
      requireSql(
        db,
        "not_found",
        "EXISTS(SELECT 1 FROM participants WHERE id=? AND room_id=? AND is_owner=0)",
        pid,
        room,
      ),
    );
    guards.push(db.prepare("DELETE FROM send_tickets WHERE participant_id=?").bind(pid));
    if (tail[1] === "revoke") {
      await db.batch([
        ...guards,
        db.prepare("UPDATE participants SET key_hash=?,revoked=1 WHERE id=?").bind(hash, pid),
      ]);
      return json({ revoked: true });
    }
    const delivery = body.delivery ?? null;
    if (delivery !== null && delivery !== "header" && delivery !== "get") throw new Refused("invalid");
    const reissueInterval = parseIntervalMinutes(body);
    if (reissueInterval !== undefined) {
      const target = await db
        .prepare(
          "SELECT p.kind FROM participants p JOIN rooms r ON r.id=p.room_id WHERE p.id=? AND p.room_id=? AND r.owner_id=? AND p.is_owner=0",
        )
        .bind(pid, room, space.id)
        .first<{ kind: string }>();
      if (target && target.kind !== "assistant") throw new Refused("invalid");
    }
    guards.push(db.prepare(
      "UPDATE participants SET key_hash=?,key_epoch=?,revoked=0," +
        "delivery=CASE WHEN kind='human' THEN 'header' ELSE COALESCE(?,delivery) END," +
        "interval_minutes=CASE WHEN kind='assistant' THEN COALESCE(?,interval_minutes) ELSE interval_minutes END" +
        " WHERE id=?",
    ).bind(hash, space.epoch, delivery, reissueInterval ?? null, pid));
  } else {
    const name = cleanName(body.name);
    if (body.kind !== "human" && body.kind !== "assistant") throw new Refused("invalid");
    const ai = body.ai_type ?? (body.kind === "human" ? "human" : "other");
    const delivery = body.delivery;
    const validAi = typeof ai === "string" &&
      (body.kind === "human" ? ai === "human" : ASSISTANT_AI_TYPES.includes(ai));
    if (!validAi || (delivery !== undefined && delivery !== null && delivery !== "header" && delivery !== "get")) throw new Refused("invalid");
    const rawInterval = parseIntervalMinutes(body);
    const isAssistant = body.kind === "assistant";
    if (!isAssistant && rawInterval !== undefined) throw new Refused("invalid");
    const defaults = assistantDefault(ai);
    const savedPath = isAssistant && defaults.delivery !== "manual" ? "$." + ai : null;
    guards.push(
      requireSql(db, "quota",
        "(SELECT count(*) FROM participants WHERE room_id=?)<(SELECT participant_limit FROM spaces WHERE id=?)", room, space.id),
      db.prepare(
        "INSERT INTO participants(id,room_id,name,kind,key_hash,key_epoch,ai_type,delivery,interval_minutes,device_label,role_note,created_at)" +
        " SELECT ?1,?2,?3,?4,?5,?6,?7,COALESCE(?8,json_extract(assistant_defaults,?9),?10)," +
        " COALESCE(?11,json_extract(assistant_defaults,?12),?13),?14,?15,unixepoch() FROM spaces WHERE id=?16",
      ).bind(pid, room, name, body.kind, hash, space.epoch, ai, delivery ?? null,
        savedPath && savedPath + ".delivery", defaults.delivery === "manual" ? "header" : defaults.delivery,
        rawInterval ?? null, savedPath && savedPath + ".interval_minutes", isAssistant ? defaults.interval_minutes : null,
        profileText(body.device_label, 64, true) ?? null, profileText(body.role_note, 240) ?? null, space.id),
    );
  }
  const rows = (
    await db.batch([
      ...guards,
      db
        .prepare(
          "SELECT p.name,p.kind,p.ai_type,p.delivery,p.interval_minutes,r.name AS room_name FROM participants p JOIN rooms r ON r.id=p.room_id WHERE p.id=?",
        )
        .bind(pid),
    ])
  ).at(-1)!;
  const p = rows.results[0] as {
    name: string;
    kind: string;
    ai_type: string;
    delivery: string;
    interval_minutes: number | null;
    room_name: string;
  };
  const effectiveInterval = p.kind === "assistant" ? (p.interval_minutes ?? DEFAULT_INTERVAL_MINUTES) : DEFAULT_INTERVAL_MINUTES;
  const base = env.PUBLIC_BASE_URL || url.origin;
  const output = issued(
    base,
    room,
    p.room_name,
    pid,
    p.name,
    p.kind,
    key,
    p.ai_type,
    p.delivery,
    p.kind === "assistant" ? effectiveInterval : undefined,
  );
  return json({
    ...output,
    ai_type: p.ai_type,
    delivery: p.delivery,
    interval_minutes: effectiveInterval,
    connection_text: p.kind === "human" ? output.human_link : output.assistant_text,
  });
}

export async function api(request: Request, env: Env, url: URL) {
  if (isPreviewBot(request.headers)) throw new Refused("forbidden");
  const memberKey = request.headers.has("x-mailbox-key");
  const bearer = request.headers.has("authorization");
  if (url.searchParams.has("k") || (memberKey && bearer)) throw new Refused("invalid");
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new Refused("forbidden");
  const { method } = request;
  const body = ["GET", "HEAD"].includes(method) ? {} : await readBody(request);
  if ("k" in body || "key" in body) throw new Refused("invalid");
  const action = url.pathname.slice(5);
  if (["spaces", "spaces/recover"].includes(action) && method === "POST") {
    if (memberKey || bearer) throw new Refused("invalid");
    return enroll(request, env, url, body, action.endsWith("/recover"));
  }
  const [root, room, part, ...tail] = action.split("/");
  const revoke =
    method === "POST" &&
    (action === "me/participants/revoke-all" ||
      (root === "rooms" && !!room && part === "participants" && tail.length === 2 && tail[1] === "revoke"));
  const space = bearer ? await spaceCredential(request, env, revoke) : undefined;
  if (root === "rooms" && room && part === "messages" && !tail.length && ["POST", "GET"].includes(method))
    return messages(request, env, url, room, body, space);
  if (!space && memberKey && root === "rooms" && room && ["export", "avatars", "participants"].includes(part) &&
      method === "GET" && !tail.length) {
    const who = await authenticate(env, request, room, request.headers.get("x-mailbox-key"), "read");
    if (!who.space_id || who.kind !== "human") throw new Refused("forbidden");
    const db = env.DB;
    const guards = [guestRoomGuard(db, who)];
    if (part === "export") return json(await roomExport(db, guards, room, url, who.space_id, who.retention_days, who.retention_rev));
    if (part === "avatars") return json(await readAvatars(db, guards, room, url));
    const [, roster] = await db.batch([...guards, db.prepare(
      "SELECT id AS participant_id,name,kind,ai_type,is_owner,avatar_preset,avatar_rev,device_label,role_note FROM participants" +
        " WHERE room_id=? AND revoked=0 ORDER BY is_owner DESC,created_at,rowid",
    ).bind(room)]);
    return json({ participants: roster.results });
  }
  if (!space) throw new Refused(memberKey ? "forbidden" : "unauthorized");
  if (root === "me") return mySpace(env.DB, space, action, method, body);
  if (action === "rooms") return rooms(env.DB, space, method, body);
  if (root !== "rooms" || !room) throw new Refused("not_found");
  const db = env.DB;
  const guards = [
    space.guard,
    requireSql(db, "not_found", "EXISTS(SELECT 1 FROM rooms WHERE id=? AND owner_id=?)", room, space.id),
  ];
  if (part === "export" && method === "GET" && !tail.length) {
    return json(await roomExport(db, guards, room, url, space.id, space.retentionDays, space.retentionRev));
  }
  if (part === "avatars" && method === "GET" && !tail.length) return json(await readAvatars(db, guards, room, url));
  if (part === "participants") return members(env, url, space, room, guards, tail, method, body);
  if (part !== undefined) throw new Refused("not_found");
  if (method === "PATCH") {
    const name = cleanName(body.name);
    await db.batch([...guards, db.prepare("UPDATE rooms SET name=? WHERE id=?").bind(name, room)]);
    return json({ room_id: room, name });
  }
  if (method === "DELETE") {
    await db.batch([...guards, db.prepare("DELETE FROM rooms WHERE id=?").bind(room)]);
    return json({ deleted: true });
  }
  throw new Refused("not_found");
}
