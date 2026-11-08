import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nodeProcessAlive, nodeSessionFiles } from "../rollout-node.mjs";
import { maxInlineToolTextBytes, openRollout, readRollout } from "../dist/index.js";

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/fixtures/rollout");
const fixtureSecret = "sk-test-fixture-not-a-secret";
const now = "2026-11-08T04:00:00.000Z";

function memoryFiles(initial = {}) {
  const files = new Map(Object.entries(initial));
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

function openMemory(files, overrides = {}) {
  return openRollout({
    files,
    sessionId: "ses_fixture",
    pid: 11,
    isAlive: () => false,
    now,
    secrets: [fixtureSecret],
    ...overrides,
  });
}

test("夹具：半行丢弃、断号拒绝、未知版本不改写、成功写入不重放", () => {
  const partial = readRollout(fs.readFileSync(path.join(fixtureDir, "partial-line.jsonl"), "utf8"));
  assert.equal(partial.discardedPartial, true);
  assert.deepEqual(partial.events.map((event) => event.seq), [1, 2]);
  assert.equal(partial.canResume, true);

  const gapText = fs.readFileSync(path.join(fixtureDir, "gap.jsonl"), "utf8");
  const gapFiles = memoryFiles({ "rollout.jsonl": gapText });
  const gap = openMemory(gapFiles);
  assert.equal(gap.ok, false);
  if (!gap.ok) {
    assert.equal(gap.error, "seq-gap");
  }
  assert.equal(gapFiles.files.get("rollout.jsonl"), gapText);
  assert.equal(gapFiles.files.has("writer.lock"), false);

  const unknownText = `${JSON.stringify({ schemaVersion: 2, seq: 1, type: "turn.started", payload: {} })}\n`;
  const unknownFiles = memoryFiles({ "rollout.jsonl": unknownText });
  const unknown = openMemory(unknownFiles);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error, "schema-version");
  }
  assert.equal(unknownFiles.files.get("rollout.jsonl"), unknownText);

  const valid = readRollout(fs.readFileSync(path.join(fixtureDir, "valid.jsonl"), "utf8"));
  assert.deepEqual(valid.skipCalls, ["call_write"]);
  assert.deepEqual(valid.retryCalls, []);
});

test("活着的写入者会挡住第二个进程，退出的进程可以接管", () => {
  const files = memoryFiles();
  const first = openMemory(files, { pid: 10, isAlive: (pid) => pid === 10 });
  assert.equal(first.ok, true);
  const blocked = openMemory(files, { pid: 11, isAlive: (pid) => pid === 10 });
  assert.deepEqual(blocked, { ok: false, error: "locked" });
  const taken = openMemory(files, { pid: 11, isAlive: () => false });
  assert.equal(taken.ok, true);
  if (first.ok) {
    first.value.release();
  }
  if (taken.ok) {
    taken.value.release();
  }
  assert.equal(files.files.has("writer.lock"), false);
});

test("追加前打码，超长文本落到 blobs，半行被截掉后再续写", () => {
  const partial = `${fs.readFileSync(path.join(fixtureDir, "partial-line.jsonl"), "utf8")}`;
  const files = memoryFiles({ "rollout.jsonl": partial });
  const opened = openMemory(files);
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    return;
  }
  assert.equal(files.files.get("rollout.jsonl").endsWith("\n"), true);
  assert.equal(files.files.get("rollout.jsonl").includes("partial"), false);
  const secret = opened.value.append({
    time: "2026-11-08T04:00:03.000Z",
    sessionId: "ses_fixture",
    turnId: "trn_fixture",
    type: "tool.finished",
    payload: {
      callId: "call_read",
      name: "read_file",
      policy: { decision: "allow" },
      result: {
        status: "ok",
        content: [{ type: "text", text: `token ${fixtureSecret}` }],
        artifacts: [],
        sideEffects: [],
      },
    },
  });
  assert.equal(secret.ok, true);
  const stored = files.files.get("rollout.jsonl");
  assert.equal(stored.includes(fixtureSecret), false);
  assert.equal(stored.includes("[redacted]"), true);
  assert.equal(stored.trim().split("\n").at(-1).includes('"seq":3'), true);

  const huge = "a".repeat(maxInlineToolTextBytes + 1);
  const spilled = opened.value.append({
    time: "2026-11-08T04:00:04.000Z",
    sessionId: "ses_fixture",
    turnId: "trn_fixture",
    type: "tool.finished",
    payload: {
      callId: "call_log",
      name: "read_file",
      policy: { decision: "allow" },
      result: { status: "ok", content: [{ type: "text", text: huge }], artifacts: [], sideEffects: [] },
    },
  });
  assert.equal(spilled.ok, true);
  assert.equal(files.files.get("blobs/call_log.txt"), huge);
  assert.equal(files.files.get("rollout.jsonl").includes(huge), false);
  opened.value.release();
});

test("真实目录里的轨迹也不保留密钥原文", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-rollout-"));
  try {
    assert.equal(nodeProcessAlive(process.pid), true);
    const opened = openRollout({
      files: nodeSessionFiles(root),
      sessionId: "ses_fixture",
      pid: process.pid,
      isAlive: nodeProcessAlive,
      now,
      secrets: [fixtureSecret],
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) {
      return;
    }
    opened.value.append({
      time: now,
      sessionId: "ses_fixture",
      turnId: "trn_fixture",
      type: "turn.started",
      payload: { input: { text: fixtureSecret }, mode: "plan", budget: {} },
    });
    const text = fs.readFileSync(path.join(root, "rollout.jsonl"), "utf8");
    assert.equal(text.includes(fixtureSecret), false);
    assert.equal(text.includes("[redacted]"), true);
    opened.value.release();
    assert.equal(fs.existsSync(path.join(root, "writer.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
