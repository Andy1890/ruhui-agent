import { parseRolloutEvent, type RolloutEvent, type RolloutEventType } from "./event.js";
import { fail, ok, type Result } from "./result.js";
import { schemaVersion, sessionIdPattern, utcTimePattern } from "./schema-version.js";
import { hasWriteEffect, utf8ByteLength } from "./tool-result.js";

export type SessionFiles = {
  read(name: string): string | null;
  write(name: string, text: string): void;
  append(name: string, text: string): void;
  remove(name: string): void;
};

export type RolloutRead = {
  events: RolloutEvent[];
  discardedPartial: boolean;
  error: string | null;
  exitCode: 0 | 1;
  canResume: boolean;
  skipCalls: string[];
  retryCalls: string[];
};

export type RolloutAppend = {
  time: string;
  sessionId: string;
  turnId: string;
  type: RolloutEventType;
  payload: unknown;
};

export type RolloutHandle = {
  read: RolloutRead;
  append(input: RolloutAppend): Result<RolloutEvent>;
  release(): void;
};

const rolloutName = "rollout.jsonl";
const lockName = "writer.lock";

export function redactJson(value: unknown, secrets: readonly string[]): unknown {
  const usable = secrets.filter((secret) => secret.length > 0);
  const apply = (text: string) => usable.reduce((current, secret) => current.split(secret).join("[redacted]"), text);
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      return apply(current);
    }
    if (Array.isArray(current)) {
      return current.map(walk);
    }
    if (current !== null && typeof current === "object") {
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        copy[key] = walk(item);
      }
      return copy;
    }
    return current;
  };
  return walk(value);
}

function completePrefix(text: string): string {
  if (text.length === 0 || text.endsWith("\n")) {
    return text;
  }
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
}

function replayCalls(events: readonly RolloutEvent[]): { skipCalls: string[]; retryCalls: string[] } {
  const finished = new Set<string>();
  const skipCalls: string[] = [];
  const retryCalls: string[] = [];
  for (const event of events) {
    if (event.type !== "tool.finished" && event.type !== "tool.started") {
      continue;
    }
    const payload = event.payload as { callId?: string; result?: unknown };
    if (typeof payload.callId !== "string") {
      continue;
    }
    if (event.type === "tool.finished") {
      finished.add(payload.callId);
      if (payload.result && typeof payload.result === "object" && hasWriteEffect(payload.result as never)) {
        skipCalls.push(payload.callId);
      }
    }
  }
  for (const event of events) {
    if (event.type !== "tool.started") {
      continue;
    }
    const callId = (event.payload as { callId: string }).callId;
    if (!finished.has(callId)) {
      retryCalls.push(callId);
    }
  }
  return { skipCalls, retryCalls };
}

export function readRollout(text: string): RolloutRead {
  const discardedPartial = text.length > 0 && !text.endsWith("\n");
  const body = completePrefix(text);
  const events: RolloutEvent[] = [];
  const lines = body.split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return emptyRead(discardedPartial, "event");
    }
    if (parsed === null || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== schemaVersion) {
      return emptyRead(discardedPartial, "schema-version");
    }
    if ((parsed as { seq?: unknown }).seq !== events.length + 1) {
      return emptyRead(discardedPartial, "seq-gap");
    }
    const event = parseRolloutEvent(parsed);
    if (!event.ok) {
      return emptyRead(discardedPartial, event.error);
    }
    events.push(event.value);
  }
  const replay = replayCalls(events);
  return {
    events,
    discardedPartial,
    error: null,
    exitCode: 0,
    canResume: true,
    skipCalls: replay.skipCalls,
    retryCalls: replay.retryCalls,
  };
}

function emptyRead(discardedPartial: boolean, error: string): RolloutRead {
  return {
    events: [],
    discardedPartial,
    error,
    exitCode: 1,
    canResume: false,
    skipCalls: [],
    retryCalls: [],
  };
}

function spillPayload(payload: unknown, callId: string): { payload: unknown; blobs: { name: string; text: string }[] } {
  if (payload === null || typeof payload !== "object" || !("result" in payload)) {
    return { payload, blobs: [] };
  }
  const result = (payload as { result?: unknown }).result;
  if (result === null || typeof result !== "object" || !("content" in result) || !Array.isArray((result as { content?: unknown }).content)) {
    return { payload, blobs: [] };
  }
  const copy = structuredClone(payload) as { result: { content: Record<string, unknown>[] } };
  const blobs: { name: string; text: string }[] = [];
  copy.result.content = copy.result.content.map((block, index) => {
    if (block.type !== "text" || typeof block.text !== "string" || block.storedAt !== undefined) {
      return block;
    }
    const bytes = utf8ByteLength(block.text);
    if (bytes <= 32768) {
      return block;
    }
    const suffix = copy.result.content.length === 1 ? "" : `-${index}`;
    const storedAt = `blobs/${callId}${suffix}.txt`;
    blobs.push({ name: storedAt, text: block.text });
    return { type: "text", text: "", bytes, storedAt };
  });
  return { payload: copy, blobs };
}

function parseLock(text: string, sessionId: string): Result<{ pid: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("lock");
  }
  if (parsed === null || typeof parsed !== "object") {
    return fail("lock");
  }
  const lock = parsed as { pid?: unknown; sessionId?: unknown; createdAt?: unknown };
  if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 0) {
    return fail("lock");
  }
  if (lock.sessionId !== sessionId || typeof lock.createdAt !== "string" || !utcTimePattern.test(lock.createdAt)) {
    return fail("lock");
  }
  return ok({ pid: lock.pid });
}

export function openRollout(options: {
  files: SessionFiles;
  sessionId: string;
  pid: number;
  isAlive: (pid: number) => boolean;
  now: string;
  secrets?: readonly string[];
}): Result<RolloutHandle> {
  if (!sessionIdPattern.test(options.sessionId) || !Number.isInteger(options.pid) || options.pid <= 0) {
    return fail("session-id");
  }
  const existing = options.files.read(lockName);
  if (existing !== null) {
    const lock = parseLock(existing, options.sessionId);
    if (!lock.ok) {
      return lock;
    }
    if (options.isAlive(lock.value.pid)) {
      return fail("locked");
    }
    options.files.remove(lockName);
  }
  options.files.write(lockName, `${JSON.stringify({ pid: options.pid, sessionId: options.sessionId, createdAt: options.now })}\n`);
  const releaseLock = () => {
    const current = options.files.read(lockName);
    if (current === null) {
      return;
    }
    const lock = parseLock(current, options.sessionId);
    if (lock.ok && lock.value.pid === options.pid) {
      options.files.remove(lockName);
    }
  };
  const original = options.files.read(rolloutName) ?? "";
  const read = readRollout(original);
  if (read.error) {
    releaseLock();
    return fail(read.error);
  }
  if (read.discardedPartial) {
    options.files.write(rolloutName, completePrefix(original));
  }
  let events = read.events;
  const secrets = options.secrets ?? [];
  const handle: RolloutHandle = {
    read,
    append(input) {
      const redacted = redactJson(input.payload, secrets);
      const callId = redacted !== null && typeof redacted === "object" && "callId" in redacted && typeof redacted.callId === "string"
        ? redacted.callId
        : "call_output";
      const spilled = input.type === "tool.finished" ? spillPayload(redacted, callId) : { payload: redacted, blobs: [] };
      const event = parseRolloutEvent({
        schemaVersion,
        seq: events.length + 1,
        time: input.time,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: input.type,
        payload: spilled.payload,
      });
      if (!event.ok) {
        return event;
      }
      if (event.value.sessionId !== options.sessionId) {
        return fail("session-id");
      }
      for (const blob of spilled.blobs) {
        options.files.write(blob.name, blob.text);
      }
      options.files.append(rolloutName, `${JSON.stringify(event.value)}\n`);
      events = [...events, event.value];
      handle.read = readRollout(options.files.read(rolloutName) ?? "");
      return ok(event.value);
    },
    release: releaseLock,
  };
  return ok(handle);
}
