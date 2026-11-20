import { SPACE_LIMITS } from "./brand";

export const dayStart = () => Math.floor(Date.now() / 86_400_000) * 86400;
export const dayCount =
  "(SELECT COALESCE(MAX(count),0) FROM rate_hits WHERE bucket=? AND subject=? AND window_start=?)";

// An admission estimate, including the meter itself and indices. Bulk deletes depend on the room history.
export function countRequest(db: D1Database, path: string, method: string) {
  let writes = method === "GET" ? 8 : 16;
  if (path === "/api/spaces") writes = 32;
  if (path === "/api/me/recovery-codes" && method === "POST") writes = 64;
  if (method === "DELETE" || path.endsWith("/revoke-all")) writes = 256;
  return db
    .prepare(
      "INSERT INTO rate_hits(bucket,subject,window_start,count) VALUES('estimated_writes','all',?,?)" +
        " ON CONFLICT(bucket,subject,window_start) DO UPDATE SET count=min(?,count+excluded.count) WHERE count<?",
    )
    .bind(dayStart(), writes, SPACE_LIMITS.signup_stop_writes, SPACE_LIMITS.signup_stop_writes)
    .run();
}
