import type { ModelProfile } from "./model.js";
import { utf8ByteLength } from "./tool-result.js";

export const maxInstructionBytes = 32768;

const baseInstructions = "你是如辉 Agent。使用工具完成任务。不要伪造工具结果。工具被拒绝后，按照纠正提示调整。";

export type InstructionSource = {
  read(path: string): string | null;
  entries(directory: string): readonly string[] | null;
};

export type InstructionFile = {
  path: string;
  text: string;
};

export type ContextTool = {
  name: string;
  description: string;
  schema: string;
};

export type ContextPlanStep = {
  title: string;
  status?: string;
};

export function discoverInstructions(input: {
  homeFile: string;
  cwd: string;
  source: InstructionSource;
}): { root: string; files: InstructionFile[] } {
  const cwd = normalizePath(input.cwd);
  const root = workspaceRoot(cwd, input.source);
  const files: InstructionFile[] = [];
  const home = readInstruction(normalizePath(input.homeFile), input.source);
  if (home) {
    files.push(home);
  }
  for (const directory of layers(root, cwd)) {
    const preferred = readInstruction(joinPath(splitPath(directory), ["RUHUI.md"]), input.source);
    const fallback = preferred ? null : readInstruction(joinPath(splitPath(directory), ["AGENTS.md"]), input.source);
    const chosen = preferred ?? fallback;
    if (chosen && !files.some((file) => file.path === chosen.path)) {
      files.push(chosen);
    }
  }
  return { root, files };
}

export function assembleContext(input: {
  profile: ModelProfile;
  os: string;
  workspaceRoot: string;
  date: string;
  network: boolean;
  sandbox: string;
  instructions: readonly InstructionFile[];
  tools: readonly ContextTool[];
  plan?: readonly ContextPlanStep[];
  budget?: { toolCalls?: number; maxToolCalls?: number };
  userText: string;
}): { system: string; user: string } {
  const clipped = clipInstructions(input.instructions);
  const snapshot = [
    `环境：操作系统 ${input.os}；工作区 ${input.workspaceRoot}；日期 ${input.date}；网络${input.network ? "开启" : "关闭"}；沙箱 ${input.sandbox}。`,
  ];
  if (clipped.originalBytes > clipped.keptBytes) {
    snapshot.push(`指令文件已截断：原始 ${clipped.originalBytes} 字节，保留 ${clipped.keptBytes} 字节。`);
  }
  const parts = [baseInstructions, capability(input.profile), snapshot.join("\n")];
  if (clipped.files.length > 0) {
    parts.push(`项目指令：\n${clipped.files.map((file) => `${file.path}\n${file.text}`).join("\n")}`);
  }
  if (input.tools.length > 0) {
    parts.push(`工具：\n${input.tools.map((tool) => `${tool.name}：${tool.description}\n${tool.schema}`).join("\n")}`);
  }
  if (input.plan && input.plan.length > 0) {
    parts.push(`计划：\n${input.plan.map((step, index) => `${index + 1}. ${step.status ? `[${step.status}] ` : ""}${step.title}`).join("\n")}`);
  }
  if (input.budget?.maxToolCalls !== undefined) {
    parts.push(`预算：工具调用 ${input.budget.toolCalls ?? 0}/${input.budget.maxToolCalls}。`);
  }
  return { system: parts.join("\n"), user: input.userText };
}

function capability(profile: ModelProfile): string {
  const state = (enabled: boolean) => (enabled ? "已启用" : "未启用");
  return `能力：工具调用${state(profile.supportsTools)}；并行工具调用${state(profile.supportsParallelTools)}；流式输出${state(profile.supportsStreaming)}；图像${state(profile.supportsImages)}；上下文窗口 ${profile.contextWindow}。`;
}

function clipInstructions(files: readonly InstructionFile[]): { files: InstructionFile[]; originalBytes: number; keptBytes: number } {
  let originalBytes = 0;
  let keptBytes = 0;
  const kept: InstructionFile[] = [];
  for (const file of files) {
    const bytes = utf8ByteLength(file.text);
    originalBytes += bytes;
    if (keptBytes >= maxInstructionBytes) {
      continue;
    }
    const room = maxInstructionBytes - keptBytes;
    if (bytes <= room) {
      kept.push(file);
      keptBytes += bytes;
      continue;
    }
    const text = sliceToBytes(file.text, room);
    kept.push({ path: file.path, text });
    keptBytes += utf8ByteLength(text);
  }
  return { files: kept, originalBytes, keptBytes };
}

function readInstruction(path: string, source: InstructionSource): InstructionFile | null {
  const text = source.read(path);
  if (text === null || text === "") {
    return null;
  }
  return { path, text };
}

function workspaceRoot(cwd: string, source: InstructionSource): string {
  const chain = ancestors(cwd);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const names = source.entries(chain[index]);
    if (names?.includes(".git") || names?.includes(".ruhui")) {
      return chain[index];
    }
  }
  return cwd;
}

function layers(root: string, cwd: string): string[] {
  const chain = ancestors(cwd);
  const end = chain.indexOf(root);
  const slice = end >= 0 ? chain.slice(0, end + 1) : [cwd];
  return slice.reverse();
}

function ancestors(path: string): string[] {
  const chain = [path];
  let current = path;
  while (true) {
    const parent = parentPath(current);
    if (parent === current) {
      return chain;
    }
    chain.push(parent);
    current = parent;
  }
}

function parentPath(path: string): string {
  const parts = splitPath(path);
  if (parts.segments.length === 0) {
    return joinPath(parts);
  }
  return joinPath({ prefix: parts.prefix, segments: parts.segments.slice(0, -1) });
}

function joinPath(parts: { prefix: string; segments: readonly string[] }, extra: readonly string[] = []): string {
  const segments = [...parts.segments, ...extra];
  if (segments.length === 0) {
    return parts.prefix;
  }
  const base = parts.prefix.endsWith("/") ? parts.prefix.slice(0, -1) : parts.prefix;
  if (base === "") {
    return `/${segments.join("/")}`;
  }
  return `${base}/${segments.join("/")}`;
}

function splitPath(path: string): { prefix: string; segments: string[] } {
  const text = normalizePath(path);
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(text);
  if (drive) {
    return { prefix: `${drive[1].toUpperCase()}/`, segments: segmentsOf(drive[2] ?? "") };
  }
  const unc = /^(\/\/[^/]+\/[^/]+)(\/.*)?$/.exec(text);
  if (unc) {
    return { prefix: `${unc[1]}/`, segments: segmentsOf(unc[2] ?? "") };
  }
  if (text.startsWith("/")) {
    return { prefix: "/", segments: segmentsOf(text.slice(1)) };
  }
  return { prefix: "", segments: segmentsOf(text) };
}

function segmentsOf(value: string): string[] {
  return value.split("/").filter((segment) => segment !== "" && segment !== ".");
}

function normalizePath(path: string): string {
  const text = path.replaceAll("\\", "/");
  if (text === "/") {
    return "/";
  }
  if (/^[A-Za-z]:\/+$/.test(text)) {
    return `${text[0].toUpperCase()}:/`;
  }
  return text.replace(/\/+$/, "");
}

function sliceToBytes(text: string, max: number): string {
  let bytes = 0;
  let result = "";
  for (const char of text) {
    const size = utf8ByteLength(char);
    if (bytes + size > max) {
      break;
    }
    bytes += size;
    result += char;
  }
  return result;
}
