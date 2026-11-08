import type { ToolResult } from "pub.rh.agent.core";
import type { ToolHandler } from "./runtime.js";

const maxCommandBytes = 30000;
const defaultTimeoutMs = 30000;

export const commandSandboxBackend = "path-jail";

export type CommandRequest = {
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
};

export type CommandOutput =
  | { kind: "exit"; code: number; stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number }
  | { kind: "timeout"; elapsedMs: number; stdout: string; stderr: string }
  | { kind: "failed" };

export type CommandRunner = {
  run(request: CommandRequest): Promise<CommandOutput>;
};

type ResolvedPath =
  | { allowed: true; relativePath: string; absolutePath: string }
  | { allowed: false; requestedPath: string; reason: string };

type ShellName = "none" | "pwsh" | "bash";

const formatHint = "拒绝执行该命令：禁止格式化磁盘或修改分区。命令未执行。";
const sshHint = "拒绝执行该命令：禁止读取 SSH 私钥目录。命令未执行。";
const credentialHint = "拒绝执行该命令：禁止读取凭据文件。命令未执行。";
const deleteHint = "拒绝执行该命令：禁止递归删除工作区外的路径。命令未执行。";
const backendNote = `沙箱 ${commandSandboxBackend}。`;

const formatNames = new Set([
  "format",
  "format.com",
  "format.exe",
  "format-volume",
  "clear-disk",
  "initialize-disk",
  "diskpart",
  "diskpart.exe",
  "diskutil",
  "mkfs",
  "parted",
  "fdisk",
  "gdisk",
  "sgdisk",
]);
const deleteCommands = new Set(["rm", "rmdir", "rd", "del", "erase", "remove-item", "ri"]);
const shellWrappers = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "bash.exe", "sh", "wsl", "wsl.exe"]);
const operators = new Set(["&&", "||", ";", "|", "&"]);

export function createCommandHandlers(input: {
  cwd: string;
  runner: CommandRunner;
  resolve: (requested: string) => ResolvedPath;
  timeoutMs?: number;
}): Partial<Record<string, ToolHandler>> {
  return {
    execute_command: (call) => executeCommand(input, call.arguments),
  };
}

async function executeCommand(
  input: { cwd: string; runner: CommandRunner; resolve: (requested: string) => ResolvedPath; timeoutMs?: number },
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = parseInvocation(args);
  if (!parsed.ok) {
    return failure(parsed.hint);
  }
  const danger = dangerousCommand(parsed.shell, parsed.args, input.resolve);
  if (danger) {
    return denied(danger);
  }
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : defaultTimeoutMs;
  const request = spawnRequest(parsed.shell, parsed.args, input.cwd, timeoutMs);
  let output: CommandOutput;
  try {
    output = await input.runner.run(request);
  } catch {
    return failure(`命令未能启动。命令未执行。${backendNote}`);
  }
  if (output.kind === "failed") {
    return failure(`命令未能启动。命令未执行。${backendNote}`);
  }
  if (output.kind === "timeout") {
    const hint = `命令已超时：已运行 ${output.elapsedMs} 毫秒，进程已终止。${backendNote}`;
    const streams = presentStreams(output.stdout, utf8ByteLength(output.stdout), output.stderr, utf8ByteLength(output.stderr));
    const text = streams ? `${streams}\n${hint}` : hint;
    return { status: "timeout", content: [{ type: "text", text }], artifacts: [], sideEffects: [], correctiveHint: hint };
  }
  const streams = presentStreams(output.stdout, output.stdoutBytes, output.stderr, output.stderrBytes);
  const summary = `退出码 ${output.code}。${backendNote}`;
  if (output.code === 0) {
    return ok(streams ? `${summary}\n${streams}` : summary);
  }
  const hint = `命令以退出码 ${output.code} 结束。请先读取相关文件，再修改。`;
  return failure(streams ? `${summary}\n${streams}\n${hint}` : `${summary}\n${hint}`, hint);
}

function parseInvocation(args: Record<string, unknown>): { ok: true; shell: ShellName; args: string[] } | { ok: false; hint: string } {
  const shell = args.shell === undefined ? "none" : args.shell;
  if (shell !== "none" && shell !== "pwsh" && shell !== "bash") {
    return { ok: false, hint: "shell 必须是 none、pwsh 或 bash。命令未执行。" };
  }
  if (!Array.isArray(args.args) || args.args.some((item) => typeof item !== "string")) {
    return { ok: false, hint: "args 必须是字符串数组。命令未执行。" };
  }
  const list = args.args.map((item) => item.trim()).filter((item) => item !== "");
  if (list.length === 0) {
    return { ok: false, hint: "execute_command 缺少参数。命令未执行。" };
  }
  if (shell !== "none" && list.length !== 1) {
    return { ok: false, hint: `shell 为 ${shell} 时，请把完整脚本作为单独参数。命令未执行。` };
  }
  return { ok: true, shell, args: list };
}

function spawnRequest(shell: ShellName, args: readonly string[], cwd: string, timeoutMs: number): CommandRequest {
  if (shell === "pwsh") {
    return { file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", args[0]], cwd, timeoutMs };
  }
  if (shell === "bash") {
    return { file: "bash", args: ["-lc", args[0]], cwd, timeoutMs };
  }
  return { file: args[0], args: args.slice(1), cwd, timeoutMs };
}

function dangerousCommand(shell: ShellName, args: readonly string[], resolve: (requested: string) => ResolvedPath): string | null {
  const words = wordsForDanger(shell, args);
  if (words.some((word) => isFormat(word))) {
    return formatHint;
  }
  const secret = words.map(credentialKind).find((kind) => kind !== null);
  if (secret === "ssh") {
    return sshHint;
  }
  if (secret === "cloud") {
    return credentialHint;
  }
  if (outsideDelete(words, resolve)) {
    return deleteHint;
  }
  return null;
}

function wordsForDanger(shell: ShellName, args: readonly string[]): string[] {
  const first = baseName(args[0] ?? "");
  if (shell !== "none" || args.length === 1 || shellWrappers.has(first)) {
    return args.flatMap(splitWords);
  }
  return [...args];
}

function isFormat(word: string): boolean {
  const base = baseName(word);
  return formatNames.has(base) || base.startsWith("mkfs.");
}

function credentialKind(word: string): "ssh" | "cloud" | null {
  const token = normalize(word).replace(/\/+$/, "");
  if (token === ".ssh" || token.endsWith("/.ssh") || token.includes("/.ssh/")) {
    return "ssh";
  }
  if (token.includes("/.aws/") || token.endsWith("/.aws") || token.includes("/.azure/") || token.includes("/.config/gcloud/") || token.includes("application_default_credentials.json")) {
    return "cloud";
  }
  return null;
}

function outsideDelete(words: readonly string[], resolve: (requested: string) => ResolvedPath): boolean {
  let command = "";
  let recursive = false;
  const targets: string[] = [];
  const finish = (): boolean => {
    if (!command || !recursive) {
      return false;
    }
    return targets.some((target) => targetOutside(target, resolve));
  };
  for (const word of words) {
    const token = normalize(word);
    const base = baseName(word);
    if (deleteCommands.has(base)) {
      if (finish()) {
        return true;
      }
      command = base;
      recursive = false;
      targets.length = 0;
      continue;
    }
    if (!command) {
      continue;
    }
    if (operators.has(token)) {
      if (finish()) {
        return true;
      }
      command = "";
      recursive = false;
      targets.length = 0;
      continue;
    }
    if (isFlag(token)) {
      if (isRecursive(command, token)) {
        recursive = true;
      }
      continue;
    }
    targets.push(word);
  }
  return finish();
}

function targetOutside(target: string, resolve: (requested: string) => ResolvedPath): boolean {
  const token = normalize(target);
  if (token.startsWith("~") || token.startsWith("%userprofile%") || token.startsWith("$home") || token.startsWith("${home")) {
    return true;
  }
  return !resolve(target).allowed;
}

function isFlag(token: string): boolean {
  if (token === "--" || token.startsWith("--") || (token.startsWith("-") && token.length > 1)) {
    return true;
  }
  return /^\/[a-z]{1,2}$/.test(token);
}

function isRecursive(command: string, token: string): boolean {
  if (command === "rm") {
    return token === "--recursive" || /^-[a-z]*r[a-z]*$/.test(token);
  }
  if (command === "rmdir" || command === "rd" || command === "del" || command === "erase") {
    return token === "/s" || token === "-s";
  }
  return token === "-recurse" || token === "-recursive" || token === "--recursive" || token === "-r";
}

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter((word) => word !== "");
}

function normalize(word: string): string {
  return word.trim().toLowerCase().replaceAll("\\", "/").replaceAll(/\/{2,}/g, "/");
}

function baseName(word: string): string {
  const token = normalize(word);
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

function presentStreams(stdout: string, stdoutBytes: number, stderr: string, stderrBytes: number): string {
  const parts: string[] = [];
  if (stdout || stdoutBytes > 0) {
    parts.push(clip(stdout, Math.max(stdoutBytes, utf8ByteLength(stdout))));
  }
  if (stderr || stderrBytes > 0) {
    parts.push(clip(stderr, Math.max(stderrBytes, utf8ByteLength(stderr))));
  }
  return parts.join("\n");
}

function clip(text: string, originalBytes: number): string {
  if (originalBytes <= maxCommandBytes && utf8ByteLength(text) <= maxCommandBytes) {
    return text;
  }
  return `${sliceToBytes(text, maxCommandBytes)}\n已截断：原始 ${originalBytes} 字节。`;
}

function ok(text: string): ToolResult {
  return { status: "ok", content: [{ type: "text", text }], artifacts: [], sideEffects: [] };
}

function failure(text: string, hint = text): ToolResult {
  return { status: "error", content: [{ type: "text", text }], artifacts: [], sideEffects: [], correctiveHint: hint };
}

function denied(hint: string): ToolResult {
  return { status: "denied", content: [{ type: "text", text: hint }], artifacts: [], sideEffects: [], correctiveHint: hint };
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
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
