import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findUnredacted, fixtureSecret, readRollout, redact } from "./rollout.mjs";

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../evals/fixtures/rollout");

test("半行被丢弃，前面的完整步骤仍在", () => {
  const result = readRollout(fs.readFileSync(path.join(fixtureDir, "partial-line.jsonl"), "utf8"));
  assert.equal(result.discardedPartial, true);
  assert.deepEqual(result.events.map((event) => event.seq), [1, 2]);
  assert.equal(result.canResume, true);
});

test("断号拒绝恢复且不重放", () => {
  const result = readRollout(fs.readFileSync(path.join(fixtureDir, "gap.jsonl"), "utf8"));
  assert.equal(result.error, "seq-gap");
  assert.equal(result.exitCode, 1);
  assert.equal(result.canResume, false);
});

test("未打码的假密钥会被检出，打码后消失", () => {
  const raw = fs.readFileSync(path.join(fixtureDir, "secret.jsonl"), "utf8");
  assert.equal(findUnredacted(raw, fixtureSecret), true);
  assert.equal(findUnredacted(redact(raw, fixtureSecret), fixtureSecret), false);
});

test("合法轨迹可以恢复", () => {
  const result = readRollout(fs.readFileSync(path.join(fixtureDir, "valid.jsonl"), "utf8"));
  assert.equal(result.error, null);
  assert.deepEqual(result.events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(result.canResume, true);
});

test("未知 schemaVersion 不改写也不恢复", () => {
  const result = readRollout(`${JSON.stringify({ schemaVersion: 2, seq: 1, type: "turn.started", payload: {} })}\n`);
  assert.equal(result.error, "schema-version");
  assert.equal(result.exitCode, 1);
  assert.equal(result.canResume, false);
});
