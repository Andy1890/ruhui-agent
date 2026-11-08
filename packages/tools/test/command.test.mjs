import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { containPath, sandboxBackend } from "../../sandbox/dist/index.js";
import { nodePathLook } from "../../sandbox/path-jail-node.mjs";
import { commandSandboxBackend, createCommandHandlers } from "../dist/index.js";
import { nodeCommandTools } from "../command-node.mjs";
import { executeToolBatch } from "../dist/index.js";

const formatHint = "拒绝执行该命令：禁止格式化磁盘或修改分区。命令未执行。";
const sshHint = "拒绝执行该命令：禁止读取 SSH 私钥目录。命令未执行。";
const deleteHint = "拒绝执行该命令：禁止递归删除工作区外的路径。命令未执行。";

function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-command-"));
  const dir = path.join(root, "notes");
  fs.mkdirSync(dir);
  return { root, dir };
}

function handlersFor(dir, runner, timeoutMs) {
  const look = nodePathLook();
  return createCommandHandlers({
    cwd: dir,
    timeoutMs,
    resolve(requested) {
      return containPath(dir, requested, look);
    },
    runner,
  });
}

function recordingRunner(calls) {
  return {
    async run(request) {
      calls.push(request);
      return { kind: "exit", code: 0, stdout: "ok", stderr: "", stdoutBytes: 2, stderrBytes: 0 };
    },
  };
}

function assertNoBypass(result) {
  const text = `${textOf(result)}\n${result.correctiveHint ?? ""}`.toLowerCase();
  assert.equal(text.includes("编码"), false);
  assert.equal(text.includes("空格"), false);
  assert.equal(text.includes("分隔"), false);
  assert.equal(text.includes("base64"), false);
}

test("沙箱标记是 path-jail，命令实现不宣称内核沙箱", () => {
  assert.equal(commandSandboxBackend, "path-jail");
  assert.equal(commandSandboxBackend, sandboxBackend);
  const source = fs.readFileSync(new URL("../src/command.ts", import.meta.url), "utf8");
  const adapter = fs.readFileSync(new URL("../command-node.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("node:"), false);
  assert.equal(adapter.includes("shell: false"), true);
  assert.equal(adapter.includes("shell: true"), false);
  assert.equal(adapter.includes('.join(" ")'), false);
  for (const text of [source, adapter]) {
    assert.equal(text.includes("内核沙箱"), false);
    assert.equal(text.includes("操作系统沙箱"), false);
    assert.equal(text.includes("bubblewrap"), false);
    assert.equal(text.includes("landlock"), false);
    assert.equal(text.includes("seatbelt"), false);
  }
});

test("格式化磁盘、SSH 私钥和区外递归删除在启动前拒绝", async () => {
  const { root, dir } = workspace();
  const calls = [];
  const handlers = handlersFor(dir, recordingRunner(calls));
  const outside = path.resolve(dir, "..", "outside-delete");
  try {
    const format = await handlers.execute_command({
      callId: "format",
      name: "execute_command",
      arguments: { args: ["format.com", "E:"] },
    });
    const spaced = await handlers.execute_command({
      callId: "format-space",
      name: "execute_command",
      arguments: { args: [" format.com ", " E: "] },
    });
    const wrapped = await handlers.execute_command({
      callId: "format-wrap",
      name: "execute_command",
      arguments: { args: ["cmd", "/c", "format.com    E:"] },
    });
    const ssh = await handlers.execute_command({
      callId: "ssh",
      name: "execute_command",
      arguments: { args: ["type", "C:\\Users\\me\\.ssh\\id_rsa"] },
    });
    const sshSlash = await handlers.execute_command({
      callId: "ssh-slash",
      name: "execute_command",
      arguments: { args: ["type", "  C:/Users/me/.ssh/id_rsa  "] },
    });
    const removed = await handlers.execute_command({
      callId: "rm",
      name: "execute_command",
      arguments: { args: ["rm", "-rf", outside] },
    });
    const splitFlags = await handlers.execute_command({
      callId: "rm-split",
      name: "execute_command",
      arguments: { args: ["rm", "-r", "-f", `  ${outside}  `] },
    });
    const oneLine = await handlers.execute_command({
      callId: "rm-line",
      name: "execute_command",
      arguments: { args: [`rm   -rf   ${outside}`] },
    });
    assert.equal(format.status, "denied");
    assert.equal(format.correctiveHint, formatHint);
    assert.equal(spaced.correctiveHint, formatHint);
    assert.equal(wrapped.correctiveHint, formatHint);
    assert.equal(ssh.correctiveHint, sshHint);
    assert.equal(sshSlash.correctiveHint, sshHint);
    assert.equal(removed.correctiveHint, deleteHint);
    assert.equal(splitFlags.correctiveHint, deleteHint);
    assert.equal(oneLine.correctiveHint, deleteHint);
    for (const result of [format, spaced, wrapped, ssh, sshSlash, removed, splitFlags, oneLine]) {
      assertNoBypass(result);
    }
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("工作区内的递归删除仍按参数数组启动，且默认不经过外壳", async () => {
  const { root, dir } = workspace();
  const calls = [];
  const handlers = handlersFor(dir, recordingRunner(calls));
  try {
    const result = await handlers.execute_command({
      callId: "inside",
      name: "execute_command",
      arguments: { args: ["rm", "-rf", "nested"] },
    });
    const script = await handlers.execute_command({
      callId: "pwsh",
      name: "execute_command",
      arguments: { args: ["Get-ChildItem"], shell: "pwsh" },
    });
    const splitScript = await handlers.execute_command({
      callId: "pwsh-split",
      name: "execute_command",
      arguments: { args: ["Get-ChildItem", "."], shell: "pwsh" },
    });
    assert.equal(result.status, "ok");
    assert.equal(textOf(result).includes("沙箱 path-jail"), true);
    assert.equal(textOf(result).includes("内核"), false);
    assert.equal(calls[0].file, "rm");
    assert.deepEqual(calls[0].args, ["-rf", "nested"]);
    assert.equal(calls[0].cwd, dir);
    assert.equal(calls[0].timeoutMs, 30000);
    assert.equal(Object.hasOwn(calls[0], "shell"), false);
    assert.equal(script.status, "ok");
    assert.equal(calls[1].file, "pwsh");
    assert.deepEqual(calls[1].args, ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"]);
    assert.equal(splitScript.status, "error");
    assert.equal(splitScript.correctiveHint.includes("单独参数"), true);
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("E4：非零退出保留截断后的 stderr 和纠正提示，调用本身不抛出", async () => {
  const { root, dir } = workspace();
  const stderr = "e".repeat(40000);
  const handlers = handlersFor(dir, {
    async run() {
      return { kind: "exit", code: 1, stdout: "", stderr, stdoutBytes: 0, stderrBytes: 40000 };
    },
  });
  try {
    const [outcome] = await executeToolBatch({
      mode: "workspace-write",
      calls: [{ callId: "e4", name: "execute_command", arguments: { args: ["node", "-e", "process.exit(1)"] } }],
      handlers,
    });
    const text = textOf(outcome.result);
    assert.equal(outcome.result.status, "error");
    assert.equal(text.includes("已截断"), true);
    assert.equal(text.includes("40000"), true);
    assert.equal(text.length < stderr.length, true);
    assert.equal(outcome.result.correctiveHint.includes("读取"), true);
    assert.equal(text.includes("沙箱 path-jail"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("超时结果写明运行时长，并说明进程已终止", async () => {
  const { root, dir } = workspace();
  const handlers = handlersFor(dir, {
    async run() {
      return { kind: "timeout", elapsedMs: 30000, stdout: "", stderr: "" };
    },
  });
  try {
    const result = await handlers.execute_command({
      callId: "timeout",
      name: "execute_command",
      arguments: { args: ["node", "-e", "setInterval(() => {}, 1000)"] },
    });
    const text = textOf(result);
    assert.equal(result.status, "timeout");
    assert.equal(text.includes("30000"), true);
    assert.equal(text.includes("进程已终止"), true);
    assert.equal(text.includes("沙箱 path-jail"), true);
    assert.equal(text.includes("内核"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("真实进程按参数数组执行，非零退出和超时都不抛出", async () => {
  const { root, dir } = workspace();
  try {
    const node = process.execPath;
    const tools = nodeCommandTools(dir);
    const failed = await tools.handlers.execute_command({
      callId: "real-e4",
      name: "execute_command",
      arguments: { args: [node, "-e", "process.stderr.write('missing-file'); process.exit(1)"] },
    });
    const timed = nodeCommandTools(dir, { timeoutMs: 500 });
    const started = Date.now();
    const timeout = await timed.handlers.execute_command({
      callId: "real-timeout",
      name: "execute_command",
      arguments: { args: [node, "-e", "setInterval(() => {}, 1000)"] },
    });
    assert.equal(failed.status, "error");
    assert.equal(textOf(failed).includes("missing-file"), true);
    assert.equal(failed.correctiveHint.includes("读取"), true);
    assert.equal(textOf(failed).includes("沙箱 path-jail"), true);
    assert.equal(timeout.status, "timeout");
    assert.equal(textOf(timeout).includes("进程已终止"), true);
    assert.equal(Date.now() - started < 8000, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
