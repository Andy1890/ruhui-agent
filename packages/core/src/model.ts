export type ModelSignal = {
  readonly aborted: boolean;
};

export type ModelProfile = {
  id: string;
  contextWindow: number;
  supportsTools: boolean;
  supportsParallelTools: boolean;
  supportsStreaming: boolean;
  supportsImages: boolean;
};

export type ModelToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ModelMessage =
  | { role: "system" | "user" | "assistant"; text: string }
  | { role: "tool"; callId: string; text: string };

export type ModelRequest = {
  messages: readonly ModelMessage[];
};

export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ModelToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; code: "tools_required" | "script_exhausted" | "aborted" }
  | { type: "done" };

export type ModelProvider = {
  id: string;
  profile: ModelProfile;
  complete(request: ModelRequest, signal: ModelSignal): AsyncIterable<ModelEvent>;
};
