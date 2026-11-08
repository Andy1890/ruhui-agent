import type { ToolResult } from "pub.rh.agent.core";
import type { ToolHandler } from "./runtime.js";

export type PlanStep = {
  title: string;
  status?: string;
};

export type PlanState = {
  steps: PlanStep[];
};

export function createPlanHandlers(input: { plan: PlanState }): Partial<Record<string, ToolHandler>> {
  return {
    update_plan: (call) => updatePlan(input.plan, call.arguments),
    ask_user: (call) => askUser(call.arguments),
  };
}

function updatePlan(plan: PlanState, args: Record<string, unknown>): ToolResult {
  const parsed = readSteps(args.steps);
  if (!parsed.ok) {
    return failure(parsed.hint);
  }
  plan.steps = parsed.steps;
  return ok(renderPlan(plan.steps));
}

function askUser(args: Record<string, unknown>): ToolResult {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (question === "") {
    return failure("ask_user 缺少问题。没有向使用者提问。");
  }
  const hint = "等待使用者回答。";
  return {
    status: "needs_approval",
    content: [{ type: "text", text: question }],
    artifacts: [],
    sideEffects: [],
    correctiveHint: hint,
  };
}

function readSteps(value: unknown): { ok: true; steps: PlanStep[] } | { ok: false; hint: string } {
  if (!Array.isArray(value)) {
    return { ok: false, hint: "update_plan 的 steps 必须是数组。计划未被改写。" };
  }
  const steps: PlanStep[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, hint: "update_plan 的步骤必须是对象。计划未被改写。" };
    }
    const source = item as Record<string, unknown>;
    if (typeof source.title !== "string" || source.title.trim() === "") {
      return { ok: false, hint: "步骤标题不能为空。计划未被改写。" };
    }
    const step: PlanStep = { title: source.title.trim() };
    if (source.status !== undefined) {
      if (typeof source.status !== "string" || source.status.trim() === "") {
        return { ok: false, hint: "步骤状态不能为空。计划未被改写。" };
      }
      step.status = source.status.trim();
    }
    steps.push(step);
  }
  return { ok: true, steps };
}

function renderPlan(steps: readonly PlanStep[]): string {
  if (steps.length === 0) {
    return "已清空计划。";
  }
  const lines = steps.map((step, index) => {
    const status = step.status ? ` [${step.status}]` : "";
    return `${index + 1}.${status} ${step.title}`;
  });
  return `已更新计划：\n${lines.join("\n")}`;
}

function ok(text: string): ToolResult {
  return { status: "ok", content: [{ type: "text", text }], artifacts: [], sideEffects: [] };
}

function failure(hint: string): ToolResult {
  return { status: "error", content: [{ type: "text", text: hint }], artifacts: [], sideEffects: [], correctiveHint: hint };
}
