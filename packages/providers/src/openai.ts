import type { ModelEvent, ModelProfile, ModelProvider, ModelRequest, ModelSignal } from "pub.rh.agent.core";

const maxAttempts = 3;
const maxDelayMs = 60_000;

export type OpenAIHeaders = Record<string, string>;

export type OpenAIExchange =
  | { kind: "connection" }
  | { kind: "response"; status: number; headers: OpenAIHeaders; chunks: AsyncIterable<string> };

export type OpenAITransport = {
  post(input: { url: string; headers: OpenAIHeaders; body: string; signal: ModelSignal }): Promise<OpenAIExchange>;
};

const defaultProfile: ModelProfile = {
  id: "openai-compatible",
  contextWindow: 128000,
  supportsTools: true,
  supportsParallelTools: false,
  supportsStreaming: true,
  supportsImages: false,
};

export function retryDelayMs(attempt: number, retryAfter: string | undefined, nowMs: number): number {
  const header = delayFromHeader(retryAfter, nowMs);
  if (header !== null) {
    return Math.min(header, maxDelayMs);
  }
  const shift = attempt < 0 ? 0 : attempt;
  return Math.min(200 * 2 ** shift, maxDelayMs);
}

export function createOpenAICompatibleProvider(options: {
  baseUrl: string;
  model: string;
  apiKey: string;
  transport: OpenAITransport;
  profile?: Partial<ModelProfile>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): ModelProvider {
  const profile: ModelProfile = { ...defaultProfile, ...options.profile, id: options.profile?.id ?? defaultProfile.id };
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  return {
    id: "openai-compatible",
    profile,
    async *complete(request: ModelRequest, signal: ModelSignal): AsyncIterable<ModelEvent> {
      if (options.apiKey.trim() === "" || options.baseUrl.trim() === "" || options.model.trim() === "") {
        yield { type: "error", code: "request_failed" };
        yield { type: "done" };
        return;
      }
      const url = endpoint(options.baseUrl);
      const body = JSON.stringify({
        model: options.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: request.messages.map(wireMessage),
      });
      const headers = {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      };
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (signal.aborted) {
          yield { type: "error", code: "aborted" };
          return;
        }
        let exchange: OpenAIExchange;
        try {
          exchange = await options.transport.post({ url, headers, body, signal });
        } catch {
          exchange = { kind: "connection" };
        }
        if (exchange.kind === "connection" || (exchange.kind === "response" && retryable(exchange.status))) {
          if (exchange.kind === "response") {
            await drain(exchange.chunks);
          }
          if (attempt === maxAttempts - 1) {
            yield { type: "error", code: "request_failed" };
            yield { type: "done" };
            return;
          }
          const retryAfter = exchange.kind === "response" ? headerValue(exchange.headers, "retry-after") : undefined;
          await sleep(retryDelayMs(attempt, retryAfter, now()));
          continue;
        }
        if (exchange.status !== 200) {
          await drain(exchange.chunks);
          yield { type: "error", code: "request_failed" };
          yield { type: "done" };
          return;
        }
        yield* readStream(exchange.chunks, signal);
        return;
      }
    },
  };
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
}

function wireMessage(message: ModelRequest["messages"][number]): Record<string, string> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.callId, content: message.text };
  }
  return { role: message.role, content: message.text };
}

function retryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function headerValue(headers: OpenAIHeaders, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

async function drain(chunks: AsyncIterable<string>): Promise<void> {
  try {
    for await (const chunk of chunks) {
      void chunk;
    }
  } catch {
    return;
  }
}

async function* readStream(chunks: AsyncIterable<string>, signal: ModelSignal): AsyncIterable<ModelEvent> {
  const parser = createSseParser();
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let failed = false;
  const emitData = function* (payloads: readonly string[]): Generator<ModelEvent> {
    for (const payload of payloads) {
      if (payload === "[DONE]") {
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(payload);
      } catch {
        failed = true;
        return;
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        failed = true;
        return;
      }
      const record = body as Record<string, unknown>;
      const usage = readUsage(record.usage);
      if (usage) {
        yield usage;
      }
      const choice = firstChoice(record.choices);
      if (!choice) {
        continue;
      }
      const content = typeof choice.content === "string" ? choice.content : "";
      if (content !== "") {
        yield { type: "text", text: content };
      }
      if (!Array.isArray(choice.tool_calls)) {
        continue;
      }
      for (const call of choice.tool_calls) {
        if (!absorbToolCall(calls, call)) {
          failed = true;
          return;
        }
      }
    }
  };
  try {
    for await (const chunk of chunks) {
      if (signal.aborted) {
        yield { type: "error", code: "aborted" };
        return;
      }
      yield* emitData(parser.push(chunk));
      if (failed) {
        yield { type: "error", code: "request_failed" };
        yield { type: "done" };
        return;
      }
    }
  } catch {
    yield { type: "error", code: "request_failed" };
    yield { type: "done" };
    return;
  }
  yield* emitData(parser.finish());
  if (failed) {
    yield { type: "error", code: "request_failed" };
    yield { type: "done" };
    return;
  }
  const finished = finishCalls(calls);
  if (!finished) {
    yield { type: "error", code: "request_failed" };
    yield { type: "done" };
    return;
  }
  for (const call of finished) {
    yield { type: "tool_call", call };
  }
  yield { type: "done" };
}

function firstChoice(value: unknown): { content?: unknown; tool_calls?: unknown } | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const choice = value[0];
  if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
    return null;
  }
  const delta = (choice as Record<string, unknown>).delta;
  if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
    return {};
  }
  return delta as { content?: unknown; tool_calls?: unknown };
}

function readUsage(value: unknown): ModelEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const usage = value as Record<string, unknown>;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number" || !Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) {
    return null;
  }
  if (inputTokens < 0 || outputTokens < 0) {
    return null;
  }
  return { type: "usage", inputTokens, outputTokens };
}

function absorbToolCall(calls: Map<number, { id: string; name: string; arguments: string }>, value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const call = value as Record<string, unknown>;
  const index = call.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return false;
  }
  const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
  if (typeof call.id === "string" && call.id !== "") {
    current.id = call.id;
  }
  const fn = call.function;
  if (fn !== undefined && (fn === null || typeof fn !== "object" || Array.isArray(fn))) {
    return false;
  }
  if (fn && typeof fn === "object") {
    const fields = fn as Record<string, unknown>;
    if (typeof fields.name === "string" && fields.name !== "") {
      current.name = fields.name;
    }
    if (fields.arguments !== undefined) {
      if (typeof fields.arguments !== "string") {
        return false;
      }
      current.arguments += fields.arguments;
    }
  }
  calls.set(index, current);
  return true;
}

function finishCalls(calls: Map<number, { id: string; name: string; arguments: string }>): Array<{ callId: string; name: string; arguments: Record<string, unknown> }> | null {
  const ordered = [...calls.entries()].sort((left, right) => left[0] - right[0]);
  const finished = [];
  for (const [, call] of ordered) {
    if (call.id === "" || call.name === "") {
      return null;
    }
    let args: unknown = {};
    if (call.arguments.trim() !== "") {
      try {
        args = JSON.parse(call.arguments);
      } catch {
        return null;
      }
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return null;
    }
    finished.push({ callId: call.id, name: call.name, arguments: args as Record<string, unknown> });
  }
  return finished;
}

function createSseParser(): { push(chunk: string): string[]; finish(): string[] } {
  let buffer = "";
  let data = "";
  const take = (flush: boolean): string[] => {
    if (flush && buffer !== "" && !buffer.endsWith("\n")) {
      buffer += "\n";
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    const payloads: string[] = [];
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") {
        if (data !== "") {
          payloads.push(data);
          data = "";
        }
        continue;
      }
      if (!line.startsWith("data:")) {
        continue;
      }
      const piece = line.slice(5).replace(/^ /, "");
      data = data === "" ? piece : `${data}\n${piece}`;
    }
    return payloads;
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      return take(false);
    },
    finish() {
      const payloads = take(true);
      if (data !== "") {
        payloads.push(data);
        data = "";
      }
      return payloads;
    },
  };
}

function delayFromHeader(retryAfter: string | undefined, nowMs: number): number | null {
  if (retryAfter === undefined) {
    return null;
  }
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return Math.round(Number(retryAfter) * 1000);
  }
  const parsed = Date.parse(retryAfter);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed > nowMs ? parsed - nowMs : 0;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  const timer = (globalThis as { setTimeout?: (fn: () => void, delay: number) => unknown }).setTimeout;
  if (!timer) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    timer(resolve, ms);
  });
}
