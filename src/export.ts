import { Refused, SENSITIVE } from "./policy";

type ExportRow = {
  id: number;
  created_at: number;
  sender: string;
  body: string;
  relayed_for: string | null;
  reply_to: number | null;
  response_seconds: number | null;
};

const PAGE_SIZE = 50;
const timestamp = (seconds: number) => new Date(seconds * 1000).toISOString();
const redact = (value: string) => SENSITIVE.test(value) ? "[민감 의심 내용 제외]" : value;

function csvCell(value: string | number | null) {
  let text = typeof value === "string" ? redact(value) : value === null ? "" : String(value);
  // CSV quotes do not stop spreadsheets from evaluating a formula.
  if (/^(?:[\t\r\n]|\s*[=+\-@＝＋－＠])/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function formatRows(rows: ExportRow[], format: "md" | "csv" | "txt" | "json", first: boolean) {
  if (format === "json") return rows.map((r) => JSON.stringify({
    id: r.id, created_at_utc: timestamp(r.created_at), sender: redact(r.sender),
    relayed: Boolean(r.relayed_for), reply_to: r.reply_to, response_seconds: r.response_seconds,
    text: redact(r.body),
  })).join(",\n");
  if (format === "csv") {
    const cols = ["id", "created_at_utc", "sender", "relayed", "reply_to", "response_seconds", "text"];
    return [
      ...(first ? [cols.join(",")] : []),
      ...rows.map((r) =>
        [r.id, timestamp(r.created_at), r.sender, r.relayed_for ? "yes" : "no", r.reply_to, r.response_seconds, r.body]
          .map(csvCell).join(",")),
    ].map((line) => line + "\r\n").join("");
  }
  if (format === "txt") {
    return rows.map((r) => [
      `[${timestamp(r.created_at)}] #${r.id} ${redact(r.sender)}${r.relayed_for ? " (사용자가 대신 올림)" : ""}`,
      ...(r.reply_to === null ? [] : [`답장: #${r.reply_to}`]),
      ...(r.response_seconds === null ? [] : [`응답 소요: ${r.response_seconds}초`]),
      redact(r.body),
      "",
    ].join("\n") + "\n").join("");
  }
  return (first ? "# 우편함 대화 (UTC)\n\n" : "") + rows.map((r) => {
    const meta = [`보낸 사람: ${redact(r.sender)}`, `글 번호: ${r.id}`];
    if (r.relayed_for) meta.push("사용자가 대신 올림");
    if (r.reply_to !== null) meta.push(`답장: #${r.reply_to}`);
    if (r.response_seconds !== null) meta.push(`응답 소요: ${r.response_seconds}초`);
    return `## ${timestamp(r.created_at)}\n\n` +
      [meta.join(" · "), ...redact(r.body).split(/\r?\n/)].map((line) => "    " + line + "\n").join("") + "\n";
  }).join("");
}

export async function exportPage(
  db: D1Database, guards: D1PreparedStatement[], room: string, url: URL, cutoff: number, since: number, policy: string,
) {
  const format = url.searchParams.get("format");
  if (format !== "md" && format !== "csv" && format !== "txt" && format !== "json") throw new Refused("invalid");
  const rawUntil = url.searchParams.get("until");
  if (rawUntil !== null && !/^\d{1,15}$/.test(rawUntil)) throw new Refused("invalid");
  if (rawUntil !== null && url.searchParams.get("policy") !== policy) throw new Refused("policy_changed");
  const until = rawUntil === null ? null : Number(rawUntil);
  const scope = "SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=?1 AND created_at>?2";
  const snapshotIndex = guards.length;
  const results = await db.batch([
    ...guards,
    db.prepare("SELECT COALESCE(?3,(" + scope + ")) AS last_id").bind(room, cutoff, until),
    db.prepare(
      "SELECT m.id,m.created_at,COALESCE(a.name,p.name) AS sender,m.body,m.relayed_for,m.reply_to," +
        " CASE WHEN q.id IS NOT NULL THEN m.created_at-q.created_at END AS response_seconds" +
        " FROM messages m JOIN participants p ON p.id=m.participant_id" +
        " LEFT JOIN participants a ON a.id=m.relayed_for LEFT JOIN question_targets t ON t.reply_id=m.id" +
        " LEFT JOIN messages q ON q.id=t.question_id AND q.room_id=m.room_id AND q.created_at>?2" +
        " WHERE m.room_id=?1 AND m.created_at>?2 AND m.id>?4 AND m.id<=COALESCE(?3,(" + scope + "))" +
        " ORDER BY m.id LIMIT ?5",
    ).bind(room, cutoff, until, since, PAGE_SIZE + 1),
  ]);
  const lastId = (results[snapshotIndex].results[0] as { last_id: number }).last_id;
  const rows = results[snapshotIndex + 1].results as ExportRow[];
  const page = rows.slice(0, PAGE_SIZE);
  return {
    chunk: formatRows(page, format, since === 0),
    next: page.at(-1)?.id ?? since, until: lastId, more: rows.length > PAGE_SIZE, policy,
  };
}
