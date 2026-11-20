import {
  allow,
  exhausted,
  currentEpoch,
  EPOCH_NOT_LOWERED,
  json,
  newId,
  newKey,
  nowSeconds,
  RAISE_FLOOR,
  sha256hex,
  sourceOf,
  type Env,
} from "./app";
import { SPACE_LIMITS } from "./brand";
import { dayCount, dayStart } from "./budget";
import { Refused } from "./policy";
import { requireSql, refusal } from "./transaction";

export async function newRecoveryCodes(db: D1Database, id: string, epoch: number, now: number) {
  const codes = Array.from({ length: 10 }, () => newKey("amr_"));
  const hashes = await Promise.all(codes.map(sha256hex));
  const inserts = hashes.map((hash) =>
    db.prepare("INSERT INTO recovery_codes(space_id,code_hash,created_at,key_epoch) VALUES(?,?,?,?)")
      .bind(id, hash, now, epoch),
  );
  return { codes, inserts };
}

async function verifyHuman(env: Env, url: URL, token: unknown) {
  if (typeof token !== "string" || !token || token.length > 2048) throw new Refused("invalid");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const secret = env.TURNSTILE_SECRET;
  const dummy = /^(?:1|2|3)x0+AA$/.test(secret ?? "");
  if (!secret || (dummy && !local)) throw new Refused("forbidden");
  let verified = false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({ secret, response: token }),
    });
    if (r.ok) {
      const result = await r.json<{ success: boolean; hostname?: string }>();
      verified =
        result.success === true && (dummy || result.hostname === new URL(env.PUBLIC_BASE_URL || url.origin).hostname);
    }
  } catch {
    /* Siteverify unavailability closes enrollment and recovery. */
  }
  if (!verified) throw new Refused("forbidden");
}

export async function enroll(request: Request, env: Env, url: URL, body: Record<string, unknown>, recover: boolean) {
  if (!env.SOURCE_HASH_KEY?.trim()) throw new Refused("forbidden");
  const source = await sourceOf(request, env);
  if (await exhausted(env, "auth_fail", source)) throw new Refused("rate_limited");
  try {
    return await enrollChecked(env, url, body, recover, source);
  } catch (e) {
    const reason = refusal(e);
    if (reason?.code === "forbidden" && !(await allow(env, "auth_fail", source))) throw new Refused("rate_limited");
    throw reason ?? e;
  }
}

async function enrollChecked(env: Env, url: URL, body: Record<string, unknown>, recover: boolean, ipHash: string) {
  const db = env.DB;
  const epoch = await currentEpoch(env);
  const now = nowSeconds();
  const day = dayStart();
  if (!recover) {
    if (!["on", "invite"].includes(env.SIGNUP_OPEN ?? "")) throw new Refused("signup_closed");
    if (
      await db
        .prepare("SELECT " + dayCount + ">=? AS stop")
        .bind("estimated_writes", "all", day, SPACE_LIMITS.signup_stop_writes)
        .first("stop")
    )
      throw new Refused("signup_closed");
  }
  const value = recover ? body.code : body.invite;
  if (typeof value !== "string" || !value || value.length > 256) throw new Refused("invalid");
  await verifyHuman(env, url, body.turnstile);
  const hash = await sha256hex(value);
  const key = newKey("ams_");
  const keyHash = await sha256hex(key);
  const guard = requireSql(db, "key_epoch_invalid", EPOCH_NOT_LOWERED, epoch);
  if (recover) {
    const [, , updated, , active] = await db.batch<{ id: string; active_participants: number }>([
      guard,
      requireSql(
        db,
        "forbidden",
        "EXISTS(SELECT 1 FROM recovery_codes c JOIN spaces s ON s.id=c.space_id" +
          " WHERE c.code_hash=? AND c.used_at IS NULL AND c.key_epoch=? AND s.key_epoch=? AND s.status='active')",
        hash,
        epoch,
        epoch,
      ),
      db
        .prepare(
          "UPDATE spaces SET key_hash=?,last_seen_at=? WHERE id=(SELECT space_id FROM recovery_codes WHERE code_hash=?) RETURNING id",
        )
        .bind(keyHash, now, hash),
      db.prepare("UPDATE recovery_codes SET used_at=? WHERE code_hash=?").bind(now, hash),
      db
        .prepare(
          "SELECT count(*) AS active_participants FROM participants p JOIN rooms r ON r.id=p.room_id" +
            " WHERE r.owner_id=(SELECT space_id FROM recovery_codes WHERE code_hash=?) AND p.is_owner=0 AND p.revoked=0 AND p.key_epoch=?",
        )
        .bind(hash, epoch),
    ]);
    return json({ space_id: updated.results[0].id, key, active_participants: active.results[0].active_participants });
  }

  const id = newId();
  const { codes, inserts } = await newRecoveryCodes(db, id, epoch, now);
  await db.batch([
    guard,
    requireSql(db, "signup_closed", dayCount + "<?", "estimated_writes", "all", day, SPACE_LIMITS.signup_stop_writes),
    requireSql(
      db,
      "rate_limited",
      "(SELECT count(*) FROM spaces WHERE created_ip_hash=? AND created_at>=?)<?",
      ipHash,
      day,
      SPACE_LIMITS.signups_per_ip_day,
    ),
    requireSql(
      db,
      "forbidden",
      "EXISTS(SELECT 1 FROM invite_codes WHERE code_hash=? AND expires_at>? AND used<max_uses)",
      hash,
      now,
    ),
    db.prepare("UPDATE invite_codes SET used=used+1 WHERE code_hash=?").bind(hash),
    db
      .prepare("INSERT INTO spaces(id,key_hash,key_epoch,created_at,created_ip_hash,last_seen_at) VALUES(?,?,?,?,?,?)")
      .bind(id, keyHash, epoch, now, ipHash, now),
    ...inserts,
    db.prepare(RAISE_FLOOR).bind(epoch),
  ]);
  return json({ space_id: id, key, recovery_codes: codes });
}
