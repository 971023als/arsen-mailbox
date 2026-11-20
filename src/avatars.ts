import { Refused } from "./policy";

export const AVATAR_PRESETS = ["chatgpt", "claude", "cue", "gemini", "hark", "instinct", "keyring", "muse", "pickle", "vooy"];
const MAX_AVATAR_BYTES = 8_192;
const EDGE = 96;

/** A static, square WebP thumbnail. No extended, animation or metadata chunks. */
function thumbnail(input: unknown) {
  if (typeof input !== "string" || input.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input)) throw new Refused("invalid");
  let binary: string;
  try { binary = atob(input); } catch { throw new Refused("invalid"); }
  if (binary.length < 25 || binary.length > MAX_AVATAR_BYTES || btoa(binary) !== input)
    throw new Refused("invalid");
  const view = new DataView(Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer);
  const size = view.getUint32(16, true);
  if (binary.slice(0, 4) !== "RIFF" || binary.slice(8, 12) !== "WEBP" ||
      view.getUint32(4, true) !== binary.length - 8 || 20 + size + (size % 2) !== binary.length ||
      (size % 2 && view.getUint8(binary.length - 1) !== 0))
    throw new Refused("invalid");
  let width = 0, height = 0;
  if (binary.slice(12, 16) === "VP8 " && size > 10 &&
      !(view.getUint8(20) & 1) && (view.getUint32(23, false) >>> 8) === 0x9d012a) {
    width = view.getUint16(26, true) & 0x3fff;
    height = view.getUint16(28, true) & 0x3fff;
  } else if (binary.slice(12, 16) === "VP8L" && size > 5 && view.getUint8(20) === 0x2f) {
    const dimensions = view.getUint32(21, true);
    if (dimensions >>> 29) throw new Refused("invalid");
    width = (dimensions & 0x3fff) + 1;
    height = ((dimensions >>> 14) & 0x3fff) + 1;
  }
  if (width !== EDGE || height !== EDGE) throw new Refused("invalid");
  return input;
}

export function avatarFields(body: Record<string, unknown>, revision: string) {
  if (body.avatar_preset === undefined && body.avatar_webp === undefined) return [];
  let preset = null, image = null;
  if (typeof body.avatar_preset === "string" && AVATAR_PRESETS.includes(body.avatar_preset) && body.avatar_webp === undefined) {
    preset = body.avatar_preset;
  } else if (body.avatar_webp !== undefined && body.avatar_preset === undefined) {
    image = thumbnail(body.avatar_webp);
  } else if (body.avatar_preset !== null || body.avatar_webp !== undefined) {
    throw new Refused("invalid");
  }
  return [["avatar_preset", preset], ["avatar_rev", image ? revision : null], ["avatar_webp", image]] as const;
}

export async function readAvatars(db: D1Database, guards: D1PreparedStatement[], room: string, url: URL) {
  const versions = (url.searchParams.get("versions") ?? "").split(",");
  if (!versions.length || versions.length > 50 || versions.some((v) => !/^[A-Za-z0-9_-]{12}$/.test(v)))
    throw new Refused("invalid");
  const result = await db.batch([
    ...guards,
    db.prepare("SELECT avatar_rev AS revision,avatar_webp AS webp FROM participants" +
      " WHERE room_id=? AND revoked=0 AND avatar_rev IN(SELECT value FROM json_each(?))").bind(room, JSON.stringify(versions)),
  ]);
  return { avatars: result.at(-1)!.results };
}
