import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTurn, openRollout, readRollout, runLoop } from "../../core/dist/index.js";
import { createScriptedProvider } from "../../providers/dist/index.js";
import { createPlanHandlers, executeToolBatch } from "../dist/index.js";

const now = "2026-11-08T04:00:01.000Z";
const question = "摘要使用哪个标题？";

function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

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

function executor(handlers, seen) {
  return {
    execute(call) {
      seen.push(call.name);
      const handler = handlers[call.name];
      if (!handler) {
        return { status: "ok", content: [{ type: "text", text: "已读取" }], artifacts: [], sideEffects: [] };
      }
      return handler({ callId: call.callId, name: call.name, arguments: call.arguments });
    },
  };
}

async function run(provider, handlers, seen) {
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
  const result = await runLoop({
    turn: turn.value,
    provider,
    tools: executor(handlers, seen),
    rollout: opened.value,
    now: () => now,
  });
  opened.value.release();
  return { result, events: readRollout(files.files.get("rollout.jsonl") ?? "").events };
}

test("计划实现不引用文件系统，也不会自己插入步骤", () => {
  const source = fs.readFileSync(new URL("../src/plan.ts", import.meta.url), "utf8");
  assert.equal(source.includes("node:"), false);
  assert.equal(source.includes("approval.respond"), false);
  assert.equal(source.includes("hash"), false);
});

test("简单任务不调用 update_plan，计划保持为空", async () => {
  const plan = { steps: [] };
  const seen = [];
  const requests = [];
  const scripted = createScriptedProvider([
    { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." } },
    { type: "tool", callId: "call_read", name: "read_file", arguments: { path: "2026-11-01.md" } },
    { type: "tool", callId: "call_write", name: "write_file", arguments: { path: "summary.md", content: "周宁" } },
    { type: "text", text: "已生成 summary.md。发布日期为 2026-12-01，负责人为周宁，预算上限为 2 万元。" },
  ]);
  const provider = {
    id: scripted.id,
    profile: scripted.profile,
    async *complete(request, signal) {
      requests.push(request);
      yield* scripted.complete(request, signal);
    },
  };
  const { result, events } = await run(provider, createPlanHandlers({ plan }), seen);
  assert.deepEqual(seen, ["list_dir", "read_file", "write_file"]);
  assert.equal(plan.steps.length, 0);
  assert.equal(requests.some((request) => JSON.stringify(request).includes("update_plan")), false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "completed");
  assert.equal(events.some((event) => event.type === "user.requested"), false);
});

test("update_plan 改写清单，缺标题时不改原来的计划", async () => {
  const plan = { steps: [] };
  const handlers = createPlanHandlers({ plan });
  const written = await handlers.update_plan({
    callId: "call_plan",
    name: "update_plan",
    arguments: {
      steps: [{ title: " 阅读笔记 " }, { title: "写出摘要", status: " completed " }],
    },
  });
  assert.equal(written.status, "ok");
  assert.equal(textOf(written), "已更新计划：\n1. 阅读笔记\n2. [completed] 写出摘要");
  assert.deepEqual(plan.steps, [
    { title: "阅读笔记" },
    { title: "写出摘要", status: "completed" },
  ]);
  const replaced = await handlers.update_plan({
    callId: "call_plan_2",
    name: "update_plan",
    arguments: { steps: [{ title: "只保留这一步" }] },
  });
  assert.equal(textOf(replaced).includes("阅读笔记"), false);
  assert.deepEqual(plan.steps, [{ title: "只保留这一步" }]);
  const blank = await executeToolBatch({
    mode: "plan",
    calls: [{ callId: "call_blank", name: "update_plan", arguments: { steps: [{ title: "  " }] } }],
    handlers,
  });
  assert.equal(blank[0].result.status, "error");
  assert.equal(blank[0].result.correctiveHint, "步骤标题不能为空。计划未被改写。");
  assert.deepEqual(plan.steps, [{ title: "只保留这一步" }]);
  const missing = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_missing", name: "update_plan", arguments: { steps: [{}] } }],
    handlers,
  });
  assert.equal(missing[0].executed, false);
  assert.equal(missing[0].result.correctiveHint.includes("缺少 title（字符串）"), true);
  assert.deepEqual(plan.steps, [{ title: "只保留这一步" }]);
});

test("ask_user 挂起本轮，不发明回答，同批后续调用不执行", async () => {
  const plan = { steps: [{ title: "先提问" }] };
  const seen = [];
  const provider = {
    id: "scripted",
    profile: {
      id: "scripted",
      contextWindow: 128000,
      supportsTools: true,
      supportsParallelTools: false,
      supportsStreaming: true,
      supportsImages: false,
    },
    async *complete(_request, signal) {
      if (signal.aborted) {
        yield { type: "error", code: "aborted" };
        return;
      }
      yield { type: "tool_call", call: { callId: "call_ask", name: "ask_user", arguments: { question } } };
      yield { type: "tool_call", call: { callId: "call_next", name: "write_file", arguments: { path: "summary.md", content: "x" } } };
      yield { type: "done" };
    },
  };
  const { result, events } = await run(provider, createPlanHandlers({ plan }), seen);
  const finished = events.find((event) => event.type === "tool.finished");
  const asked = events.find((event) => event.type === "user.requested");
  assert.deepEqual(seen, ["ask_user"]);
  assert.equal(result.exitCode, 3);
  assert.equal(result.status, "waiting_user");
  assert.equal(result.stop, "waiting_user");
  assert.equal(result.text, question);
  assert.equal(finished.payload.result.status, "needs_approval");
  assert.equal(finished.payload.result.content.length, 1);
  assert.equal(finished.payload.result.content[0].text, question);
  assert.equal(finished.payload.result.correctiveHint, "等待使用者回答。");
  assert.equal(finished.payload.result.sideEffects.length, 0);
  assert.equal(JSON.stringify(finished.payload).includes("hash"), false);
  assert.equal(JSON.stringify(finished.payload).includes("approval.respond"), false);
  assert.equal(asked.payload.question, question);
  assert.equal(events.some((event) => event.type === "turn.completed"), false);
  assert.deepEqual(plan.steps, [{ title: "先提问" }]);
});

test("空问题不会挂起，也不会编出一句提问", async () => {
  const plan = { steps: [] };
  const handlers = createPlanHandlers({ plan });
  const [blank] = await executeToolBatch({
    mode: "plan",
    calls: [{ callId: "call_ask", name: "ask_user", arguments: { question: "   " } }],
    handlers,
  });
  assert.equal(blank.result.status, "error");
  assert.equal(blank.result.correctiveHint, "ask_user 缺少问题。没有向使用者提问。");
  assert.equal(textOf(blank.result).includes("需要回答"), false);
  const [missing] = await executeToolBatch({
    mode: "plan",
    calls: [{ callId: "call_missing", name: "ask_user", arguments: {} }],
    handlers,
  });
  assert.equal(missing.executed, false);
  assert.equal(missing.result.status, "error");
  assert.equal(missing.result.correctiveHint.includes("缺少 question（字符串）"), true);
});
