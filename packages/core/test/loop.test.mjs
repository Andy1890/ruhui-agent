import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTurn, maxInlineToolTextBytes, openRollout, readRollout, runLoop } from "../dist/index.js";

const now = "2026-11-08T04:00:01.000Z";

function memoryFiles() {
  const files = new Map();
  return {
    files,
    read(name) {
      return files.has(name) ? files.get(name) : null;
    },
    write(name, text) {
      files.set(name, text);
    },
    append(name, text) {
      files.set(name, (files.get(name) ?? "") + text);
    },
    remove(name) {
      files.delete(name);
    },
  };
}

function profile(supportsTools = true) {
  return {
    id: "scripted",
    contextWindow: 128000,
    supportsTools,
    supportsParallelTools: false,
    supportsStreaming: true,
    supportsImages: false,
  };
}

function scripted(steps, supportsTools = true) {
  let cursor = 0;
  const requests = [];
  return {
    requests,
    provider: {
      id: "scripted",
      profile: profile(supportsTools),
      async *complete(request, signal) {
        requests.push(request);
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
        if (step.type === "bad") {
          yield step.event;
          if (step.done !== false) {
            yield { type: "done" };
          }
          return;
        }
        if (step.type === "text") {
          yield { type: "text", text: step.text };
        } else if (step.type === "tools") {
          for (const call of step.calls) {
            yield { type: "tool_call", call };
          }
        } else {
          yield { type: "tool_call", call: { callId: step.callId, name: step.name, arguments: step.arguments } };
        }
        if (step.usage) {
          yield { type: "usage", inputTokens: step.usage.inputTokens, outputTokens: step.usage.outputTokens };
        }
        yield { type: "done" };
      },
    },
  };
}

function okResult(text, sideEffects = []) {
  return { status: "ok", content: [{ type: "text", text }], artifacts: [], sideEffects };
}

function errorResult(hint) {
  return { status: "error", content: [{ type: "text", text: hint }], artifacts: [], sideEffects: [], correctiveHint: hint };
}

function eventsOf(files) {
  return readRollout(files.files.get("rollout.jsonl") ?? "").events;
}

async function run(script, tools, budget = { maxToolCalls: 8 }, extras = {}) {
  const files = memoryFiles();
  const opened = openRollout({
    files,
    sessionId: "ses_note_summary",
    pid: 21,
    isAlive: () => false,
    now,
  });
  assert.equal(opened.ok, true);
  const turn = createTurn({
    id: "trn_note_summary",
    sessionId: "ses_note_summary",
    input: { text: "阅读本目录的笔记，生成 summary.md" },
    mode: "workspace-write",
    budget,
  });
  assert.equal(turn.ok, true);
  const model = scripted(script, extras.supportsTools ?? true);
  const result = await runLoop({
    turn: turn.value,
    provider: model.provider,
    tools,
    rollout: opened.value,
    signal: extras.signal,
    now: () => now,
    clock: extras.clock,
    instructions: extras.instructions,
  });
  opened.value.release();
  return { result, requests: model.requests, files, events: eventsOf(files) };
}

test("Loop 源码不引用运行时模块", () => {
  const source = fs.readFileSync(new URL("../src/loop.ts", import.meta.url), "utf8");
  assert.equal(source.includes("node:"), false);
  assert.equal(source.includes("from \"fs\""), false);
});

test("假模型按推理、工具、再推理走到最终答复", async () => {
  const seen = [];
  const tools = {
    execute(call) {
      seen.push(call.name);
      if (call.name === "write_file") {
        return okResult("已写入 summary.md", [{ kind: "write", target: "summary.md", summary: "已写入 summary.md" }]);
      }
      return okResult("已读取");
    },
  };
  const script = [
    { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." } },
    { type: "tool", callId: "call_read", name: "read_file", arguments: { path: "2026-11-01.md" } },
    { type: "tool", callId: "call_write", name: "write_file", arguments: { path: "summary.md", content: "周宁" } },
    { type: "text", text: "已生成 summary.md。发布日期为 2026-12-01，负责人为周宁，预算上限为 2 万元。" },
  ];
  const first = await run(script, tools);
  const second = await run(script, tools);
  assert.deepEqual(seen, ["list_dir", "read_file", "write_file", "list_dir", "read_file", "write_file"]);
  assert.equal(first.result.exitCode, 0);
  assert.equal(first.result.status, "completed");
  assert.equal(first.result.stop, "final");
  assert.equal(first.result.text, second.result.text);
  assert.equal(first.result.text.includes("2026-12-01"), true);
  assert.deepEqual(first.events.map((event) => event.type), [
    "turn.started",
    "tool.started",
    "tool.finished",
    "tool.started",
    "tool.finished",
    "tool.started",
    "tool.finished",
    "turn.completed",
  ]);
  assert.deepEqual(second.events.map((event) => event.type), first.events.map((event) => event.type));
  assert.equal(first.requests[0].messages[0].text, "使用工具完成任务。不要伪造工具结果。");
  assert.equal(first.requests[0].messages[1].text, "阅读本目录的笔记，生成 summary.md");
  assert.equal(first.requests[1].messages.some((message) => message.role === "tool" && message.callId === "call_list"), true);
  assert.equal(first.requests.some((request) => JSON.stringify(request).includes("update_plan")), false);
  assert.equal(first.events.at(-1).payload.status, "completed");
  assert.equal(first.events.at(-1).payload.consumed.toolCalls, 3);
});

test("超长工具输出在上下文里换成落盘引用，不调用模型做摘要", async () => {
  const huge = `${"x".repeat(maxInlineToolTextBytes)}TAIL-MARKER`;
  const tools = { execute() { return okResult(huge); } };
  const script = [
    { type: "tool", callId: "call_huge", name: "read_file", arguments: { path: "big.txt" } },
    { type: "text", text: "已看到引用。" },
  ];
  const ran = await run(script, tools);
  assert.equal(ran.requests.length, 2);
  const user = "阅读本目录的笔记，生成 summary.md";
  assert.equal(ran.requests[1].messages.some((message) => message.role === "user" && message.text === user), true);
  const tool = ran.requests[1].messages.find((message) => message.role === "tool");
  assert.equal(tool.text.includes("TAIL-MARKER"), false);
  assert.equal(tool.text.includes(`已落盘：原始 ${huge.length} 字节，路径 blobs/call_huge.txt。`), true);
  assert.equal(ran.files.files.get("blobs/call_huge.txt"), huge);
  assert.equal(ran.files.files.get("rollout.jsonl").includes("TAIL-MARKER"), false);
  assert.equal(ran.result.text, "已看到引用。");
});

test("工具抛错会回到下一次推理，不穿透出 Loop", async () => {
  const calls = [];
  const hint = "参数不符合 write_file 的 schema：缺少 content（字符串）。文件未被写入。请补全参数后重试。";
  const tools = {
    execute(call) {
      calls.push(call.name);
      if (call.name === "write_file") {
        throw new Error("boom");
      }
      return errorResult(hint);
    },
  };
  const { result, requests } = await run(
    [
      { type: "tool", callId: "call_write", name: "write_file", arguments: { path: "summary.md" } },
      { type: "tool", callId: "call_web", name: "web_fetch", arguments: { url: "https://example.test" } },
      { type: "text", text: "已停止。没有写入 summary.md。" },
    ],
    tools,
  );
  assert.deepEqual(calls, ["write_file", "web_fetch"]);
  assert.equal(result.exitCode, 0);
  assert.equal(requests[1].messages.at(-1).text.includes("工具执行失败。"), true);
  assert.equal(requests[2].messages.at(-1).text.includes(hint), true);
});

test("同一工具同一参数连续失败 3 次后停止", async () => {
  let count = 0;
  const hint = "参数不符合 write_file 的 schema：缺少 content（字符串）。文件未被写入。请补全参数后重试。";
  const tools = {
    execute() {
      count += 1;
      return errorResult(hint);
    },
  };
  const script = [
    { type: "tool", callId: "call_1", name: "write_file", arguments: { path: "summary.md", content: "a" } },
    { type: "tool", callId: "call_2", name: "write_file", arguments: { content: "a", path: "summary.md" } },
    { type: "tool", callId: "call_3", name: "write_file", arguments: { path: "summary.md", content: "a" } },
    { type: "text", text: "不应再推理" },
  ];
  const { result, requests, events } = await run(script, tools, {});
  assert.equal(count, 3);
  assert.equal(requests.length, 3);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stop, "repeated_failure");
  assert.equal(result.text.includes("连续失败 3 次"), true);
  assert.equal(result.text.includes(hint), true);
  assert.equal(events.at(-1).payload.status, "failed");
  assert.equal(events.filter((event) => event.type === "tool.started").length, 3);
});

test("模型输出连续两次无法解析后停止，中间仍把原因交回去", async () => {
  const { result, requests } = await run(
    [
      { type: "bad", event: { type: "done" } },
      { type: "bad", event: { type: "tool_call", call: { callId: "bad", name: "read_file", arguments: {} } } },
      { type: "text", text: "不应到达" },
    ],
    { execute() { throw new Error("不应执行"); } },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.stop, "unparseable");
  assert.equal(result.text.includes("连续 2 次无法解析"), true);
  assert.equal(requests[1].messages.at(-1).text.includes("没有文本或工具调用"), true);
  assert.equal(requests.length, 2);
});

test("一次无法解析之后仍可以正常结束", async () => {
  const { result } = await run(
    [
      { type: "bad", event: { type: "text", text: "半截" }, done: false },
      { type: "text", text: "已完成。" },
    ],
    { execute() { throw new Error("不应执行"); } },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.text, "已完成。");
});

test("工具预算用尽时不开始下一次调用，收尾失败则留下确定性说明", async () => {
  const seen = [];
  const tools = {
    execute(call) {
      seen.push(call.name);
      return okResult("ok");
    },
  };
  const { result, events, requests } = await run(
    [
      { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." } },
      { type: "tool", callId: "call_read", name: "read_file", arguments: { path: "2026-11-01.md" } },
      { type: "tool", callId: "call_next", name: "read_file", arguments: { path: "2026-11-02.md" } },
    ],
    tools,
    { maxToolCalls: 2 },
  );
  assert.deepEqual(seen, ["list_dir", "read_file"]);
  assert.equal(result.exitCode, 4);
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.text.includes("预算已用尽：工具调用 2/2。"), true);
  assert.equal(result.text.includes("已完成：list_dir path=\".\"；read_file path=\"2026-11-01.md\"。"), true);
  assert.equal(result.text.includes("未完成：尚未开始 read_file path=\"2026-11-02.md\"。"), true);
  assert.equal(events.filter((event) => event.type === "tool.started").length, 2);
  assert.equal(events.at(-1).type, "turn.completed");
  assert.equal(requests.at(-1).messages.at(-1).text.includes("不要再调用工具"), true);
});

test("预算收尾如果返回文本，就采用这段文本", async () => {
  const seen = [];
  const { result } = await run(
    [
      { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." } },
      { type: "tool", callId: "call_read", name: "read_file", arguments: { path: "2026-11-01.md" } },
      { type: "tool", callId: "call_next", name: "read_file", arguments: { path: "2026-11-02.md" } },
      { type: "text", text: "已完成目录列举。未完成摘要。" },
    ],
    {
      execute(call) {
        seen.push(call.name);
        return okResult("ok");
      },
    },
    { maxToolCalls: 2 },
  );
  assert.deepEqual(seen, ["list_dir", "read_file"]);
  assert.equal(result.exitCode, 4);
  assert.equal(result.text, "已完成目录列举。未完成摘要。");
});

test("输入词元用尽时不执行已经返回的工具调用", async () => {
  const seen = [];
  const { result } = await run(
    [
      { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." }, usage: { inputTokens: 10, outputTokens: 1 } },
      { type: "tool", callId: "call_again", name: "read_file", arguments: { path: "2026-11-02.md" } },
    ],
    {
      execute(call) {
        seen.push(call.name);
        return okResult("ok");
      },
    },
    { maxInputTokens: 10 },
  );
  assert.deepEqual(seen, []);
  assert.equal(result.exitCode, 4);
  assert.equal(result.text.includes("输入词元 10/10"), true);
  assert.equal(result.text.includes("尚未开始 list_dir"), true);
});

test("墙钟用尽后不再开始下一次推理中的工具", async () => {
  let elapsed = 0;
  const seen = [];
  const { result, requests } = await run(
    [
      { type: "tool", callId: "call_list", name: "list_dir", arguments: {} },
      { type: "tool", callId: "call_read", name: "read_file", arguments: { path: "2026-11-02.md" } },
    ],
    {
      execute(call) {
        seen.push(call.name);
        elapsed = 50;
        return okResult("ok");
      },
    },
    { wallClockMs: 50 },
    { clock: () => elapsed },
  );
  assert.deepEqual(seen, ["list_dir"]);
  assert.equal(requests.length, 2);
  assert.equal(result.exitCode, 4);
  assert.equal(result.text.includes("墙钟毫秒 50/50"), true);
});

test("不支持工具调用时直接失败", async () => {
  const { result, requests, events } = await run(
    [{ type: "text", text: "不应调用" }],
    { execute() { throw new Error("不应执行"); } },
    {},
    { supportsTools: false },
  );
  assert.equal(requests.length, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stop, "tools_required");
  assert.equal(result.text, "模型不支持工具调用。");
  assert.deepEqual(events.map((event) => event.type), ["turn.started", "turn.completed"]);
});

test("模型请求失败时停止，不再发起下一次推理", async () => {
  const files = memoryFiles();
  const opened = openRollout({
    files,
    sessionId: "ses_note_summary",
    pid: 21,
    isAlive: () => false,
    now,
  });
  assert.equal(opened.ok, true);
  const turn = createTurn({
    id: "trn_note_summary",
    sessionId: "ses_note_summary",
    input: { text: "阅读本目录的笔记，生成 summary.md" },
    mode: "workspace-write",
    budget: { maxToolCalls: 8 },
  });
  assert.equal(turn.ok, true);
  let calls = 0;
  const result = await runLoop({
    turn: turn.value,
    provider: {
      id: "openai-compatible",
      profile: profile(),
      async *complete() {
        calls += 1;
        yield { type: "error", code: "request_failed" };
        yield { type: "done" };
      },
    },
    tools: { execute() { throw new Error("不应执行"); } },
    rollout: opened.value,
    now: () => now,
  });
  opened.value.release();
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stop, "request_failed");
  assert.equal(result.text, "模型请求失败。");
});

test("开始前中断不调用模型", async () => {
  const { result, requests, events } = await run(
    [{ type: "text", text: "不应调用" }],
    { execute() { throw new Error("不应执行"); } },
    {},
    { signal: { aborted: true } },
  );
  assert.equal(requests.length, 0);
  assert.equal(result.exitCode, 5);
  assert.equal(result.status, "cancelled");
  assert.equal(result.text, "已中断。");
  assert.equal(events.at(-1).payload.status, "cancelled");
});

test("工具返回后发现中断，不再继续推理", async () => {
  const signal = { aborted: false };
  const { result, requests } = await run(
    [
      { type: "tool", callId: "call_list", name: "list_dir", arguments: {} },
      { type: "text", text: "不应到达" },
    ],
    {
      execute() {
        signal.aborted = true;
        return okResult("ok");
      },
    },
    {},
    { signal },
  );
  assert.equal(requests.length, 1);
  assert.equal(result.exitCode, 5);
  assert.equal(result.stop, "interrupted");
});

test("轨迹无法追加时直接失败，不再推理", async () => {
  const files = memoryFiles();
  files.append = () => {
    throw new Error("disk");
  };
  const opened = openRollout({ files, sessionId: "ses_note_summary", pid: 21, isAlive: () => false, now });
  assert.equal(opened.ok, true);
  const turn = createTurn({
    id: "trn_note_summary",
    sessionId: "ses_note_summary",
    input: { text: "阅读笔记" },
    mode: "plan",
    budget: {},
  });
  const model = scripted([{ type: "text", text: "不应到达" }]);
  const result = await runLoop({
    turn: turn.value,
    provider: model.provider,
    tools: { execute() { throw new Error("不应执行"); } },
    rollout: opened.value,
    now: () => now,
  });
  assert.equal(model.requests.length, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stop, "rollout_unwritable");
  assert.equal(result.text, "轨迹不可写。");
});

test("工具开始事件写不进去时不执行工具", async () => {
  const files = memoryFiles();
  let writes = 0;
  const original = files.append.bind(files);
  files.append = (name, text) => {
    writes += 1;
    if (writes > 1) {
      throw new Error("disk");
    }
    original(name, text);
  };
  const opened = openRollout({ files, sessionId: "ses_note_summary", pid: 21, isAlive: () => false, now });
  const turn = createTurn({
    id: "trn_note_summary",
    sessionId: "ses_note_summary",
    input: { text: "阅读笔记" },
    mode: "plan",
    budget: {},
  });
  let executed = 0;
  const result = await runLoop({
    turn: turn.value,
    provider: scripted([{ type: "tool", callId: "call_list", name: "list_dir", arguments: {} }]).provider,
    tools: {
      execute() {
        executed += 1;
        return okResult("ok");
      },
    },
    rollout: opened.value,
    now: () => now,
  });
  assert.equal(executed, 0);
  assert.equal(result.stop, "rollout_unwritable");
});

test("需要回答时停在 waiting_user，同批后续调用不执行", async () => {
  const seen = [];
  const { result, events, requests } = await run(
    [
      {
        type: "tools",
        calls: [
          { callId: "call_ask", name: "ask_user", arguments: { question: "摘要使用哪个标题？" } },
          { callId: "call_next", name: "write_file", arguments: { path: "summary.md", content: "x" } },
        ],
      },
    ],
    {
      async execute(call) {
        seen.push(call.name);
        if (call.name === "ask_user") {
          return {
            status: "needs_approval",
            content: [{ type: "text", text: "摘要使用哪个标题？" }],
            artifacts: [],
            sideEffects: [],
            correctiveHint: "等待使用者回答。",
          };
        }
        return okResult("不应执行");
      },
    },
  );
  assert.deepEqual(seen, ["ask_user"]);
  assert.equal(requests.length, 1);
  assert.equal(result.exitCode, 3);
  assert.equal(result.status, "waiting_user");
  assert.equal(result.text, "摘要使用哪个标题？");
  assert.equal(events.some((event) => event.type === "turn.completed"), false);
  assert.equal(events.some((event) => event.type === "user.requested" && event.payload.question === "摘要使用哪个标题？"), true);
});

test("拒绝结果写 deny，并继续交给模型", async () => {
  const { result, events, requests } = await run(
    [
      { type: "tool", callId: "call_read", name: "read_file", arguments: { path: "D:/work/outside-secret.txt" } },
      { type: "text", text: "已停止。" },
    ],
    {
      execute() {
        return {
          status: "denied",
          content: [{ type: "text", text: "拒绝读取工作区外的路径。" }],
          artifacts: [],
          sideEffects: [],
          correctiveHint: "拒绝读取工作区外的路径。请改用工作区内的相对路径。",
        };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  const finished = events.find((event) => event.type === "tool.finished");
  assert.equal(finished.payload.policy.decision, "deny");
  assert.equal(requests[1].messages.at(-1).text.includes("请改用工作区内的相对路径"), true);
});
