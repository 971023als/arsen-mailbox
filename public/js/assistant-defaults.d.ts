export type AssistantDefault = Readonly<{ delivery: "header" | "get" | "manual"; interval_minutes: number }>;
export const DEFAULT_INTERVAL_MINUTES: number;
export const INTERVAL_PRESETS: readonly number[];
export const ASSISTANT_DEFAULTS: Readonly<Record<string, AssistantDefault>>;
export function assistantDefault(aiType: string, remembered?: Record<string, AssistantDefault>): AssistantDefault;
