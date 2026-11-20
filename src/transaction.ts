import { Refused } from "./policy";

type Failure = "forbidden" | "quota" | "not_found" | "signup_closed" | "key_epoch_invalid" | "rate_limited";
export function requireSql(db: D1Database, code: Failure, condition: string, ...values: (string | number | null)[]) {
  return db.prepare(`INSERT INTO v2_assertion(failure) SELECT '${code}' WHERE NOT (${condition})`).bind(...values);
}

export function refusal(e: unknown): Refused | undefined {
  if (e instanceof Refused) return e;
  const code =
    /CHECK constraint failed: v2_(forbidden|quota|not_found|signup_closed|key_epoch_invalid|rate_limited|policy_changed)/.exec(
      String(e),
    )?.[1];
  if (code) return new Refused(code);
  if (String(e).includes("UNIQUE constraint failed: participants.room_id, participants.name"))
    return new Refused("name_taken");
}
