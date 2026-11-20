// 공간 열쇠(ams_) 및 초대 참가자 열쇠(amk_) 보관소
// - #k= 조각을 읽는 즉시 history.replaceState로 주소창에서 제거
// - sessionStorage는 절대 쓰지 않음(기본은 클로저 메모리 전용)
// - 사용자가 명시적으로 '이 기기 기억'을 켰을 때만 localStorage에 저장

const LS_SPACE_KEY = "arsen.mailbox.v2.space_key";
const LS_SPACE_REMEMBER = "arsen.mailbox.v2.remember_space";
const LS_ROOM_PREFIX = "arsen.mailbox.v2.room_key.";

let memorySpaceKey = null;
const memoryRoomKeys = new Map();

function safeGetLS(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLS(key, val) {
  try {
    window.localStorage.setItem(key, val);
    return true;
  } catch {
    return false;
  }
}

function safeRemoveLS(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function isValidSpaceKey(val) {
  return typeof val === "string" && /^ams_[A-Za-z0-9_-]{16,80}$/.test(val.trim());
}

export function isValidParticipantKey(val) {
  return typeof val === "string" && /^amk_[A-Za-z0-9_-]{16,80}$/.test(val.trim());
}

/**
 * 주소창의 #k= 조각을 읽어 메모리에 넣고, 주소창에서는 즉시 조각(및 실수로 붙은 ?k=)을 지운다.
 */
export function consumeUrlFragmentKey(roomIdFromPath = null) {
  const { pathname, search, hash } = window.location;
  let extracted = null;

  if (hash && hash.length > 1) {
    const rawHash = hash.slice(1);
    const params = new URLSearchParams(rawHash);
    const k = params.get("k");
    if (k) {
      extracted = k.trim();
    }
  }

  // 주소창에 ?k= 또는 #k= 가 남아 있지 않도록 즉시 정리
  let cleanSearch = search;
  if (search) {
    const sp = new URLSearchParams(search);
    if (sp.has("k")) {
      sp.delete("k");
      const next = sp.toString();
      cleanSearch = next ? `?${next}` : "";
    }
  }

  if (extracted || hash.includes("k=") || cleanSearch !== search) {
    window.history.replaceState(null, "", pathname + cleanSearch);
  }

  if (extracted) {
    if (isValidSpaceKey(extracted)) {
      setSpaceKey(extracted);
      return { type: "space", captured: true };
    }
    if (roomIdFromPath && isValidParticipantKey(extracted)) {
      setRoomKey(roomIdFromPath, extracted);
      return { type: "participant", roomId: roomIdFromPath, captured: true };
    }
  }
  return { type: null, captured: false };
}

/** 사용자가 붙여넣은 전체 링크 또는 열쇠 문자열에서 열쇠만 추출 */
export function parsePastedKeyInput(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (isValidSpaceKey(trimmed)) return { type: "space", key: trimmed };
  if (isValidParticipantKey(trimmed)) return { type: "participant", key: trimmed };
  try {
    const u = new URL(trimmed, window.location.origin);
    const hp = new URLSearchParams(u.hash.replace(/^#/, ""));
    const hk = hp.get("k")?.trim() || "";
    const roomMatch = /^\/r\/([\w-]+)\/?$/.exec(u.pathname);
    if (isValidSpaceKey(hk)) return { type: "space", key: hk };
    if (isValidParticipantKey(hk)) {
      return { type: "participant", key: hk, roomId: roomMatch ? roomMatch[1] : null };
    }
  } catch {
    /* not a URL */
  }
  return null;
}

export function isSpaceRemembered() {
  return safeGetLS(LS_SPACE_REMEMBER) === "1";
}

export function getSpaceKey() {
  if (memorySpaceKey) return memorySpaceKey;
  if (isSpaceRemembered()) {
    const saved = safeGetLS(LS_SPACE_KEY);
    if (isValidSpaceKey(saved)) {
      memorySpaceKey = saved;
      return memorySpaceKey;
    }
  }
  return null;
}

export function setSpaceKey(key, rememberOption = null) {
  if (!isValidSpaceKey(key)) return false;
  memorySpaceKey = key.trim();
  const remember = rememberOption !== null ? Boolean(rememberOption) : isSpaceRemembered();
  if (remember) {
    safeSetLS(LS_SPACE_REMEMBER, "1");
    safeSetLS(LS_SPACE_KEY, memorySpaceKey);
  } else {
    safeRemoveLS(LS_SPACE_KEY);
    if (rememberOption === false) safeRemoveLS(LS_SPACE_REMEMBER);
  }
  return true;
}

export function setSpaceRemember(enable) {
  if (enable) {
    safeSetLS(LS_SPACE_REMEMBER, "1");
    if (memorySpaceKey) safeSetLS(LS_SPACE_KEY, memorySpaceKey);
  } else {
    safeRemoveLS(LS_SPACE_REMEMBER);
    safeRemoveLS(LS_SPACE_KEY);
  }
}

export function clearSpaceKey() {
  memorySpaceKey = null;
  safeRemoveLS(LS_SPACE_KEY);
  safeRemoveLS(LS_SPACE_REMEMBER);
}

export function isRoomRemembered(roomId) {
  if (!roomId) return false;
  return isValidParticipantKey(safeGetLS(LS_ROOM_PREFIX + roomId));
}

export function getRoomKey(roomId) {
  if (!roomId) return null;
  if (memoryRoomKeys.has(roomId)) return memoryRoomKeys.get(roomId);
  const saved = safeGetLS(LS_ROOM_PREFIX + roomId);
  if (isValidParticipantKey(saved)) {
    memoryRoomKeys.set(roomId, saved);
    return saved;
  }
  return null;
}

export function setRoomKey(roomId, key, rememberOption = null) {
  if (!roomId || !isValidParticipantKey(key)) return false;
  const trimmed = key.trim();
  memoryRoomKeys.set(roomId, trimmed);
  const remember = rememberOption !== null ? Boolean(rememberOption) : isRoomRemembered(roomId);
  if (remember) {
    safeSetLS(LS_ROOM_PREFIX + roomId, trimmed);
  } else if (rememberOption === false) {
    safeRemoveLS(LS_ROOM_PREFIX + roomId);
  }
  return true;
}

export function setRoomRemember(roomId, enable) {
  if (!roomId) return;
  if (enable) {
    const k = memoryRoomKeys.get(roomId);
    if (k) safeSetLS(LS_ROOM_PREFIX + roomId, k);
  } else {
    safeRemoveLS(LS_ROOM_PREFIX + roomId);
  }
}

export function clearRoomKey(roomId) {
  if (!roomId) return;
  memoryRoomKeys.delete(roomId);
  safeRemoveLS(LS_ROOM_PREFIX + roomId);
}

// 자주 쓰는 비서 정렬용 비민감 종류 빈도 카운터(열쇠·이름·대화 원문 저장 0건)
const LS_KIND_USAGE = "arsen.mailbox.v2.kind_usage";
const ALLOWED_USAGE_KINDS = new Set([
  "claude",
  "chatgpt",
  "gemini",
  "pickle",
  "hark",
  "vooy",
  "cue",
  "keyring",
  "muse",
  "instinct",
  "other",
]);
let memoryKindUsage = null;

export function getKindUsageCounts() {
  if (memoryKindUsage) return { ...memoryKindUsage };
  const raw = safeGetLS(LS_KIND_USAGE);
  const parsed = {};
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          const n = Number(v);
          if (ALLOWED_USAGE_KINDS.has(k) && Number.isFinite(n) && n > 0) {
            parsed[k] = Math.min(9999, Math.floor(n));
          }
        }
      }
    } catch {
      /* ignore malformed */
    }
  }
  memoryKindUsage = parsed;
  return { ...memoryKindUsage };
}

export function recordKindUsage(aiType) {
  const key = String(aiType || "").trim().toLowerCase();
  if (!ALLOWED_USAGE_KINDS.has(key)) return;
  const counts = getKindUsageCounts();
  counts[key] = Math.min(9999, (counts[key] || 0) + 1);
  memoryKindUsage = counts;
  safeSetLS(LS_KIND_USAGE, JSON.stringify(counts));
}
