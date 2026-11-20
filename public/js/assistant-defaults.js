export const DEFAULT_INTERVAL_MINUTES = 10;
export const INTERVAL_PRESETS = Object.freeze([1, 5, 10, 15, 30, 60]);
const header = Object.freeze({ delivery: "header", interval_minutes: DEFAULT_INTERVAL_MINUTES });
const address = Object.freeze({ delivery: "get", interval_minutes: 5 });

export const ASSISTANT_DEFAULTS = Object.freeze({
  vooy: Object.freeze({ delivery: "get", interval_minutes: 1 }),
  keyring: address,
  cue: address,
  muse: address,
  instinct: address,
  pickle: Object.freeze({ delivery: "header", interval_minutes: 5 }),
  claude: header,
  chatgpt: header,
  gemini: header,
  hark: Object.freeze({ delivery: "manual", interval_minutes: DEFAULT_INTERVAL_MINUTES }),
  other: header,
});

export function assistantDefault(aiType, remembered = {}) {
  const initial = Object.hasOwn(ASSISTANT_DEFAULTS, aiType) ? ASSISTANT_DEFAULTS[aiType] : header;
  return initial.delivery === "manual" ? initial : (remembered[aiType] ?? initial);
}
