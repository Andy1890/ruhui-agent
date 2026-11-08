import type { Consumed } from "./budget.js";
import type { RolloutEvent, RolloutEventType } from "./event.js";
import type { ModelEvent, ModelMessage, ModelProvider, ModelSignal } from "./model.js";
import { fail, type Result } from "./result.js";
import type { RolloutHandle } from "./rollout.js";
import { callIdPattern, toolNamePattern } from "./schema-version.js";
import { parseToolResult, type ToolResult } from "./tool-result.js";
import type { Turn, TurnStatus } from "./turn.js";

const defaultInstructions = "使用工具完成任务。不要伪造工具结果。";

export type LoopStop =
  | "final"
  | "budget"
  | "interrupted"
  | "repeated_failure"
  | "unparseable"
  | "tools_required"
  | "rollout_unwritable"
  | "waiting_user";

export type ToolCallRequest = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolExecutor = {
  execute(call: ToolCallRequest, signal: ModelSignal): Promise<ToolResult> | ToolResult;
};

export type LoopResult = {
  status: TurnStatus;
  exitCode: 0 | 1 | 3 | 4 | 5;
  text: string;
  stop: LoopStop;
  consumed: Consumed;
  sessionId: string;
  turnId: string;
};

type LimitHit = {
  label: string;
  used: number;
  cap: number;
};

type Inference =
  | { kind: "final"; text: string; usageSeen: boolean; inputTokens: number; outputTokens: number }
  | { kind: "tools"; calls: ToolCallRequest[]; text: string; usageSeen: boolean; inputTokens: number; outputTokens: number }
  | { kind: "malformed"; reason: string; usageSeen: boolean; inputTokens: number; outputTokens: number }
  | { kind: "aborted" }
  | { kind: "tools_required" };

const limitRows = [
  ["maxModelCalls", "modelCalls", "模型调用"],
  ["maxToolCalls", "toolCalls", "工具调用"],
  ["maxInputTokens", "inputTokens", "输入词元"],
  ["maxOutputTokens", "outputTokens", "输出词元"],
  ["wallClockMs", "wallClockMs", "墙钟毫秒"],
] as const;

export async function runLoop(input: {
  turn: Turn;
  provider: ModelProvider;
  tools: ToolExecutor;
  rollout: RolloutHandle;
  signal?: ModelSignal;
  now: () => string;
  clock?: () => number;
  instructions?: string;
}): Promise<LoopResult> {
  const turn = input.turn;
  const signal = input.signal ?? { aborted: false };
  const clock = input.clock;
  const startedAt = clock ? clock() : 0;
  const consumed: Consumed = { ...turn.consumed, modelCalls: turn.consumed.modelCalls ?? 0, toolCalls: turn.consumed.toolCalls ?? 0 };
  const messages: ModelMessage[] = [];
  const instructions = input.instructions ?? defaultInstructions;
  if (instructions !== "") {
    messages.push({ role: "system", text: instructions });
  }
  messages.push({ role: "user", text: turn.input.text });
  const completed: string[] = [];
  let malformed = 0;
  const malformedReasons: string[] = [];
  let failureKey = "";
  let failureCount = 0;

  const snapshot = (): Consumed => ({ ...consumed });

  const append = (type: RolloutEventType, payload: unknown): Result<RolloutEvent> => {
    try {
      return input.rollout.append({
        time: input.now(),
        sessionId: turn.sessionId,
        turnId: turn.id,
        type,
        payload,
      });
    } catch {
      return fail("rollout");
    }
  };

  const unwritable = (): LoopResult => ({
    status: "failed",
    exitCode: 1,
    text: "轨迹不可写。",
    stop: "rollout_unwritable",
    consumed: snapshot(),
    sessionId: turn.sessionId,
    turnId: turn.id,
  });

  const finish = (status: TurnStatus, exitCode: LoopResult["exitCode"], text: string, stop: LoopStop, writeCompleted: boolean): LoopResult => {
    if (writeCompleted) {
      const written = append("turn.completed", { status, text, consumed: snapshot() });
      if (!written.ok) {
        return unwritable();
      }
    }
    return { status, exitCode, text, stop, consumed: snapshot(), sessionId: turn.sessionId, turnId: turn.id };
  };

  const touchClock = () => {
    if (!clock) {
      return;
    }
    const elapsed = clock() - startedAt;
    consumed.wallClockMs = elapsed < 0 ? 0 : elapsed;
  };

  const exceeded = (keys: ReadonlyArray<(typeof limitRows)[number][1]>): LimitHit | null => {
    for (const [limitKey, usedKey, label] of limitRows) {
      if (!keys.includes(usedKey)) {
        continue;
      }
      const cap = turn.budget[limitKey];
      const used = consumed[usedKey] ?? 0;
      if (cap !== undefined && used >= cap) {
        return { label, used, cap };
      }
    }
    return null;
  };

  const addUsage = (usageSeen: boolean, inputTokens: number, outputTokens: number) => {
    if (!usageSeen) {
      return;
    }
    consumed.inputTokens = (consumed.inputTokens ?? 0) + inputTokens;
    consumed.outputTokens = (consumed.outputTokens ?? 0) + outputTokens;
  };

  const infer = async (): Promise<Inference> => {
    const request = { messages: structuredClone(messages) };
    const events: ModelEvent[] = [];
    try {
      for await (const event of input.provider.complete(request, signal)) {
        events.push(event);
      }
    } catch {
      return { kind: "malformed", reason: "模型调用失败。", usageSeen: false, inputTokens: 0, outputTokens: 0 };
    }
    return classify(events);
  };

  const budgetText = (hit: LimitHit, blocked: string | null): string => {
    const finished = completed.length > 0 ? completed.join("；") : "无";
    const pending = blocked ? `尚未开始 ${blocked}` : "尚未开始下一步";
    return `预算已用尽：${hit.label} ${hit.used}/${hit.cap}。\n已完成：${finished}。\n未完成：${pending}。`;
  };

  const budgetFinish = async (hit: LimitHit, blocked: string | null): Promise<LoopResult> => {
    const fallback = budgetText(hit, blocked);
    touchClock();
    if (signal.aborted) {
      return finish("cancelled", 5, "已中断。", "interrupted", true);
    }
    if (turn.budget.maxModelCalls !== undefined && (consumed.modelCalls ?? 0) >= turn.budget.maxModelCalls) {
      return finish("budget_exhausted", 4, fallback, "budget", true);
    }
    const pending = blocked ? `未开始：${blocked}。` : "";
    messages.push({
      role: "user",
      text: `预算已用尽。不要再调用工具。请说明已经完成的动作和尚未完成的事项。${pending}`,
    });
    const outcome = await infer();
    consumed.modelCalls = (consumed.modelCalls ?? 0) + 1;
    if (outcome.kind === "final" || outcome.kind === "tools" || outcome.kind === "malformed") {
      addUsage(outcome.usageSeen, outcome.inputTokens, outcome.outputTokens);
    }
    if (signal.aborted || outcome.kind === "aborted") {
      return finish("cancelled", 5, "已中断。", "interrupted", true);
    }
    if (outcome.kind === "final" && outcome.text.trim() !== "") {
      return finish("budget_exhausted", 4, outcome.text, "budget", true);
    }
    return finish("budget_exhausted", 4, fallback, "budget", true);
  };

  const started = append("turn.started", { input: turn.input, mode: turn.mode, budget: turn.budget });
  if (!started.ok) {
    return unwritable();
  }
  if (input.provider.profile.supportsTools !== true) {
    return finish("failed", 1, "模型不支持工具调用。", "tools_required", true);
  }
  if (signal.aborted) {
    return finish("cancelled", 5, "已中断。", "interrupted", true);
  }

  const inferLimits = ["modelCalls", "inputTokens", "outputTokens", "wallClockMs"] as const;
  const spentLimits = ["inputTokens", "outputTokens", "wallClockMs"] as const;
  const toolLimits = ["toolCalls", "inputTokens", "outputTokens", "wallClockMs"] as const;

  while (true) {
    if (signal.aborted) {
      return finish("cancelled", 5, "已中断。", "interrupted", true);
    }
    touchClock();
    const before = exceeded(inferLimits);
    if (before) {
      return budgetFinish(before, null);
    }
    const outcome = await infer();
    consumed.modelCalls = (consumed.modelCalls ?? 0) + 1;
    if (outcome.kind === "final" || outcome.kind === "tools" || outcome.kind === "malformed") {
      addUsage(outcome.usageSeen, outcome.inputTokens, outcome.outputTokens);
    }
    if (signal.aborted || outcome.kind === "aborted") {
      return finish("cancelled", 5, "已中断。", "interrupted", true);
    }
    if (outcome.kind === "tools_required") {
      return finish("failed", 1, "模型不支持工具调用。", "tools_required", true);
    }
    if (outcome.kind === "malformed") {
      malformed += 1;
      malformedReasons.push(outcome.reason);
      if (malformed >= 2) {
        return finish("failed", 1, `模型输出连续 2 次无法解析。${malformedReasons.join("")}`, "unparseable", true);
      }
      messages.push({ role: "user", text: `模型输出无法解析：${outcome.reason}请返回文本或合法的工具调用。` });
      continue;
    }
    malformed = 0;
    malformedReasons.length = 0;
    if (outcome.kind === "final") {
      return finish("completed", 0, outcome.text, "final", true);
    }
    if (outcome.text !== "") {
      messages.push({ role: "assistant", text: outcome.text });
    }
    touchClock();
    const spent = exceeded(spentLimits);
    if (spent) {
      return budgetFinish(spent, describeCall(outcome.calls[0]));
    }
    for (const call of outcome.calls) {
      if (signal.aborted) {
        return finish("cancelled", 5, "已中断。", "interrupted", true);
      }
      touchClock();
      const toolHit = exceeded(toolLimits);
      if (toolHit) {
        return budgetFinish(toolHit, describeCall(call));
      }
      const startedCall = append("tool.started", {
        callId: call.callId,
        name: call.name,
        arguments: structuredClone(call.arguments),
      });
      if (!startedCall.ok) {
        return unwritable();
      }
      const result = await executeCall(
        input.tools,
        { callId: call.callId, name: call.name, arguments: structuredClone(call.arguments) },
        signal,
      );
      consumed.toolCalls = (consumed.toolCalls ?? 0) + 1;
      const finished = append("tool.finished", {
        callId: call.callId,
        name: call.name,
        policy: { decision: result.status === "denied" ? "deny" : "allow" },
        result,
      });
      if (!finished.ok) {
        return unwritable();
      }
      if (result.status === "ok") {
        completed.push(describeCall(call));
        failureKey = "";
        failureCount = 0;
      }
      messages.push({ role: "tool", callId: call.callId, text: observedText(result) });
      if (result.status === "needs_approval") {
        const asked = append("user.requested", { callId: call.callId, question: questionFor(call, result) });
        if (!asked.ok) {
          return unwritable();
        }
        return finish("waiting_user", 3, questionFor(call, result), "waiting_user", false);
      }
      if (result.status !== "ok") {
        const key = `${call.name}\n${canonical(call.arguments)}`;
        failureCount = key === failureKey ? failureCount + 1 : 1;
        failureKey = key;
        if (failureCount >= 3) {
          const hint = result.correctiveHint ? result.correctiveHint : "";
          return finish("failed", 1, `已停止：${call.name} 使用相同参数连续失败 3 次。${hint}`, "repeated_failure", true);
        }
      }
    }
  }
}

async function executeCall(tools: ToolExecutor, call: ToolCallRequest, signal: ModelSignal): Promise<ToolResult> {
  try {
    const raw = await tools.execute(call, signal);
    const parsed = parseToolResult(raw);
    return parsed.ok ? parsed.value : errorResult("工具结果无法归一化。");
  } catch {
    return errorResult("工具执行失败。");
  }
}

function errorResult(hint: string): ToolResult {
  return {
    status: "error",
    content: [{ type: "text", text: hint }],
    artifacts: [],
    sideEffects: [],
    correctiveHint: hint,
  };
}

function questionFor(call: ToolCallRequest, result: ToolResult): string {
  const fromArgs = call.arguments.question;
  if (typeof fromArgs === "string" && fromArgs.trim() !== "") {
    return fromArgs;
  }
  const fromContent = result.content.find((block) => block.text.trim() !== "");
  return fromContent ? fromContent.text : "需要回答";
}

function observedText(result: ToolResult): string {
  const blocks = result.content
    .map((block) => (block.text !== "" ? block.text : "storedAt" in block ? `${block.storedAt} ${block.bytes}` : ""))
    .filter((text) => text !== "");
  const hint = result.correctiveHint && !blocks.includes(result.correctiveHint) ? result.correctiveHint : "";
  const body = [...blocks, hint].filter((text) => text !== "").join("\n");
  return body === "" ? result.status : `${result.status}\n${body}`;
}

function describeCall(call: ToolCallRequest): string {
  const keys = Object.keys(call.arguments).sort();
  if (keys.length === 0) {
    return call.name;
  }
  const args = keys.map((key) => `${key}=${JSON.stringify(call.arguments[key])}`).join(" ");
  return `${call.name} ${args}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`)
    .join(",")}}`;
}

function classify(events: readonly ModelEvent[]): Inference {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let usageSeen = false;
  let sawDone = false;
  const calls: ToolCallRequest[] = [];
  const seenIds = new Set<string>();
  for (const event of events) {
    if (event.type === "error" && event.code === "aborted") {
      return { kind: "aborted" };
    }
    if (event.type === "error" && event.code === "tools_required") {
      return { kind: "tools_required" };
    }
    if (event.type === "error") {
      return { kind: "malformed", reason: `模型调用失败：${event.code}。`, usageSeen, inputTokens, outputTokens };
    }
    if (event.type === "usage") {
      if (!Number.isInteger(event.inputTokens) || event.inputTokens < 0 || !Number.isInteger(event.outputTokens) || event.outputTokens < 0) {
        return { kind: "malformed", reason: "用量不是非负整数。", usageSeen, inputTokens, outputTokens };
      }
      usageSeen = true;
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      continue;
    }
    if (event.type === "text") {
      text += event.text;
      continue;
    }
    if (event.type === "done") {
      sawDone = true;
      continue;
    }
    const call = event.call;
    if (!callIdPattern.test(call.callId)) {
      return { kind: "malformed", reason: "调用标识不合法。", usageSeen, inputTokens, outputTokens };
    }
    if (!toolNamePattern.test(call.name) || !plainRecord(call.arguments)) {
      return { kind: "malformed", reason: plainRecord(call.arguments) ? "工具名称不合法。" : "工具参数不是对象。", usageSeen, inputTokens, outputTokens };
    }
    if (seenIds.has(call.callId)) {
      return { kind: "malformed", reason: "调用标识重复。", usageSeen, inputTokens, outputTokens };
    }
    try {
      calls.push({ callId: call.callId, name: call.name, arguments: structuredClone(call.arguments) });
      seenIds.add(call.callId);
    } catch {
      return { kind: "malformed", reason: "工具参数不是对象。", usageSeen, inputTokens, outputTokens };
    }
  }
  if (!sawDone) {
    return { kind: "malformed", reason: "没有完整输出。", usageSeen, inputTokens, outputTokens };
  }
  if (calls.length > 0) {
    return { kind: "tools", calls, text, usageSeen, inputTokens, outputTokens };
  }
  if (events.some((event) => event.type === "text")) {
    return { kind: "final", text, usageSeen, inputTokens, outputTokens };
  }
  return { kind: "malformed", reason: "没有文本或工具调用。", usageSeen, inputTokens, outputTokens };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
