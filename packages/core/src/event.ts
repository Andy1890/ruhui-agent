import { parseBudget, parseConsumed, type Budget, type Consumed } from "./budget.js";
import { fail, ok, type Result } from "./result.js";
import { callIdPattern, schemaVersion, sessionIdPattern, turnIdPattern, utcTimePattern } from "./schema-version.js";
import { parseMode, type Phase0Mode, type UserInput } from "./turn.js";
import { isToolName, parseToolResult, type ToolResult } from "./tool-result.js";

export const rolloutEventTypes = [
  "turn.started",
  "tool.started",
  "tool.finished",
  "user.requested",
  "turn.completed",
] as const;
export type RolloutEventType = (typeof rolloutEventTypes)[number];

export const completedStatuses = ["completed", "failed", "cancelled", "budget_exhausted"] as const;
export type CompletedStatus = (typeof completedStatuses)[number];

export type TurnStartedPayload = {
  input: UserInput;
  mode: Phase0Mode;
  budget: Budget;
};

export type ToolStartedPayload = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolFinishedPayload = {
  callId: string;
  name: string;
  policy: { decision: "allow" | "deny" };
  result: ToolResult;
};

export type UserRequestedPayload = {
  callId: string;
  question: string;
};

export type TurnCompletedPayload = {
  status: CompletedStatus;
  text: string;
  consumed: Consumed;
};

export type RolloutPayload =
  | TurnStartedPayload
  | ToolStartedPayload
  | ToolFinishedPayload
  | UserRequestedPayload
  | TurnCompletedPayload;

export type RolloutEvent = {
  schemaVersion: typeof schemaVersion;
  seq: number;
  time: string;
  sessionId: string;
  turnId: string;
  type: RolloutEventType;
  payload: RolloutPayload;
};

function record(value: unknown): Result<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("event");
  }
  return ok(value as Record<string, unknown>);
}

function parsePayload(type: RolloutEventType, value: unknown): Result<RolloutPayload> {
  const body = record(value);
  if (!body.ok) {
    return body;
  }
  const payload = body.value;
  if (type === "turn.started") {
    const input = record(payload.input);
    if (!input.ok || typeof input.value.text !== "string") {
      return fail("input");
    }
    const mode = parseMode(payload.mode);
    if (!mode.ok) {
      return mode;
    }
    const budget = parseBudget(payload.budget);
    if (!budget.ok) {
      return budget;
    }
    return ok({ input: { text: input.value.text }, mode: mode.value, budget: budget.value });
  }
  if (type === "tool.started" || type === "tool.finished" || type === "user.requested") {
    if (typeof payload.callId !== "string" || !callIdPattern.test(payload.callId)) {
      return fail("call-id");
    }
  }
  if (type === "tool.started") {
    if (typeof payload.name !== "string" || !isToolName(payload.name)) {
      return fail("tool-name");
    }
    const args = record(payload.arguments);
    if (!args.ok) {
      return fail("arguments");
    }
    return ok({ callId: payload.callId as string, name: payload.name, arguments: args.value });
  }
  if (type === "tool.finished") {
    if (typeof payload.name !== "string" || !isToolName(payload.name)) {
      return fail("tool-name");
    }
    const policy = record(payload.policy);
    if (!policy.ok || (policy.value.decision !== "allow" && policy.value.decision !== "deny")) {
      return fail("policy");
    }
    const result = parseToolResult(payload.result);
    if (!result.ok) {
      return result;
    }
    if (policy.value.decision === "deny" && result.value.status !== "denied") {
      return fail("policy");
    }
    return ok({
      callId: payload.callId as string,
      name: payload.name,
      policy: { decision: policy.value.decision },
      result: result.value,
    });
  }
  if (type === "user.requested") {
    if (typeof payload.question !== "string" || payload.question.trim() === "") {
      return fail("question");
    }
    return ok({ callId: payload.callId as string, question: payload.question });
  }
  if (typeof payload.status !== "string" || !completedStatuses.includes(payload.status as CompletedStatus)) {
    return fail("turn-status");
  }
  if (typeof payload.text !== "string") {
    return fail("input");
  }
  const consumed = parseConsumed(payload.consumed);
  if (!consumed.ok) {
    return consumed;
  }
  return ok({ status: payload.status as CompletedStatus, text: payload.text, consumed: consumed.value });
}

export function parseRolloutEvent(value: unknown): Result<RolloutEvent> {
  const body = record(value);
  if (!body.ok) {
    return body;
  }
  const event = body.value;
  if (event.schemaVersion !== schemaVersion) {
    return fail("schema-version");
  }
  if (typeof event.seq !== "number" || !Number.isInteger(event.seq) || event.seq < 1) {
    return fail("seq");
  }
  if (typeof event.time !== "string" || !utcTimePattern.test(event.time)) {
    return fail("time");
  }
  if (typeof event.sessionId !== "string" || !sessionIdPattern.test(event.sessionId)) {
    return fail("session-id");
  }
  if (typeof event.turnId !== "string" || !turnIdPattern.test(event.turnId)) {
    return fail("turn-id");
  }
  if (typeof event.type !== "string" || !rolloutEventTypes.includes(event.type as RolloutEventType)) {
    return fail("event-type");
  }
  const payload = parsePayload(event.type as RolloutEventType, event.payload);
  if (!payload.ok) {
    return payload;
  }
  return ok({
    schemaVersion,
    seq: event.seq,
    time: event.time,
    sessionId: event.sessionId,
    turnId: event.turnId,
    type: event.type as RolloutEventType,
    payload: payload.value,
  });
}
