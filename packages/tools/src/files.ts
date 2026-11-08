import type { ToolResult } from "pub.rh.agent.core";
import type { ToolHandler } from "./runtime.js";

const maxReadLines = 2000;
const maxReadBytes = 30000;
const maxSearchHits = 50;
const maxSearchDepth = 8;

export type DirectoryEntry = {
  name: string;
  kind: "file" | "directory";
};

export type ReadOutcome =
  | { kind: "file"; text: string }
  | { kind: "truncated"; text: string; bytes: number }
  | { kind: "missing" }
  | { kind: "directory" }
  | { kind: "binary"; bytes: number }
  | { kind: "unavailable" };

export type WorkspaceFiles = {
  readFile(absolutePath: string, maxBytes: number): ReadOutcome;
  writeFile(absolutePath: string, text: string): void;
  listDir(absolutePath: string): { entries: DirectoryEntry[] } | { error: "missing" | "not-directory" | "unavailable" };
};

export type ResolvedPath =
  | { allowed: true; relativePath: string; absolutePath: string }
  | { allowed: false; requestedPath: string; reason: string };

export type FileTurn = {
  revisions: Map<string, string>;
};

export function createFileHandlers(input: {
  files: WorkspaceFiles;
  turn: FileTurn;
  resolve: (requested: string) => ResolvedPath;
}): Partial<Record<string, ToolHandler>> {
  return {
    read_file: (call) => readFile(input, call.arguments),
    write_file: (call) => writeFile(input, call.arguments),
    edit_file: (call) => editFile(input, call.arguments),
    list_dir: (call) => listDir(input, call.arguments),
    search_files: (call) => searchFiles(input, call.arguments),
  };
}

function readFile(input: HandlerInput, args: Record<string, unknown>): ToolResult {
  const requested = requiredPath(args);
  if (!requested) {
    return failure("read_file 缺少 path。文件未被读取。");
  }
  const resolved = input.resolve(requested);
  if (!resolved.allowed) {
    return rejectPath("读取", requested, resolved.reason);
  }
  const read = readInside(input, resolved.absolutePath);
  if (read.kind === "missing") {
    return failure(`文件不存在：${resolved.relativePath}。`);
  }
  if (read.kind === "directory") {
    return failure(`这是目录：${resolved.relativePath}。请改用 list_dir。`);
  }
  if (read.kind === "binary") {
    return failure(`文件不是文本：${resolved.relativePath}。`);
  }
  if (read.kind === "unavailable") {
    return failure(`无法读取：${resolved.relativePath}。`);
  }
  if (read.kind === "file") {
    input.turn.revisions.set(resolved.relativePath, contentRevision(read.text));
    return ok(presentText(read.text, utf8ByteLength(read.text)).text);
  }
  return ok(presentText(read.text, read.bytes).text);
}

function writeFile(input: HandlerInput, args: Record<string, unknown>): ToolResult {
  const requested = requiredPath(args);
  const content = args.content;
  if (!requested || typeof content !== "string") {
    return failure("参数不符合 write_file 的 schema。文件未被写入。");
  }
  const resolved = input.resolve(requested);
  if (!resolved.allowed) {
    return rejectPath("写入", requested, resolved.reason);
  }
  try {
    input.files.writeFile(resolved.absolutePath, content);
  } catch {
    return failure("文件写入失败。文件未被写入。");
  }
  return written(resolved.relativePath, `已写入 ${resolved.relativePath}`);
}

function editFile(input: HandlerInput, args: Record<string, unknown>): ToolResult {
  const requested = requiredPath(args);
  const oldText = args.old;
  const newText = args.new;
  if (!requested || typeof oldText !== "string" || typeof newText !== "string") {
    return failure("参数不符合 edit_file 的 schema。文件未被写入。");
  }
  if (oldText === "") {
    return failure("要替换的原文不能为空。文件未被写入。");
  }
  const resolved = input.resolve(requested);
  if (!resolved.allowed) {
    return rejectPath("写入", requested, resolved.reason);
  }
  const known = input.turn.revisions.get(resolved.relativePath);
  if (known === undefined) {
    return failure(`尚未读取 ${resolved.relativePath}。请先 read_file，再 edit_file。文件未被写入。`);
  }
  const read = readInside(input, resolved.absolutePath);
  if (read.kind !== "file") {
    return failure(`无法编辑 ${resolved.relativePath}。请先重新读取。文件未被写入。`);
  }
  if (contentRevision(read.text) !== known) {
    return failure("文件在读取后已被修改。请先重新读取。文件未被写入。");
  }
  const found = countOccurrences(read.text, oldText);
  if (found === 0) {
    return failure("未找到要替换的原文。文件未被写入。请先重新读取并给出精确片段。");
  }
  if (found > 1) {
    return failure("要替换的原文出现了多次。文件未被写入。请给出更长的精确片段。");
  }
  const next = read.text.replace(oldText, newText);
  try {
    input.files.writeFile(resolved.absolutePath, next);
  } catch {
    return failure("文件写入失败。文件未被写入。");
  }
  input.turn.revisions.set(resolved.relativePath, contentRevision(next));
  return written(resolved.relativePath, `已替换 ${resolved.relativePath}`);
}

function listDir(input: HandlerInput, args: Record<string, unknown>): ToolResult {
  const requested = typeof args.path === "string" && args.path !== "" ? args.path : ".";
  const resolved = input.resolve(requested);
  if (!resolved.allowed) {
    return rejectPath("读取", requested, resolved.reason);
  }
  let listed: ReturnType<WorkspaceFiles["listDir"]>;
  try {
    listed = input.files.listDir(resolved.absolutePath);
  } catch {
    return failure(`无法列出目录：${resolved.relativePath || "."}。`);
  }
  if ("error" in listed) {
    if (listed.error === "not-directory") {
      return failure(`这不是目录：${resolved.relativePath}。`);
    }
    if (listed.error === "missing") {
      return failure(`目录不存在：${resolved.relativePath || "."}。`);
    }
    return failure(`无法列出目录：${resolved.relativePath || "."}。`);
  }
  const names = listed.entries
    .slice()
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name));
  return ok(names.length === 0 ? "（空目录）" : names.join("\n"));
}

function searchFiles(input: HandlerInput, args: Record<string, unknown>): ToolResult {
  const query = args.query;
  if (typeof query !== "string" || query.trim() === "") {
    return failure("query 不能为空。调用未执行。");
  }
  const hits: string[] = [];
  let truncated = false;
  const visit = (relative: string, depth: number) => {
    if (hits.length >= maxSearchHits) {
      truncated = true;
      return;
    }
    const resolved = input.resolve(relative === "" ? "." : relative);
    if (!resolved.allowed) {
      return;
    }
    let listed: ReturnType<WorkspaceFiles["listDir"]>;
    try {
      listed = input.files.listDir(resolved.absolutePath);
    } catch {
      return;
    }
    if ("error" in listed) {
      return;
    }
    const entries = listed.entries.slice().sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (hits.length >= maxSearchHits) {
        truncated = true;
        return;
      }
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.name.includes(query)) {
        hits.push(child);
      }
      if (entry.kind === "directory") {
        if (depth + 1 <= maxSearchDepth) {
          visit(child, depth + 1);
        }
        continue;
      }
      const file = input.resolve(child);
      if (!file.allowed) {
        continue;
      }
      const read = readInside(input, file.absolutePath);
      if (read.kind !== "file" && read.kind !== "truncated") {
        continue;
      }
      const lines = read.text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) {
          continue;
        }
        if (hits.length >= maxSearchHits) {
          truncated = true;
          return;
        }
        hits.push(`${child}:${index + 1}:${excerpt(lines[index])}`);
      }
    }
  };
  visit("", 0);
  if (hits.length === 0) {
    return ok(`没有找到与“${query}”匹配的文件。`);
  }
  return ok(truncated ? `${hits.join("\n")}\n结果已截断，只显示前 ${maxSearchHits} 条。` : hits.join("\n"));
}

type HandlerInput = {
  files: WorkspaceFiles;
  turn: FileTurn;
  resolve: (requested: string) => ResolvedPath;
};

function readInside(input: HandlerInput, absolutePath: string): ReadOutcome {
  try {
    return input.files.readFile(absolutePath, maxReadBytes);
  } catch {
    return { kind: "unavailable" };
  }
}

function presentText(text: string, originalBytes: number): { text: string } {
  const lines = text.split("\n");
  const lineCut = lines.length > maxReadLines;
  const lineText = lineCut ? lines.slice(0, maxReadLines).join("\n") : text;
  const byteCut = utf8ByteLength(lineText) > maxReadBytes || originalBytes > maxReadBytes;
  const body = byteCut ? sliceToBytes(lineText, maxReadBytes) : lineText;
  if (!lineCut && !byteCut) {
    return { text: body };
  }
  const note = `已截断：原始 ${originalBytes} 字节、${lines.length} 行。请用 search_files 定位后再读取片段。`;
  return { text: `${body}\n${note}` };
}

function written(relativePath: string, summary: string): ToolResult {
  return {
    status: "ok",
    content: [{ type: "text", text: summary }],
    artifacts: [{ id: relativePath, kind: "file", uri: relativePath, mediaType: "text/plain" }],
    sideEffects: [{ kind: "write", target: relativePath, summary }],
  };
}

function ok(text: string): ToolResult {
  return { status: "ok", content: [{ type: "text", text }], artifacts: [], sideEffects: [] };
}

function failure(hint: string): ToolResult {
  return { status: "error", content: [{ type: "text", text: hint }], artifacts: [], sideEffects: [], correctiveHint: hint };
}

function rejectPath(action: "读取" | "写入", requested: string, reason: string): ToolResult {
  if (reason === "outside") {
    const hint = `拒绝${action}工作区外的路径：${requested}。请改用工作区内的相对路径。`;
    return { status: "denied", content: [{ type: "text", text: hint }], artifacts: [], sideEffects: [], correctiveHint: hint };
  }
  return failure(`路径无效：${requested}。请改用工作区内的相对路径。`);
}

function requiredPath(args: Record<string, unknown>): string | null {
  return typeof args.path === "string" && args.path !== "" ? args.path : null;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const found = text.indexOf(needle, from);
    if (found < 0) {
      return count;
    }
    count += 1;
    from = found + needle.length;
  }
  return count;
}

function excerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

export function contentRevision(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash, 33) + text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
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
