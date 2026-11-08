export const runtimeVersion = "0.0.0";

export const phase1ModeText = "default 和 full 将在 Phase 1 提供。";

export const usageText = [
  "用法：",
  "ruhui run [--mode plan|workspace-write] [--max-tool-calls N] \"<任务>\"",
  "ruhui resume <sessionId>",
  "ruhui doctor",
  "",
  "省略 --mode 时使用 plan。default 和 full 将在 Phase 1 提供。",
].join("\n");

const sessionIdPattern = /^ses_[A-Za-z0-9_]+$/;

export type Phase0Mode = "plan" | "workspace-write";

export type CliCommand =
  | { kind: "usage"; exitCode: 2; text: string }
  | { kind: "doctor"; mode?: Phase0Mode }
  | { kind: "run"; mode?: Phase0Mode; task: string; sessionId?: string; maxToolCalls?: number }
  | { kind: "resume"; sessionId: string };

export type ShownTool = {
  name: string;
  arguments: Record<string, unknown>;
  status: string;
  text: string;
};

export function parseCommand(argv: readonly string[]): CliCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return usage();
  }
  const [command, ...rest] = argv;
  if (command === "doctor") {
    return parseDoctor(rest);
  }
  if (command === "run") {
    return parseRun(rest);
  }
  if (command === "resume") {
    return parseResume(rest);
  }
  return usage();
}

export function resolveMode(input: {
  cli?: Phase0Mode;
  user?: string;
  project?: string;
}): { ok: true; mode: Phase0Mode } | { ok: false; text: string } {
  for (const value of [input.user, input.project]) {
    if (value === undefined) {
      continue;
    }
    if (value === "default" || value === "full") {
      return { ok: false, text: phase1ModeText };
    }
    if (value !== "plan" && value !== "workspace-write") {
      return { ok: false, text: "模式必须是 plan 或 workspace-write。" };
    }
  }
  if (input.cli) {
    return { ok: true, mode: input.cli };
  }
  let mode: Phase0Mode = input.user === "workspace-write" ? "workspace-write" : "plan";
  if (input.project === "plan") {
    mode = "plan";
  }
  return { ok: true, mode };
}

export function renderDoctor(input: { version: string; workspaceRoot: string; mode: string; sandbox: string }): string {
  return [`版本 ${input.version}`, `工作区 ${input.workspaceRoot}`, `模式 ${input.mode}`, `沙箱 ${input.sandbox}`].join("\n");
}

export function renderRun(input: {
  sessionId: string;
  workspaceRoot: string;
  mode: string;
  sandbox: string;
  tools: readonly ShownTool[];
  text: string;
  stop: string;
  resumedFrom?: number;
}): string {
  const header = input.resumedFrom === undefined
    ? [`会话 ${input.sessionId}`, `工作区 ${input.workspaceRoot}`, `模式 ${input.mode}`, `沙箱 ${input.sandbox}`].join("\n")
    : `已恢复会话 ${input.sessionId}，从 seq=${input.resumedFrom} 继续。`;
  const text = input.stop === "interrupted" ? `已中断。会话 ${input.sessionId} 可恢复。` : input.text;
  return [header, ...input.tools.map(renderTool), text].filter((part) => part !== "").join("\n\n");
}

export function completedWriteKeys(events: readonly { type: string; payload: unknown }[]): string[] {
  const keys: string[] = [];
  for (const event of events) {
    if (event.type !== "tool.finished" || event.payload === null || typeof event.payload !== "object") {
      continue;
    }
    const payload = event.payload as { name?: unknown; result?: { status?: unknown; sideEffects?: unknown } };
    if (typeof payload.name !== "string" || payload.result?.status !== "ok" || !Array.isArray(payload.result.sideEffects)) {
      continue;
    }
    for (const effect of payload.result.sideEffects) {
      if (effect !== null && typeof effect === "object" && (effect as { kind?: unknown }).kind === "write") {
        const target = (effect as { target?: unknown }).target;
        if (typeof target === "string" && target !== "") {
          keys.push(`${payload.name}\n${normalizeTarget(target)}`);
        }
      }
    }
  }
  return keys;
}

export function skippedWriteResult(name: string, target: string): {
  status: "ok";
  content: [{ type: "text"; text: string }];
  artifacts: [];
  sideEffects: [];
} {
  return {
    status: "ok",
    content: [{ type: "text", text: `已跳过已完成的 ${name} path=${target}。` }],
    artifacts: [],
    sideEffects: [],
  };
}

export function writeTarget(args: Record<string, unknown>): string {
  return typeof args.path === "string" ? normalizeTarget(args.path) : "";
}

function renderTool(tool: ShownTool): string {
  if (tool.status === "error" && tool.name === "write_file" && tool.text.includes("缺少 content")) {
    return "write_file 失败：缺少字段 content。文件未被写入。";
  }
  if (tool.text.startsWith("已跳过已完成的")) {
    return tool.text;
  }
  const args = formatArgs(tool.name, tool.arguments);
  const head = args === "" ? tool.name : `${tool.name} ${args}`;
  return `${head}\n  ${tool.status}  ${shortDetail(tool)}`;
}

function formatArgs(name: string, args: Record<string, unknown>): string {
  if (Array.isArray(args.args)) {
    return `args=${JSON.stringify(args.args)}`;
  }
  if (typeof args.path === "string" && args.path !== "") {
    return `path=${args.path}`;
  }
  if (name === "list_dir") {
    return "path=.";
  }
  return "";
}

function shortDetail(tool: ShownTool): string {
  if (tool.name === "list_dir" && tool.status === "ok") {
    if (tool.text === "（空目录）" || tool.text === "") {
      return "0 个条目";
    }
    const count = tool.text.split("\n").filter((line) => line !== "").length;
    return `${count} 个条目`;
  }
  if (tool.name === "read_file" && tool.status === "ok") {
    return "已读取";
  }
  const line = tool.text.split("\n").find((item) => item !== "");
  return line ?? tool.status;
}

function normalizeTarget(target: string): string {
  const text = target.replaceAll("\\", "/").replace(/^\.\//, "");
  return text === "" ? "." : text;
}

function parseDoctor(argv: readonly string[]): CliCommand {
  const read = readOptions(argv, { mode: true, budget: false, session: false });
  if (!read.ok) {
    return usage(read.text);
  }
  if (read.positionals.length > 0) {
    return usage();
  }
  return { kind: "doctor", mode: read.mode };
}

function parseRun(argv: readonly string[]): CliCommand {
  const read = readOptions(argv, { mode: true, budget: true, session: true });
  if (!read.ok) {
    return usage(read.text);
  }
  if (read.positionals.length !== 1 || read.positionals[0].trim() === "") {
    return usage();
  }
  return {
    kind: "run",
    mode: read.mode,
    task: read.positionals[0],
    sessionId: read.session,
    maxToolCalls: read.maxToolCalls,
  };
}

function parseResume(argv: readonly string[]): CliCommand {
  const read = readOptions(argv, { mode: false, budget: false, session: false });
  if (!read.ok) {
    return usage(read.text);
  }
  if (read.positionals.length !== 1 || !sessionIdPattern.test(read.positionals[0])) {
    return usage(read.positionals.length === 1 ? "会话标识必须是 ses_ 加字母、数字或下划线。" : undefined);
  }
  return { kind: "resume", sessionId: read.positionals[0] };
}

function readOptions(argv: readonly string[], allow: { mode: boolean; budget: boolean; session: boolean }):
  | { ok: true; positionals: string[]; mode?: Phase0Mode; maxToolCalls?: number; session?: string }
  | { ok: false; text?: string } {
  const positionals: string[] = [];
  let mode: Phase0Mode | undefined;
  let maxToolCalls: number | undefined;
  let session: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    let value = eq === -1 ? argv[index + 1] : body.slice(eq + 1);
    if (eq === -1) {
      index += 1;
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      return { ok: false };
    }
    if (name === "mode" && allow.mode) {
      if (value === "default" || value === "full") {
        return { ok: false, text: phase1ModeText };
      }
      if (value !== "plan" && value !== "workspace-write") {
        return { ok: false, text: "模式必须是 plan 或 workspace-write。" };
      }
      mode = value;
      continue;
    }
    if (name === "max-tool-calls" && allow.budget) {
      if (!/^[1-9]\d*$/.test(value)) {
        return { ok: false, text: "--max-tool-calls 必须是正整数。" };
      }
      maxToolCalls = Number(value);
      continue;
    }
    if (name === "session" && allow.session) {
      if (!sessionIdPattern.test(value)) {
        return { ok: false, text: "会话标识必须是 ses_ 加字母、数字或下划线。" };
      }
      session = value;
      continue;
    }
    return { ok: false };
  }
  return { ok: true, positionals, mode, maxToolCalls, session };
}

function usage(lead?: string): CliCommand {
  const text = lead ? `${lead}\n${usageText}` : usageText;
  return { kind: "usage", exitCode: 2, text };
}
