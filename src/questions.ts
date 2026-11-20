import { Refused, SENSITIVE } from "./policy";

type Member = { id: string; name: string; ai_type: string | null };
export type QuestionTarget = { id: string; step: number | null; direct: boolean };
const ALL_ADDRESSES = new Set(["전체", "다들", "모두", "전원"]);

const TYPE_NAMES: Record<string, string[]> = {
  claude: ["클로드"],
  chatgpt: ["챗GPT"],
  gemini: ["제미나이"],
  pickle: ["피클"],
  vooy: ["부이", "브이"],
  hark: ["하크"],
  cue: ["큐"],
  keyring: ["키링"],
  instinct: ["인스팅트"],
  muse: ["뮤즈"],
};

const normalize = (s: string) => s.normalize("NFC").toLowerCase();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function addName(index: Map<string, Member[]>, label: string, member: Member) {
  if (!label) return;
  const k = normalize(label);
  const existing = index.get(k) ?? [];
  if (!existing.some((candidate) => candidate.id === member.id)) index.set(k, [...existing, member]);
}

/** Leading addresses own the clause, so "부이, 피클 답을 비교" does not ask Pickle again. */
export function routeQuestion(text: string, members: Member[]): QuestionTarget[] {
  if (!members.length) return [];
  const names = new Map<string, Member[]>();
  const aliases = new Map<string, Member[]>();
  for (const member of members) {
    addName(names, member.name, member);
    addName(aliases, member.name.replace(/[0-9]+$/, "").trim(), member);
    if (member.ai_type) {
      for (const label of [member.ai_type, ...(TYPE_NAMES[member.ai_type] ?? [])]) addName(aliases, label, member);
    }
  }
  const labels = [...new Set([...names.keys(), ...aliases.keys(), ...ALL_ADDRESSES])]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const token = `@?(${labels.join("|")})(님(?:에게|한테|께)?|에게|한테|께|아|야|이랑|하고|와|과|랑|도)?(?![\\p{L}\\p{N}_])`;
  const prefix = new RegExp(`^\\s*${token}`, "iu");
  const first = prefix.exec(text);
  let terms: string[] = [];
  let ordered = false;
  if (first) {
    terms = [first[1]];
    let particle = first[2];
    let rest = text.slice(first[0].length);
    while (rest) {
      const separator = /^\s*(→|->|[,，])\s*/u.exec(rest);
      const remaining = separator ? rest.slice(separator[0].length) : rest;
      const next = prefix.exec(remaining);
      if (!next || (!separator && !rest.trimStart().startsWith("@") && !/^(?:이랑|하고|와|과|랑)$/u.test(particle ?? ""))) {
        if (separator && /→|->/.test(separator[1])) throw new Refused("question_ambiguous");
        break;
      }
      const following = remaining.slice(next[0].length);
      const arrow = Boolean(separator && /→|->/.test(separator[1]));
      // A bare name after a comma may be referenced prose. A delimiter or explicit @ ends the address.
      if (separator && !arrow && !remaining.trimStart().startsWith("@") && following.trim() &&
          !/^\s*(?:[,，:：]|→|->)/u.test(following) &&
          !/^(?:이랑|하고|와|과|랑)$/u.test(next[2] ?? "")) break;
      ordered ||= arrow;
      terms.push(next[1]);
      particle = next[2];
      rest = following;
    }
  } else {
    if (/^\s*@/u.test(text)) throw new Refused("question_ambiguous");
    const matches = text.matchAll(new RegExp(`(?:^|[^\\p{L}\\p{N}_])${token}`, "giu"));
    terms = [...matches].filter((match) => !ALL_ADDRESSES.has(normalize(match[1])) || match[0].includes("@"))
      .map((match) => match[1]);
  }
  if (terms.some((term) => ALL_ADDRESSES.has(normalize(term)))) {
    if (ordered) throw new Refused("question_ambiguous");
    return members.map(({ id }) => ({ id, step: null, direct: false }));
  }
  const ids = new Set<string>();
  for (const term of terms) {
    const k = normalize(term);
    const exact = names.get(k);
    const group = exact?.find((m) => m.name === term);
    const candidates = group ? [group] : (exact ?? aliases.get(k) ?? []);
    if (candidates.length > 1) throw new Refused("question_ambiguous");
    if (candidates.length) ids.add(candidates[0].id);
  }
  return [...ids].map((id, i) => ({
    id,
    direct: true,
    step: ordered && ids.size > 1 ? i + 1 : null,
  }));
}

export type QuestionState = {
  question_id: number;
  participant_id: string;
  participant_name: string;
  step: number | null;
  asked_at: number;
  reply_id: number | null;
  answered_at: number | null;
  awaiting_previous: number;
  direct: number;
};

export type RelayTurn = {
  question_id: number;
  preceding_reply_id: number;
  question: string;
  preceding_reply: string;
};

export function questionStates(db: D1Database, roomId: string, messageIds: number[], cutoff: number) {
  return db.prepare(
    "WITH affected AS (SELECT * FROM question_targets WHERE question_id IN (SELECT value FROM json_each(?1))" +
      " UNION SELECT * FROM question_targets WHERE reply_id IN (SELECT value FROM json_each(?1)))" +
      " SELECT t.question_id,t.participant_id,p.name AS participant_name,t.step,q.created_at AS asked_at," +
      " a.id AS reply_id,a.created_at AS answered_at,EXISTS(SELECT 1 FROM question_targets prior" +
      " WHERE prior.question_id=t.question_id AND prior.step<t.step AND prior.reply_id IS NULL) AS awaiting_previous," +
      " EXISTS(SELECT 1 FROM json_each(q.question_route) route WHERE json_extract(route.value,'$.id')=t.participant_id" +
      " AND json_extract(route.value,'$.direct')=1) AS direct" +
      " FROM affected t JOIN messages q ON q.id=t.question_id JOIN participants p ON p.id=t.participant_id" +
      " LEFT JOIN messages a ON a.id=t.reply_id AND a.room_id=q.room_id AND a.created_at>?3" +
      " WHERE q.room_id=?2 AND q.created_at>?3 ORDER BY t.question_id,t.step,p.created_at,p.rowid",
  ).bind(JSON.stringify(messageIds), roomId, cutoff);
}

export function relayTurns(db: D1Database, roomId: string, participantId: string, cutoff: number) {
  return db.prepare(
    "SELECT q.id AS question_id,a.id AS preceding_reply_id,q.body AS question,a.body AS preceding_reply" +
      " FROM question_targets t JOIN messages q ON q.id=t.question_id" +
      " JOIN question_targets prior ON prior.question_id=t.question_id AND prior.step=t.step-1" +
      " JOIN messages a ON a.id=prior.reply_id AND a.room_id=q.room_id" +
      " WHERE t.participant_id=?1 AND t.reply_id IS NULL AND t.step>1 AND q.room_id=?2" +
      " AND q.created_at>?3 AND a.created_at>?3 ORDER BY q.id LIMIT 20",
  ).bind(participantId, roomId, cutoff);
}

export function safeExcerpt(text: string, limit = 800): string {
  return SENSITIVE.test(text) ? "[민감 의심 내용 제외]" : [...text].slice(0, limit).join("");
}
