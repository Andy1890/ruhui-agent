import assert from "node:assert/strict";
import test from "node:test";
import { createScriptedProvider } from "../dist/index.js";

const notesScript = [
  { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." } },
  { type: "tool", callId: "call_read_1", name: "read_file", arguments: { path: "2026-11-01.md" } },
  { type: "tool", callId: "call_read_2", name: "read_file", arguments: { path: "2026-11-02.md" } },
  {
    type: "tool",
    callId: "call_write",
    name: "write_file",
    arguments: { path: "summary.md", content: "发布日期 2026-12-01，负责人周宁，预算 2 万元" },
  },
  { type: "text", text: "已生成 summary.md。发布日期为 2026-12-01，负责人为周宁，预算上限为 2 万元。" },
];

async function play(provider, turns, request = { messages: [{ role: "user", text: "阅读笔记" }] }) {
  const events = [];
  const signal = { aborted: false };
  for (let index = 0; index < turns; index += 1) {
    for await (const event of provider.complete(request, signal)) {
      events.push(event);
    }
  }
  return events;
}

test("同一脚本两次回放的事件完全相同", async () => {
  const first = await play(createScriptedProvider(notesScript), notesScript.length);
  const second = await play(createScriptedProvider(notesScript), notesScript.length, {
    messages: [{ role: "user", text: "另一段提示" }],
  });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.filter((event) => event.type === "tool_call").map((event) => event.call.name),
    ["list_dir", "read_file", "read_file", "write_file"],
  );
  assert.equal(first.at(-2).type, "text");
  assert.equal(first.at(-1).type, "done");
});

test("缺 content 的工具调用按脚本原样返回", async () => {
  const provider = createScriptedProvider([
    { type: "tool", callId: "call_write", name: "write_file", arguments: { path: "summary.md" } },
    { type: "text", text: "已停止。没有写入 summary.md。" },
  ]);
  const events = await play(provider, 2);
  const call = events.find((event) => event.type === "tool_call");
  assert.deepEqual(call.call.arguments, { path: "summary.md" });
  assert.equal(Object.hasOwn(call.call.arguments, "content"), false);
});

test("脚本用尽和取消都给出固定错误，不发明新输出", async () => {
  const provider = createScriptedProvider([{ type: "text", text: "只有一步" }]);
  await play(provider, 1);
  const exhausted = [];
  for await (const event of provider.complete({ messages: [] }, { aborted: false })) {
    exhausted.push(event);
  }
  assert.deepEqual(exhausted, [
    { type: "error", code: "script_exhausted" },
    { type: "done" },
  ]);

  const aborted = [];
  for await (const event of createScriptedProvider(notesScript).complete({ messages: [] }, { aborted: true })) {
    aborted.push(event);
  }
  assert.deepEqual(aborted, [{ type: "error", code: "aborted" }]);
});

test("不支持工具时不发出工具调用", async () => {
  const provider = createScriptedProvider(notesScript, { supportsTools: false });
  const events = [];
  for await (const event of provider.complete({ messages: [] }, { aborted: false })) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "error", code: "tools_required" },
    { type: "done" },
  ]);
  assert.equal(events.some((event) => event.type === "tool_call"), false);
});
