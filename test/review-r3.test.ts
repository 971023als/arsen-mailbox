// Regression tests for the r2 re-review (MAILBOX_SECURITY_REVIEW.md "r2: REVISE", remaining P1-3).
// 1) a missing, invalid or lowered KEY_EPOCH refuses issuing and authenticating (fail closed), revoke keeps working;
// 2) the restore procedure runs end to end with the public address closed, using the shipped SQL scripts.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/app";

const BASE = "https://mailbox.example.test";
const UA = { "user-agent": "test-assistant/1.0" };
const JSON_TYPE = { "content-type": "application/json" };
const enc = encodeURIComponent;
type Env = typeof env;

const call = (e: Env, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  worker.fetch(new Request(BASE + path, { ...init, headers: { ...UA, ...(init.headers ?? {}) } }), e);
const owner = () => ({ authorization: `Bearer ${env.TEST_OWNER_KEY}`, ...JSON_TYPE });
const withEpoch = (epoch: string | undefined) => ({ ...env, KEY_EPOCH: epoch }) as Env;

async function room(e: Env): Promise<string> {
  const r = await call(e, "/admin/rooms", { method: "POST", headers: owner(), body: '{"name":"복원방"}' });
  expect(r.status).toBe(200);
  return ((await r.json()) as { room_id: string }).room_id;
}
const add = (e: Env, roomId: string, name: string) =>
  call(e, `/admin/rooms/${roomId}/participants`, {
    method: "POST",
    headers: owner(),
    body: JSON.stringify({ name, kind: "assistant" }),
  });
const admin = (e: Env, roomId: string, pid: string, action: "reissue" | "revoke") =>
  call(e, `/admin/rooms/${roomId}/participants/${pid}/${action}`, { method: "POST", headers: owner() });
const read = (e: Env, roomId: string, key: string) => call(e, `/r/${roomId}/read?k=${enc(key)}`);
const post = (e: Env, roomId: string, key: string, text: string) =>
  call(e, `/r/${roomId}/send`, {
    method: "POST",
    headers: { "x-mailbox-key": key, ...JSON_TYPE },
    body: JSON.stringify({ text }),
  });
const count = async (sql: string, ...args: unknown[]) =>
  ((await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? -1) as number;

/** Runs a shipped SQL file the way `wrangler d1 execute --file` does: statement by statement. */
async function runScript(name: string): Promise<Record<string, unknown>[]> {
  const files = import.meta.glob("../scripts/*.sql", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >;
  const text = files[`../scripts/${name}`];
  expect(text, `scripts/${name} exists`).toBeTypeOf("string");
  const statements = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  let last: Record<string, unknown>[] = [];
  for (const sql of statements) last = (await env.DB.prepare(sql).all()).results as Record<string, unknown>[];
  return last;
}

const resetMeta = () => env.DB.exec("DELETE FROM mailbox_meta").catch(() => undefined);

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_hits");
  await resetMeta();
});
afterEach(resetMeta);

describe("r3-1 KEY_EPOCH fails closed", () => {
  for (const [label, epoch] of [
    ["invalid", "abc"],
    ["negative", "-1"],
    ["missing", undefined],
    ["closed", "closed"],
  ] as const) {
    it(`${label}: no new credential, no read or write with existing ones, revoke still works`, async () => {
      const roomId = await room(env);
      const ok = (await (await add(env, roomId, "부이1")).json()) as { participant_id: string; key: string };
      const bad = withEpoch(epoch);
      const before = await count("SELECT COUNT(*) AS n FROM participants WHERE room_id = ?", roomId);

      const issued = await add(bad, roomId, "부이2");
      expect(issued.status).toBe(503);
      expect(await issued.json()).toEqual({ error: "key_epoch_invalid" });
      expect((await admin(bad, roomId, ok.participant_id, "reissue")).status).toBe(503);
      expect(await count("SELECT COUNT(*) AS n FROM participants WHERE room_id = ?", roomId)).toBe(before);

      const r = await read(bad, roomId, ok.key);
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("key_epoch_invalid");
      expect((await post(bad, roomId, ok.key, "설정 오류 중 쓰기")).status).toBe(503);
      expect(await count("SELECT COUNT(*) AS n FROM messages WHERE room_id = ?", roomId)).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM send_tickets WHERE participant_id = ?", ok.participant_id)).toBe(0);

      const health = await call(bad, "/healthz");
      expect(health.status).toBe(503);
      expect(await health.text()).toContain("KEY_EPOCH");

      // the valid configuration works again right away
      expect((await read(env, roomId, ok.key)).status).toBe(200);
      expect((await add(env, roomId, "부이2")).status).toBe(200);
      // revoking stays possible while the epoch is broken
      expect((await admin(bad, roomId, ok.participant_id, "revoke")).status).toBe(200);
      expect((await read(env, roomId, ok.key)).status).toBe(403);
    });
  }

  it("an epoch lower than one already used for issuing is refused (e.g. a Worker rollback)", async () => {
    const roomId = await room(env);
    const two = withEpoch("2");
    const p = (await (await add(two, roomId, "부이1")).json()) as { participant_id: string; key: string };
    expect((await read(two, roomId, p.key)).status).toBe(200);
    const lowered = withEpoch("1");
    expect((await read(lowered, roomId, p.key)).status).toBe(503);
    expect((await add(lowered, roomId, "부이2")).status).toBe(503);
    expect((await call(lowered, "/healthz")).status).toBe(503);
    expect((await read(two, roomId, p.key)).status).toBe(200);
  });
});

describe("r3-2 restore procedure with the public address closed", () => {
  it("restore -> after-restore.sql -> status check -> reopen with a new epoch -> reissue", async () => {
    const e0 = withEpoch("0");
    const roomId = await room(e0);
    const keep = (await (await add(e0, roomId, "부이1")).json()) as { participant_id: string; key: string };
    const gone = (await (await add(e0, roomId, "부이2")).json()) as { participant_id: string; key: string };
    await read(e0, roomId, keep.key); // leaves a send ticket behind
    const snapshot = await env.DB.prepare("SELECT id, key_hash, revoked FROM participants WHERE room_id = ?")
      .bind(roomId)
      .all<{ id: string; key_hash: string; revoked: number }>();
    expect((await admin(e0, roomId, gone.participant_id, "revoke")).status).toBe(200);

    // 1. close: deploy with KEY_EPOCH = "closed" -> every participant request is refused
    const closed = withEpoch("closed");
    expect((await read(closed, roomId, keep.key)).status).toBe(503);
    // 2. Time Travel restore brings back the old rows (incl. the revoked key)
    for (const row of snapshot.results) {
      await env.DB.prepare("UPDATE participants SET key_hash = ?, revoked = ? WHERE id = ?")
        .bind(row.key_hash, row.revoked, row.id)
        .run();
    }
    expect((await read(e0, roomId, gone.key)).status).toBe(200); // proof the restore revived the revoked key
    // 3. wrangler d1 execute --file scripts/after-restore.sql (no public address needed)
    await runScript("after-restore.sql");
    // 4. wrangler d1 execute --file scripts/restore-status.sql
    const [status] = await runScript("restore-status.sql");
    expect(status.active_participants).toBe(0);
    expect(status.send_tickets).toBe(0);
    expect(status.epoch_floor).toBe(0);
    // 5. reopen with KEY_EPOCH raised to floor + 1; every restored key is refused
    const e1 = withEpoch("1");
    expect((await read(e1, roomId, keep.key)).status).toBe(403);
    expect((await read(e1, roomId, gone.key)).status).toBe(403);
    expect((await read(e0, roomId, keep.key)).status).toBe(403); // revoked regardless of epoch
    // 6. the owner reissues only the participants confirmed as valid
    const fresh = (await (await admin(e1, roomId, keep.participant_id, "reissue")).json()) as { key: string };
    expect((await read(e1, roomId, fresh.key)).status).toBe(200);
    expect((await read(e1, roomId, gone.key)).status).toBe(403);
    // 7. a rollback that brings back the old epoch is refused instead of reviving anything
    expect((await read(withEpoch("0"), roomId, fresh.key)).status).toBe(503);
  });
});
