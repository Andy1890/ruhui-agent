import type { ToolResult } from "pub.rh.agent.core";
import { decideToolPolicy } from "./policy.js";
import { closestToolName, resolveToolName, type RegisteredTool } from "./registry.js";
import { schemaProblems } from "./schema.js";

export type ToolHandler = (call: {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<ToolResult> | ToolResult;

export type ToolCallInput = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallOutcome = {
  callId: string;
  name: string;
  policy: { decision: "allow" | "deny" };
  result: ToolResult;
  executed: boolean;
};

const toolStatuses = new Set(["ok", "error", "denied", "needs_approval", "cancelled", "timeout"]);

export async function executeToolBatch(input: {
  calls: readonly ToolCallInput[];
  mode: string;
  handlers: Partial<Record<string, ToolHandler>>;
}): Promise<ToolCallOutcome[]> {
  const planned = input.calls.map((call) => ({ call, tool: resolveToolName(call.name) }));
  const serial = planned.some((item) => item.tool?.concurrency === "serial");
  if (!serial) {
    return Promise.all(planned.map((item) => runCall(item.call, item.tool, input)));
  }
  const outcomes: ToolCallOutcome[] = [];
  for (const item of planned) {
    outcomes.push(await runCall(item.call, item.tool, input));
  }
  return outcomes;
}

async function runCall(
  call: ToolCallInput,
  tool: RegisteredTool | null,
  input: { mode: string; handlers: Partial<Record<string, ToolHandler>> },
): Promise<ToolCallOutcome> {
  if (!tool) {
    const hint = `未知工具 ${call.name}。最接近的已注册名称是 ${closestToolName(call.name)}。调用未执行。`;
    return outcome(call.callId, call.name, allow, errorResult(hint), false);
  }
  const problems = schemaProblems(tool.inputSchema, call.arguments);
  if (problems.length > 0) {
    const note = tool.permissions.includes("write") ? "文件未被写入。" : "调用未执行。";
    const hint = `参数不符合 ${tool.name} 的 schema：${problems.join("；")}。${note}请补全参数后重试。`;
    return outcome(call.callId, tool.name, allow, errorResult(hint), false);
  }
  const policy = decideToolPolicy(input.mode, tool);
  if (policy.decision === "deny") {
    return outcome(call.callId, tool.name, { decision: "deny" }, deniedResult(policy.hint), false);
  }
  const handler = input.handlers[tool.name];
  if (!handler) {
    return outcome(call.callId, tool.name, allow, errorResult(`工具 ${tool.name} 尚未接入处理函数。调用未执行。`), false);
  }
  try {
    const raw = await handler({
      callId: call.callId,
      name: tool.name,
      arguments: structuredClone(call.arguments),
    });
    const parsed = asToolResult(raw);
    if (!parsed) {
      return outcome(call.callId, tool.name, allow, errorResult("工具结果无法归一化。"), true);
    }
    return outcome(call.callId, tool.name, allow, parsed, true);
  } catch {
    return outcome(call.callId, tool.name, allow, errorResult("工具执行失败。"), true);
  }
}

const allow = { decision: "allow" } as const;

function outcome(
  callId: string,
  name: string,
  policy: { decision: "allow" | "deny" },
  result: ToolResult,
  executed: boolean,
): ToolCallOutcome {
  return { callId, name, policy: { decision: policy.decision }, result, executed };
}

function errorResult(hint: string): ToolResult {
  return { status: "error", content: [{ type: "text", text: hint }], artifacts: [], sideEffects: [], correctiveHint: hint };
}

function deniedResult(hint: string): ToolResult {
  return { status: "denied", content: [{ type: "text", text: hint }], artifacts: [], sideEffects: [], correctiveHint: hint };
}

function asToolResult(value: unknown): ToolResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  if (typeof source.status !== "string" || !toolStatuses.has(source.status)) {
    return null;
  }
  if (!Array.isArray(source.content) || !Array.isArray(source.artifacts) || !Array.isArray(source.sideEffects)) {
    return null;
  }
  if (source.status !== "ok" && source.sideEffects.length > 0) {
    return null;
  }
  if (source.status !== "ok" && (typeof source.correctiveHint !== "string" || source.correctiveHint.trim() === "")) {
    return null;
  }
  for (const block of source.content) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      return null;
    }
    const text = block as Record<string, unknown>;
    if (text.type !== "text" || typeof text.text !== "string") {
      return null;
    }
  }
  return source as ToolResult;
}
