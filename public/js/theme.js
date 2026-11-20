// 밝게 · 어둡게 · 시스템 3모드 테마 제어기 (비민감 UI 설정만 localStorage 보관)

const THEME_STORAGE_KEY = "arsen.mailbox.v2.theme";
const VALID_MODES = ["system", "light", "dark"];

let currentMode = "system";
const listeners = new Set();

function readStoredMode() {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return VALID_MODES.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

function effectiveDark(mode) {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function syncMetaThemeColor(mode) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", effectiveDark(mode) ? "#15171A" : "#2F5D62");
  }
}

export function applyTheme(mode, persist = true) {
  const next = VALID_MODES.includes(mode) ? mode : "system";
  currentMode = next;
  const root = document.documentElement;
  if (next === "light" || next === "dark") {
    root.setAttribute("data-theme", next);
  } else {
    root.removeAttribute("data-theme");
  }
  syncMetaThemeColor(next);
  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }
  for (const fn of listeners) fn(next);
}

export function getThemeMode() {
  return currentMode;
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initTheme() {
  applyTheme(readStoredMode(), false);
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", () => {
      if (currentMode === "system") syncMetaThemeColor("system");
    });
  }
}
