import { fail, ok, type Result } from "./result.js";
import { maxInlineToolTextBytes, toolNamePattern } from "./schema-version.js";

export const toolStatuses = ["ok", "error", "denied", "needs_approval", "cancelled", "timeout"] as const;
export type ToolStatus = (typeof toolStatuses)[number];

export type TextBlock =
  | { type: "text"; text: string }
  | { type: "text"; text: ""; bytes: number; storedAt: string };

export type ArtifactRef = {
  id: string;
  kind: "file" | "directory" | "patch" | "table" | "log";
  uri: string;
  mediaType: string;
  bytes?: number;
  summary?: string;
};

export type SideEffect = {
  kind: "write";
  target: string;
  summary: string;
};

export type ToolResult = {
  status: ToolStatus;
  content: TextBlock[];
  artifacts: ArtifactRef[];
  sideEffects: SideEffect[];
  correctiveHint?: string;
};

const artifactKinds = new Set(["file", "directory", "patch", "table", "log"]);
const storedAtPattern = /^blobs\/[A-Za-z0-9._-]+$/;

export function utf8ByteLength(text: string): number {
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

function parseTextBlock(value: unknown, allowLarge: boolean): Result<TextBlock> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("tool-content");
  }
  const block = value as Record<string, unknown>;
  if (block.type !== "text" || typeof block.text !== "string") {
    return fail("tool-content");
  }
  if (block.storedAt !== undefined || block.bytes !== undefined) {
    if (block.text !== "" || typeof block.bytes !== "number" || !Number.isInteger(block.bytes)) {
      return fail("tool-text");
    }
    if (block.bytes <= maxInlineToolTextBytes || typeof block.storedAt !== "string" || !storedAtPattern.test(block.storedAt)) {
      return fail("tool-text");
    }
    return ok({ type: "text", text: "", bytes: block.bytes, storedAt: block.storedAt });
  }
  if (!allowLarge && utf8ByteLength(block.text) > maxInlineToolTextBytes) {
    return fail("tool-text");
  }
  return ok({ type: "text", text: block.text });
}

function parseArtifact(value: unknown): Result<ArtifactRef> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("artifact");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || source.id === "" || typeof source.kind !== "string" || !artifactKinds.has(source.kind)) {
    return fail("artifact");
  }
  if (typeof source.uri !== "string" || source.uri === "" || typeof source.mediaType !== "string" || source.mediaType === "") {
    return fail("artifact");
  }
  const artifact: ArtifactRef = {
    id: source.id,
    kind: source.kind as ArtifactRef["kind"],
    uri: source.uri,
    mediaType: source.mediaType,
  };
  if (source.bytes !== undefined) {
    if (typeof source.bytes !== "number" || !Number.isInteger(source.bytes) || source.bytes < 0) {
      return fail("artifact");
    }
    artifact.bytes = source.bytes;
  }
  if (source.summary !== undefined) {
    if (typeof source.summary !== "string") {
      return fail("artifact");
    }
    artifact.summary = source.summary;
  }
  return ok(artifact);
}

function parseSideEffect(value: unknown): Result<SideEffect> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("side-effect");
  }
  const source = value as Record<string, unknown>;
  if (source.kind !== "write" || typeof source.target !== "string" || source.target === "" || typeof source.summary !== "string") {
    return fail("side-effect");
  }
  return ok({ kind: "write", target: source.target, summary: source.summary });
}

export function parseToolResult(value: unknown, options?: { allowLarge?: boolean }): Result<ToolResult> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("tool-result");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.status !== "string" || !toolStatuses.includes(source.status as ToolStatus)) {
    return fail("tool-status");
  }
  const status = source.status as ToolStatus;
  if (!Array.isArray(source.content) || !Array.isArray(source.artifacts) || !Array.isArray(source.sideEffects)) {
    return fail("tool-result");
  }
  const content: TextBlock[] = [];
  const allowLarge = options?.allowLarge === true;
  for (const block of source.content) {
    const parsed = parseTextBlock(block, allowLarge);
    if (!parsed.ok) {
      return parsed;
    }
    content.push(parsed.value);
  }
  const artifacts: ArtifactRef[] = [];
  for (const artifact of source.artifacts) {
    const parsed = parseArtifact(artifact);
    if (!parsed.ok) {
      return parsed;
    }
    artifacts.push(parsed.value);
  }
  const sideEffects: SideEffect[] = [];
  for (const effect of source.sideEffects) {
    const parsed = parseSideEffect(effect);
    if (!parsed.ok) {
      return parsed;
    }
    sideEffects.push(parsed.value);
  }
  if (status !== "ok" && sideEffects.length > 0) {
    return fail("side-effect");
  }
  if (status !== "ok" && (typeof source.correctiveHint !== "string" || source.correctiveHint.trim() === "")) {
    return fail("corrective-hint");
  }
  const result: ToolResult = { status, content, artifacts, sideEffects };
  if (source.correctiveHint !== undefined) {
    if (typeof source.correctiveHint !== "string") {
      return fail("corrective-hint");
    }
    result.correctiveHint = source.correctiveHint;
  }
  return ok(result);
}

export function hasWriteEffect(result: ToolResult): boolean {
  return result.status === "ok" && result.sideEffects.some((effect) => effect.kind === "write");
}

export function isToolName(value: string): boolean {
  return toolNamePattern.test(value);
}
