import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetReached,
  createSession,
  createTurn,
  hasWriteEffect,
  maxInlineToolTextBytes,
  parseRolloutEvent,
  parseToolResult,
  schemaVersion,
} from "../dist/index.js";

const createdAt = "2026-11-08T04:00:00.000Z";

function sessionInput() {
  return {
    id: "ses_note_summary",
    workspaceRoot: "D:/work/notes",
    createdAt,
    runtimeVersion: "0.0.0",
  };
}

test("schemaVersion 固定为 1，Phase 0 会话没有父会话", () => {
  assert.equal(schemaVersion, 1);
  const session = createSession(sessionInput());
  assert.equal(session.ok, true);
  if (!session.ok) {
    return;
  }
  assert.equal(session.value.schemaVersion, 1);
  assert.equal(session.value.parentSessionId, null);
  assert.deepEqual(createSession({ ...sessionInput(), id: "note" }), { ok: false, error: "session-id" });
  assert.deepEqual(createSession({ ...sessionInput(), parentSessionId: "ses_parent" }), {
    ok: false,
    error: "parent-session",
  });
});

test("Phase 0 只接受 plan 和 workspace-write", () => {
  const turn = createTurn({
    id: "trn_note_summary",
    sessionId: "ses_note_summary",
    input: { text: "阅读本目录的笔记，生成 summary.md" },
    mode: "workspace-write",
    budget: { maxToolCalls: 80 },
  });
  assert.equal(turn.ok, true);
  if (turn.ok) {
    assert.equal(turn.value.status, "running");
    assert.deepEqual(turn.value.consumed, {});
  }
  assert.equal(createTurn({
    id: "trn_note_summary",
    sessionId: "ses_note_summary",
    input: { text: "阅读笔记" },
    mode: "full",
    budget: {},
  }).ok, false);
});

test("工具调用次数达到上限时预算耗尽", () => {
  assert.equal(budgetReached({ maxToolCalls: 2 }, { toolCalls: 1 }), false);
  assert.equal(budgetReached({ maxToolCalls: 2 }, { toolCalls: 2 }), true);
  assert.equal(budgetReached({}, { toolCalls: 99 }), false);
});

test("拒绝的工具结果不能带写入副作用", () => {
  const denied = parseToolResult({
    status: "denied",
    content: [{ type: "text", text: "路径越界" }],
    artifacts: [],
    sideEffects: [{ kind: "write", target: "summary.md", summary: "不应写入" }],
    correctiveHint: "改读工作区内的文件",
  });
  assert.deepEqual(denied, { ok: false, error: "side-effect" });

  const written = parseToolResult({
    status: "ok",
    content: [{ type: "text", text: "已写入 summary.md" }],
    artifacts: [],
    sideEffects: [{ kind: "write", target: "summary.md", summary: "已写入 summary.md" }],
  });
  assert.equal(written.ok, true);
  if (written.ok) {
    assert.equal(hasWriteEffect(written.value), true);
  }
});

test("超过 32768 字节的工具文本必须改成落盘引用", () => {
  const text = "a".repeat(maxInlineToolTextBytes + 1);
  const inline = parseToolResult({
    status: "ok",
    content: [{ type: "text", text }],
    artifacts: [],
    sideEffects: [],
  });
  assert.deepEqual(inline, { ok: false, error: "tool-text" });

  const spilled = parseToolResult({
    status: "ok",
    content: [{ type: "text", text: "", bytes: text.length, storedAt: "blobs/call_write.txt" }],
    artifacts: [],
    sideEffects: [],
  });
  assert.equal(spilled.ok, true);
});

test("事件信封拒绝未知 schemaVersion 和 Phase 0 以外的类型", () => {
  const base = {
    schemaVersion: 1,
    seq: 1,
    time: createdAt,
    sessionId: "ses_note_summary",
    turnId: "trn_note_summary",
    type: "turn.completed",
    payload: { status: "budget_exhausted", text: "预算已用完", consumed: { toolCalls: 2 } },
  };
  const accepted = parseRolloutEvent(base);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.value.schemaVersion, 1);
  }
  assert.equal(parseRolloutEvent({ ...base, schemaVersion: 2 }).ok, false);
  assert.equal(parseRolloutEvent({ ...base, schemaVersion: 2 }).error, "schema-version");
  assert.equal(parseRolloutEvent({ ...base, type: "approval.requested" }).error, "event-type");
  assert.equal(parseRolloutEvent({
    ...base,
    type: "turn.started",
    payload: { input: { text: "阅读笔记" }, mode: "full", budget: {} },
  }).error, "mode");
});
