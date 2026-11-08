export type SdkEvent =
  | { type: "turn.started"; sessionId: string; turnId: string }
  | { type: "message.delta"; sessionId: string; turnId: string; text: string }
  | { type: "tool.started"; sessionId: string; turnId: string; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool.finished"; sessionId: string; turnId: string; callId: string; name: string; result: Record<string, unknown> }
  | { type: "user.requested"; sessionId: string; turnId: string; callId: string; question: string }
  | { type: "turn.completed"; sessionId: string; turnId: string; status: string; text: string };

export type AgentRunResult = {
  text: string;
  sessionId: string;
  status: string;
  exitCode: 0 | 1 | 3 | 4 | 5;
};

const exitByStatus: Record<string, AgentRunResult["exitCode"]> = {
  completed: 0,
  failed: 1,
  waiting_user: 3,
  budget_exhausted: 4,
  cancelled: 5,
};

export function exitCodeFor(status: string): AgentRunResult["exitCode"] {
  return exitByStatus[status] ?? 1;
}

export function sdkEventsFor(event: {
  type: string;
  sessionId: string;
  turnId: string;
  payload: unknown;
}): SdkEvent[] {
  const payload = record(event.payload);
  const ids = { sessionId: event.sessionId, turnId: event.turnId };
  if (event.type === "turn.started") {
    return [{ type: "turn.started", ...ids }];
  }
  if (event.type === "tool.started") {
    return [{
      type: "tool.started",
      ...ids,
      callId: text(payload.callId),
      name: text(payload.name),
      arguments: record(payload.arguments),
    }];
  }
  if (event.type === "tool.finished") {
    return [{
      type: "tool.finished",
      ...ids,
      callId: text(payload.callId),
      name: text(payload.name),
      result: record(payload.result),
    }];
  }
  if (event.type === "user.requested") {
    return [{ type: "user.requested", ...ids, callId: text(payload.callId), question: text(payload.question) }];
  }
  if (event.type === "turn.completed") {
    const body = text(payload.text);
    const completed: SdkEvent = { type: "turn.completed", ...ids, status: text(payload.status), text: body };
    if (body === "") {
      return [completed];
    }
    return [{ type: "message.delta", ...ids, text: body }, completed];
  }
  return [];
}

function record(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
