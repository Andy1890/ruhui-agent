import type { ModelEvent, ModelProfile, ModelProvider, ModelRequest, ModelSignal } from "pub.rh.agent.core";

export type ScriptedUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ScriptedStep =
  | { type: "text"; text: string; usage?: ScriptedUsage }
  | { type: "tool"; callId: string; name: string; arguments: Record<string, unknown>; usage?: ScriptedUsage };

const defaultProfile: ModelProfile = {
  id: "scripted",
  contextWindow: 128000,
  supportsTools: true,
  supportsParallelTools: false,
  supportsStreaming: true,
  supportsImages: false,
};

export function createScriptedProvider(script: readonly ScriptedStep[], profile: Partial<ModelProfile> = {}): ModelProvider {
  const steps = script.map((step) => structuredClone(step));
  const resolved: ModelProfile = { ...defaultProfile, ...profile };
  let cursor = 0;
  return {
    id: resolved.id,
    profile: resolved,
    async *complete(_request: ModelRequest, signal: ModelSignal): AsyncIterable<ModelEvent> {
      if (signal.aborted) {
        yield { type: "error", code: "aborted" };
        return;
      }
      const step = steps[cursor];
      cursor += 1;
      if (!step) {
        yield { type: "error", code: "script_exhausted" };
        yield { type: "done" };
        return;
      }
      if (step.type === "tool" && !resolved.supportsTools) {
        yield { type: "error", code: "tools_required" };
        yield { type: "done" };
        return;
      }
      if (step.type === "text") {
        yield { type: "text", text: step.text };
      } else {
        yield {
          type: "tool_call",
          call: {
            callId: step.callId,
            name: step.name,
            arguments: structuredClone(step.arguments),
          },
        };
      }
      if (step.usage) {
        yield { type: "usage", inputTokens: step.usage.inputTokens, outputTokens: step.usage.outputTokens };
      }
      yield { type: "done" };
    },
  };
}
