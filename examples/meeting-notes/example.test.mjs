import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runtimeVersion } from "../../packages/sdk/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "run.mjs");

test("会议笔记示例用假模型离线写出三则事实，doctor 显示 path-jail", async () => {
  const source = fs.readFileSync(runner, "utf8");
  assert.equal(source.includes("RUHUI_PROVIDER"), true);
  assert.equal(source.includes("scripted"), true);
  assert.equal(source.includes("pub.rh.agent.tools"), false);
  assert.equal(source.includes("内核沙箱"), false);
  const result = await runExample();
  assert.equal(result.code, 0, result.output);
  assert.equal(result.stdout.includes(`版本 ${runtimeVersion}`), true);
  assert.equal(result.stdout.includes("模式 plan"), true);
  assert.equal(result.stdout.includes("模式 workspace-write"), true);
  assert.equal(result.stdout.includes("沙箱 path-jail"), true);
  assert.equal(result.stdout.includes("内核沙箱"), false);
  assert.equal(result.stdout.includes("read_file path=2026-11-01.md"), true);
  assert.equal(result.stdout.includes("read_file path=2026-11-02.md"), true);
  assert.equal(result.stdout.includes("已生成 summary.md。发布日期为 2026-12-01，负责人为周宁，预算上限为 2 万元。"), true);
  const summaryLine = result.stdout.split("\n").find((line) => line.startsWith("摘要 "));
  assert.equal(typeof summaryLine, "string");
  const summary = fs.readFileSync(summaryLine.slice("摘要 ".length), "utf8");
  for (const fact of ["2026-12-01", "周宁", "2 万元"]) {
    assert.equal(summary.includes(fact), true, summary);
  }
  assert.equal(fs.existsSync(path.join(here, "summary.md")), false);
});

function runExample() {
  const child = spawn(process.execPath, [runner], { cwd: here, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), 15000);
  return once(child, "exit").then(([code]) => {
    clearTimeout(timer);
    return { code, stdout, stderr, output: `${stdout}\n${stderr}` };
  });
}
