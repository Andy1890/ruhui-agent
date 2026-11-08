import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand, phase1ModeText, resolveMode, runtimeVersion } from "../../sdk/dist/index.js";

const cli = fileURLToPath(new URL("../ruhui.mjs", import.meta.url));
const notes = fileURLToPath(new URL("../../../evals/fixtures/notes", import.meta.url));
const finalText = "已生成 summary.md。发布日期为 2026-12-01，负责人为周宁，预算上限为 2 万元。";
const summaryBody = ["# 笔记摘要", "", "- 发布日期：2026-12-01", "- 负责人：周宁", "- 预算上限：2 万元，不包含差旅。", ""].join("\n");
const hint = "参数不符合 write_file 的 schema：缺少 content（字符串）。文件未被写入。请补全参数后重试。";

test("用法错误返回 2，default 和 full 留到 Phase 1", () => {
  assert.equal(parseCommand([]).exitCode, 2);
  assert.equal(parseCommand(["run"]).exitCode, 2);
  assert.equal(parseCommand(["resume"]).exitCode, 2);
  assert.equal(parseCommand(["run", "--mode", "full", "任务"]).text.includes(phase1ModeText), true);
  assert.equal(parseCommand(["doctor", "--mode", "default"]).text.includes(phase1ModeText), true);
  assert.equal(parseCommand(["run", "--mode", "workspace-write", "阅读笔记"]).kind, "run");
  assert.deepEqual(resolveMode({ project: "workspace-write" }), { ok: true, mode: "plan" });
  assert.deepEqual(resolveMode({ cli: "workspace-write", project: "plan" }), { ok: true, mode: "workspace-write" });
  assert.deepEqual(resolveMode({ user: "workspace-write", project: "plan" }), { ok: true, mode: "plan" });
});

test("命令入口不直接引用工具包，也不把沙箱叫成内核沙箱", () => {
  const entry = fs.readFileSync(new URL("../ruhui.mjs", import.meta.url), "utf8");
  const agent = fs.readFileSync(new URL("../../sdk/agent-node.mjs", import.meta.url), "utf8");
  assert.equal(entry.includes("pub.rh.agent.tools"), false);
  assert.equal(entry.includes("/tools/"), false);
  for (const source of [entry, agent]) {
    assert.equal(source.includes("内核沙箱"), false);
    assert.equal(source.includes("操作系统沙箱"), false);
    assert.equal(source.includes("bubblewrap"), false);
    assert.equal(source.includes("landlock"), false);
    assert.equal(source.includes("seatbelt"), false);
  }
});

test("doctor 打印版本、工作区、模式和 path-jail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-doctor-"));
  try {
    const listed = await runCli(["doctor"], { cwd: root, env: { RUHUI_HOME: path.join(root, "home") } });
    assert.equal(listed.code, 0, listed.output);
    assert.equal(listed.stdout.includes(`版本 ${runtimeVersion}`), true);
    assert.equal(listed.stdout.includes(`工作区 ${root}`), true);
    assert.equal(listed.stdout.includes("模式 plan"), true);
    assert.equal(listed.stdout.includes("沙箱 path-jail"), true);
    assert.equal(listed.stdout.includes("内核沙箱"), false);
    const selected = await runCli(["doctor", "--mode", "workspace-write"], { cwd: root, env: { RUHUI_HOME: path.join(root, "home") } });
    assert.equal(selected.code, 0, selected.output);
    assert.equal(selected.stdout.includes("模式 workspace-write"), true);
    const rejected = await runCli(["doctor", "--mode", "full"], { cwd: root });
    assert.equal(rejected.code, 2, rejected.output);
    assert.equal(rejected.stderr.includes(phase1ModeText), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("笔记摘要写出三则事实", async () => {
  const fixture = await stage();
  try {
    const script = writeScript(fixture.home, "summary.json", notesScript(summaryBody, finalText));
    const result = await runCli(["run", "--mode", "workspace-write", "--session", "ses_note_summary", "阅读本目录的笔记，生成 summary.md"], {
      cwd: fixture.workspace,
      env: scripted(fixture.home, script),
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout.includes("会话 ses_note_summary"), true);
    assert.equal(result.stdout.includes("模式 workspace-write"), true);
    assert.equal(result.stdout.includes("沙箱 path-jail"), true);
    assert.equal(result.stdout.includes("list_dir path=."), true);
    assert.equal(result.stdout.includes("ok  2 个条目"), true);
    assert.equal(result.stdout.includes("read_file path=2026-11-01.md"), true);
    assert.equal(result.stdout.includes("已读取"), true);
    assert.equal(result.stdout.includes("write_file path=summary.md"), true);
    assert.equal(result.stdout.includes("已写入 summary.md"), true);
    assert.equal(result.stdout.includes(finalText), true);
    const body = fs.readFileSync(path.join(fixture.workspace, "summary.md"), "utf8");
    for (const fact of ["2026-12-01", "周宁", "2 万元"]) {
      assert.equal(body.includes(fact), true, body);
    }
  } finally {
    fixture.cleanup();
  }
});

test("缺少 content 时不写文件，模型仍收到 schema 提示", async () => {
  const fixture = await stage();
  try {
    fs.writeFileSync(path.join(fixture.workspace, "keep.txt"), "keep-me\n");
    const script = writeScript(fixture.home, "missing.json", [
      { type: "tool", callId: "call_write", name: "write_file", arguments: { path: "summary.md" } },
      { type: "text", text: "已停止。没有写入 summary.md。" },
    ]);
    const result = await runCli(["run", "--mode", "workspace-write", "--session", "ses_missing", "把摘要写入 summary.md"], {
      cwd: fixture.workspace,
      env: scripted(fixture.home, script),
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout.includes("write_file 失败：缺少字段 content。文件未被写入。"), true, result.stdout);
    assert.equal(result.stdout.includes("已停止。没有写入 summary.md。"), true, result.stdout);
    assert.equal(fs.existsSync(path.join(fixture.workspace, "summary.md")), false);
    assert.equal(fs.readFileSync(path.join(fixture.workspace, "keep.txt"), "utf8"), "keep-me\n");
    assert.equal(rolloutText(fixture.home, "ses_missing").includes(hint), true);
  } finally {
    fixture.cleanup();
  }
});

test("越界读取被拒绝，正文不出现在终端", async () => {
  const fixture = await stage();
  try {
    const secret = path.join(fixture.root, "outside-secret.txt");
    fs.writeFileSync(secret, "OUTSIDE-SECRET-BODY\n");
    const script = writeScript(fixture.home, "outside.json", [
      { type: "tool", callId: "call_read", name: "read_file", arguments: { path: secret } },
      { type: "text", text: "已拒绝区外读取。" },
    ]);
    const result = await runCli(["run", "--mode", "plan", "--session", "ses_outside", "读取工作区外的 outside-secret.txt"], {
      cwd: fixture.workspace,
      env: scripted(fixture.home, script),
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout.includes(`拒绝读取工作区外的路径：${secret}`), true, result.stdout);
    assert.equal(result.stdout.includes("请改用工作区内的相对路径。"), true);
    assert.equal(result.stdout.includes("绝对路径再试"), false);
    assert.equal(result.stdout.includes("OUTSIDE-SECRET-BODY"), false);
  } finally {
    fixture.cleanup();
  }
});

test("危险命令在执行前拒绝", async () => {
  const fixture = await stage();
  try {
    const script = writeScript(fixture.home, "danger.json", [
      { type: "tool", callId: "call_format", name: "execute_command", arguments: { args: ["format.com", "E:"] } },
      { type: "tool", callId: "call_ssh", name: "execute_command", arguments: { args: ["type", "C:\\Users\\me\\.ssh\\id_rsa"] } },
      { type: "text", text: "两条命令都已拒绝。" },
    ]);
    const result = await runCli(["run", "--mode", "workspace-write", "--session", "ses_danger", "格式化 E:，并读出 SSH 私钥"], {
      cwd: fixture.workspace,
      env: scripted(fixture.home, script),
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout.includes('execute_command args=["format.com","E:"]'), true, result.stdout);
    assert.equal(result.stdout.includes("拒绝执行该命令：禁止格式化磁盘或修改分区。命令未执行。"), true);
    assert.equal(result.stdout.includes('execute_command args=["type","C:\\\\Users\\\\me\\\\.ssh\\\\id_rsa"]'), true, result.stdout);
    assert.equal(result.stdout.includes("拒绝执行该命令：禁止读取 SSH 私钥目录。命令未执行。"), true);
    assert.equal(result.stdout.includes("编码"), false);
  } finally {
    fixture.cleanup();
  }
});

test("中断后可以恢复，已完成的写入不重复执行", async () => {
  const fixture = await stage();
  try {
    const firstScript = writeScript(fixture.home, "first.json", notesScript(summaryBody, finalText));
    const first = await runCli(["run", "--mode", "workspace-write", "--session", "ses_note_summary", "阅读本目录的笔记，生成 summary.md"], {
      cwd: fixture.workspace,
      env: { ...scripted(fixture.home, firstScript), RUHUI_ABORT_AFTER: "write_file" },
    });
    assert.equal(first.code, 5, first.output);
    assert.equal(first.stdout.includes("已中断。会话 ses_note_summary 可恢复。"), true, first.stdout);
    const summaryPath = path.join(fixture.workspace, "summary.md");
    const written = fs.readFileSync(summaryPath, "utf8");
    for (const fact of ["2026-12-01", "周宁", "2 万元"]) {
      assert.equal(written.includes(fact), true, written);
    }
    const before = readEvents(fixture.home, "ses_note_summary");
    assert.deepEqual(before.map((event) => event.seq), before.map((_, index) => index + 1));
    const secondScript = writeScript(fixture.home, "second.json", [
      { type: "tool", callId: "call_write_again", name: "write_file", arguments: { path: "summary.md", content: "SECOND-WRITE" } },
      { type: "text", text: finalText },
    ]);
    const second = await runCli(["resume", "ses_note_summary"], {
      cwd: fixture.root,
      env: scripted(fixture.home, secondScript),
    });
    assert.equal(second.code, 0, second.output);
    assert.equal(second.stdout.includes(`已恢复会话 ses_note_summary，从 seq=${before.length} 继续。`), true, second.stdout);
    assert.equal(second.stdout.includes("已跳过已完成的 write_file path=summary.md。"), true, second.stdout);
    assert.equal(second.stdout.includes(finalText), true, second.stdout);
    assert.equal(fs.readFileSync(summaryPath, "utf8"), written);
    assert.equal(fs.readFileSync(summaryPath, "utf8").includes("SECOND-WRITE"), false);
    const after = readEvents(fixture.home, "ses_note_summary");
    assert.deepEqual(after.map((event) => event.seq), after.map((_, index) => index + 1));
    assert.equal(after.length > before.length, true);
  } finally {
    fixture.cleanup();
  }
});

test("工具预算用尽时退出码是 4，并且不开始第三次调用", async () => {
  const fixture = await stage();
  try {
    const script = writeScript(fixture.home, "budget.json", [
      { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." } },
      { type: "tool", callId: "call_read_a", name: "read_file", arguments: { path: "2026-11-01.md" } },
      { type: "tool", callId: "call_read_b", name: "read_file", arguments: { path: "2026-11-02.md" } },
      { type: "text", text: "预算已用尽：工具调用 2/2。\n已完成：列出目录，并读取 2026-11-01.md。\n未完成：尚未读取 2026-11-02.md，尚未写入 summary.md。" },
    ]);
    const result = await runCli(["run", "--mode", "workspace-write", "--max-tool-calls", "2", "--session", "ses_budget", "阅读本目录的笔记，生成 summary.md"], {
      cwd: fixture.workspace,
      env: scripted(fixture.home, script),
    });
    assert.equal(result.code, 4, result.output);
    assert.equal(result.stdout.includes("预算已用尽：工具调用 2/2。"), true, result.stdout);
    assert.equal(result.stdout.includes("已完成：列出目录，并读取 2026-11-01.md。"), true);
    assert.equal(result.stdout.includes("未完成：尚未读取 2026-11-02.md，尚未写入 summary.md。"), true);
    assert.equal(fs.existsSync(path.join(fixture.workspace, "summary.md")), false);
    const started = readEvents(fixture.home, "ses_budget").filter((event) => event.type === "tool.started");
    assert.equal(started.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("ask_user 让进程以 3 退出，项目配置不能把 plan 放宽", async () => {
  const fixture = await stage();
  try {
    const ask = writeScript(fixture.home, "ask.json", [
      { type: "tool", callId: "call_ask", name: "ask_user", arguments: { question: "摘要使用哪个标题？" } },
    ]);
    const asked = await runCli(["run", "--mode", "plan", "--session", "ses_ask", "确认标题"], {
      cwd: fixture.workspace,
      env: scripted(fixture.home, ask),
    });
    assert.equal(asked.code, 3, asked.output);
    assert.equal(asked.stdout.includes("摘要使用哪个标题？"), true, asked.stdout);
    fs.mkdirSync(path.join(fixture.workspace, ".ruhui"), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, ".ruhui", "config.json"), `${JSON.stringify({ mode: "workspace-write" })}\n`);
    const write = writeScript(fixture.home, "widen.json", [
      { type: "tool", callId: "call_write", name: "write_file", arguments: { path: "summary.md", content: "nope" } },
      { type: "text", text: "写入被拒绝。" },
    ]);
    const widened = await runCli(["run", "--session", "ses_widen", "把摘要写入 summary.md"], {
      cwd: fixture.workspace,
      env: scripted(fixture.home, write),
    });
    assert.equal(widened.code, 0, widened.output);
    assert.equal(widened.stdout.includes("模式 plan"), true, widened.stdout);
    assert.equal(widened.stdout.includes("请改用 --mode workspace-write"), true, widened.stdout);
    assert.equal(fs.existsSync(path.join(fixture.workspace, "summary.md")), false);
    const missing = await runCli(["resume", "ses_missing_session"], { cwd: fixture.workspace, env: scripted(fixture.home, write) });
    assert.equal(missing.code, 1, missing.output);
    assert.equal(missing.stderr.includes("找不到会话。"), true);
    const trapped = await runCli(["run", "--mode", "plan", "看一眼"], {
      cwd: fixture.workspace,
      env: { ...scripted(fixture.home, write), RUHUI_HOME: fixture.workspace },
    });
    assert.equal(trapped.code, 1, trapped.output);
    assert.equal(trapped.stderr.includes("RUHUI_HOME 不能放在工作区里面。"), true);
  } finally {
    fixture.cleanup();
  }
});

function notesScript(content, text) {
  return [
    { type: "tool", callId: "call_list", name: "list_dir", arguments: { path: "." } },
    { type: "tool", callId: "call_read_a", name: "read_file", arguments: { path: "2026-11-01.md" } },
    { type: "tool", callId: "call_read_b", name: "read_file", arguments: { path: "2026-11-02.md" } },
    { type: "tool", callId: "call_write", name: "write_file", arguments: { path: "summary.md", content } },
    { type: "text", text },
  ];
}

async function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-cli-"));
  const workspace = path.join(root, "notes");
  const home = path.join(root, "home");
  fs.mkdirSync(workspace);
  fs.copyFileSync(path.join(notes, "2026-11-01.md"), path.join(workspace, "2026-11-01.md"));
  fs.copyFileSync(path.join(notes, "2026-11-02.md"), path.join(workspace, "2026-11-02.md"));
  return {
    root,
    workspace,
    home,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function writeScript(home, name, steps) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, name);
  fs.writeFileSync(file, JSON.stringify(steps));
  return file;
}

function scripted(home, script) {
  return {
    RUHUI_HOME: home,
    RUHUI_PROVIDER: "scripted",
    RUHUI_SCRIPT: script,
    RUHUI_ABORT_AFTER: "",
  };
}

function rolloutText(home, sessionId) {
  return fs.readFileSync(path.join(home, "sessions", sessionId, "rollout.jsonl"), "utf8");
}

function readEvents(home, sessionId) {
  return rolloutText(home, sessionId).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

async function runCli(args, options) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });
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
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  return { code, stdout, stderr, output: `${stdout}\n${stderr}` };
}
