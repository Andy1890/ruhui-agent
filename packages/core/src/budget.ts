import { fail, ok, type Result } from "./result.js";

export type Budget = {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  wallClockMs?: number;
};

export type Consumed = {
  modelCalls?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  wallClockMs?: number;
};

const limitKeys = [
  ["maxModelCalls", "modelCalls"],
  ["maxToolCalls", "toolCalls"],
  ["maxInputTokens", "inputTokens"],
  ["maxOutputTokens", "outputTokens"],
  ["wallClockMs", "wallClockMs"],
] as const;

function count(value: unknown): Result<number | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fail("budget");
  }
  return ok(value);
}

export function parseBudget(value: unknown): Result<Budget> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("budget");
  }
  const source = value as Record<string, unknown>;
  const budget: Budget = {};
  for (const [limitKey] of limitKeys) {
    const parsed = count(source[limitKey]);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.value !== undefined) {
      budget[limitKey] = parsed.value;
    }
  }
  return ok(budget);
}

export function parseConsumed(value: unknown): Result<Consumed> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("budget");
  }
  const source = value as Record<string, unknown>;
  const consumed: Consumed = {};
  for (const [, usedKey] of limitKeys) {
    const parsed = count(source[usedKey]);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.value !== undefined) {
      consumed[usedKey] = parsed.value;
    }
  }
  return ok(consumed);
}

export function budgetReached(limit: Budget, consumed: Consumed): boolean {
  for (const [limitKey, usedKey] of limitKeys) {
    const cap = limit[limitKey];
    if (cap !== undefined && (consumed[usedKey] ?? 0) >= cap) {
      return true;
    }
  }
  return false;
}
