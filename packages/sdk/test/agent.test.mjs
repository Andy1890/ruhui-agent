import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Agent } from "../agent-node.mjs";
import { sdkEventsFor } from "../dist/index.js";

const notes = fileURLToPath(new URL("../../../evals/fixtures/notes", import.meta.url));
const protocolTypes = new Set(["turn.started", "message.delta", "tool.started", "tool.finished", "user.requested", "turn.completed"]);
const finalText = "发布日期为 2026-12-01，负责人为周宁。";

test("回合结束时先给出文本增量，再给出终态", () => {
  const events = sdkEventsFor({
    type: "turn.completed",
    sessionId: "ses_note",
    turnId: "trn_note",
    payload: { status: "completed", text: finalText },
  });
  assert.deepEqual(events.map((event) => event.type), ["message.delta", "turn.completed"]);
  assert.equal(events[0].text, finalText);
  assert.equal(events[1].status, "completed");
});

test("plan 模式的 run 返回最终文本，stream 交出成对的工具事件", async () => {
  const fixture = stage();
  try {
    const script = [
      { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." } },
      { type: "tool", callId: "call_read", name: "read_file", arguments: { path: "2026-11-01.md" } },
      { type: "text", text: finalText },
    ];
    const agent = new Agent({ workspace: fixture.workspace, home: fixture.home, mode: "plan", script });
    const events = [];
    for await (const event of agent.stream("阅读本目录的笔记")) {
      events.push(event);
    }
    assert.equal(events.every((event) => protocolTypes.has(event.type)), true);
    const started = events.filter((event) => event.type === "tool.started");
    const finished = events.filter((event) => event.type === "tool.finished");
    assert.equal(started.length >= 1, true);
    for (const start of started) {
      const end = finished.find((event) => event.callId === start.callId);
      assert.equal(end?.name, start.name);
      assert.equal(typeof end?.result.status, "string");
    }
    const read = finished.find((event) => event.name === "read_file");
    assert.equal(JSON.stringify(read.result).includes("周宁"), true);
    const delta = events.find((event) => event.type === "message.delta");
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(delta.text, finalText);
    assert.equal(completed.status, "completed");
    assert.equal(completed.text, finalText);
    assert.equal(events.indexOf(delta) < events.indexOf(completed), true);
    assert.equal(fs.existsSync(path.join(fixture.workspace, "summary.md")), false);

    const result = await new Agent({ workspace: fixture.workspace, home: fixture.home, mode: "plan", script }).run("阅读本目录的笔记");
    assert.equal(result.text, finalText);
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(/^ses_[A-Za-z0-9_]+$/.test(result.sessionId), true);
  } finally {
    fixture.cleanup();
  }
});

test("ask_user 只请求回答，full 不能通过 SDK 放行", async () => {
  const fixture = stage();
  try {
    const asking = new Agent({
      workspace: fixture.workspace,
      home: fixture.home,
      mode: "plan",
      script: [{ type: "tool", callId: "call_ask", name: "ask_user", arguments: { question: "摘要使用哪个标题？" } }],
    });
    const events = [];
    for await (const event of asking.stream("确认标题")) {
      events.push(event);
    }
    const requested = events.find((event) => event.type === "user.requested");
    assert.equal(requested.question, "摘要使用哪个标题？");
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
    const result = await new Agent({
      workspace: fixture.workspace,
      home: fixture.home,
      mode: "plan",
      script: [{ type: "tool", callId: "call_ask", name: "ask_user", arguments: { question: "摘要使用哪个标题？" } }],
    }).run("确认标题");
    assert.equal(result.status, "waiting_user");
    assert.equal(result.exitCode, 3);
    assert.equal(result.text, "摘要使用哪个标题？");
    await assert.rejects(
      () => new Agent({ workspace: fixture.workspace, home: fixture.home, mode: "full", script: [] }).run("看一眼"),
      /Phase 1/,
    );
  } finally {
    fixture.cleanup();
  }
});

function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-sdk-"));
  const workspace = path.join(root, "notes");
  const home = path.join(root, "home");
  fs.mkdirSync(workspace);
  fs.copyFileSync(path.join(notes, "2026-11-01.md"), path.join(workspace, "2026-11-01.md"));
  fs.copyFileSync(path.join(notes, "2026-11-02.md"), path.join(workspace, "2026-11-02.md"));
  return {
    workspace,
    home,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
