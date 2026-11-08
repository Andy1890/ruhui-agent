import { parseBudget, type Budget, type Consumed } from "./budget.js";
import { fail, ok, type Result } from "./result.js";
import { sessionIdPattern, turnIdPattern } from "./schema-version.js";

export const phase0Modes = ["plan", "workspace-write"] as const;
export type Phase0Mode = (typeof phase0Modes)[number];

export const turnStatuses = [
  "running",
  "waiting_user",
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
] as const;
export type TurnStatus = (typeof turnStatuses)[number];

export type UserInput = { text: string };

export type Turn = {
  id: string;
  sessionId: string;
  input: UserInput;
  status: TurnStatus;
  mode: Phase0Mode;
  budget: Budget;
  consumed: Consumed;
};

export type TurnInput = {
  id: string;
  sessionId: string;
  input: UserInput;
  mode: string;
  budget: Budget;
  status?: string;
};

export function parseMode(value: unknown): Result<Phase0Mode> {
  if (value === "plan" || value === "workspace-write") {
    return ok(value);
  }
  return fail("mode");
}

export function createTurn(input: TurnInput): Result<Turn> {
  if (!turnIdPattern.test(input.id)) {
    return fail("turn-id");
  }
  if (!sessionIdPattern.test(input.sessionId)) {
    return fail("session-id");
  }
  if (typeof input.input?.text !== "string" || input.input.text.trim() === "") {
    return fail("input");
  }
  const mode = parseMode(input.mode);
  if (!mode.ok) {
    return mode;
  }
  const budget = parseBudget(input.budget);
  if (!budget.ok) {
    return budget;
  }
  const status = input.status ?? "running";
  if (!(turnStatuses as readonly string[]).includes(status)) {
    return fail("turn-status");
  }
  return ok({
    id: input.id,
    sessionId: input.sessionId,
    input: { text: input.input.text },
    status: status as TurnStatus,
    mode: mode.value,
    budget: budget.value,
    consumed: {},
  });
}
