import type { RegisteredTool } from "./registry.js";

export type PolicyDecision = { decision: "allow" | "deny"; hint: string };

const planAllowed = new Set(["read_file", "list_dir", "search_files", "update_plan", "ask_user"]);

export function decideToolPolicy(mode: string, tool: RegisteredTool): PolicyDecision {
  if (mode !== "plan" && mode !== "workspace-write") {
    return { decision: "deny", hint: `模式 ${mode} 在 Phase 0 不可用。请改用 --mode workspace-write。` };
  }
  if (tool.permissions.includes("network")) {
    return { decision: "deny", hint: `拒绝执行 ${tool.name}：Phase 0 不提供网络。` };
  }
  if (mode === "plan" && !planAllowed.has(tool.name)) {
    const kind = tool.permissions.includes("write") ? "写入" : "命令";
    return {
      decision: "deny",
      hint: `拒绝执行 ${tool.name}：当前模式 plan 不允许${kind}。请改用 --mode workspace-write。`,
    };
  }
  return { decision: "allow", hint: "" };
}
