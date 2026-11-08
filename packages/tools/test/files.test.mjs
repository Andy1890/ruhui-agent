import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeToolBatch } from "../dist/index.js";
import { nodeFileTools } from "../files-node.mjs";

const notesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/fixtures/notes");
const outsideBody = "OUTSIDE-SECRET-BODY";
const missingContent = "参数不符合 write_file 的 schema：缺少 content（字符串）。文件未被写入。请补全参数后重试。";

function workspaceCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-files-"));
  const workspace = path.join(root, "notes");
  fs.cpSync(notesDir, workspace, { recursive: true });
  return { root, workspace, tools: nodeFileTools(workspace) };
}

function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

test("E1：读出两则笔记并写入包含三则事实的摘要", () => {
  const { root, workspace, tools } = workspaceCopy();
  try {
    const listed = tools.handlers.list_dir({ callId: "call_list", name: "list_dir", arguments: { path: "." } });
    assert.equal(textOf(listed), "2026-11-01.md\n2026-11-02.md");
    const first = tools.handlers.read_file({ callId: "call_read_1", name: "read_file", arguments: { path: "2026-11-01.md" } });
    const second = tools.handlers.read_file({ callId: "call_read_2", name: "read_file", arguments: { path: "2026-11-02.md" } });
    assert.equal(textOf(first).includes("2026-12-01"), true);
    assert.equal(textOf(first).includes("周宁"), true);
    assert.equal(textOf(second).includes("2 万元"), true);
    const summary = "发布日期为 2026-12-01，负责人为周宁，预算上限为 2 万元。";
    const written = tools.handlers.write_file({
      callId: "call_write",
      name: "write_file",
      arguments: { path: "summary.md", content: summary },
    });
    assert.equal(written.status, "ok");
    assert.equal(written.sideEffects[0].target, "summary.md");
    const saved = fs.readFileSync(path.join(workspace, "summary.md"), "utf8");
    assert.equal(saved.includes("2026-12-01"), true);
    assert.equal(saved.includes("周宁"), true);
    assert.equal(saved.includes("2 万元"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("E2：缺少 content 时不创建 summary.md", async () => {
  const { root, workspace, tools } = workspaceCopy();
  try {
    const [result] = await executeToolBatch({
      mode: "workspace-write",
      calls: [{ callId: "call_write", name: "write_file", arguments: { path: "summary.md" } }],
      handlers: tools.handlers,
    });
    assert.equal(result.executed, false);
    assert.equal(result.result.correctiveHint, missingContent);
    assert.equal(fs.existsSync(path.join(workspace, "summary.md")), false);
    const [denied] = await executeToolBatch({
      mode: "plan",
      calls: [{ callId: "call_plan", name: "write_file", arguments: { path: "summary.md", content: "不会写入" } }],
      handlers: tools.handlers,
    });
    assert.equal(denied.result.status, "denied");
    assert.equal(fs.existsSync(path.join(workspace, "summary.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("区外读取被拒绝，正文不会进入结果", () => {
  const { root, workspace, tools } = workspaceCopy();
  const outside = path.join(root, "outside-secret.txt");
  try {
    fs.writeFileSync(outside, outsideBody);
    const read = tools.handlers.read_file({ callId: "call_read", name: "read_file", arguments: { path: outside } });
    assert.equal(read.status, "denied");
    assert.equal(textOf(read).includes(outside), true);
    assert.equal(textOf(read).includes(outsideBody), false);
    assert.equal(textOf(read).includes("绝对路径再试"), false);
    const write = tools.handlers.write_file({
      callId: "call_write",
      name: "write_file",
      arguments: { path: outside, content: "覆盖" },
    });
    assert.equal(write.status, "denied");
    assert.equal(fs.readFileSync(outside, "utf8"), outsideBody);
    const outsideDir = path.join(root, "outside-dir");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), outsideBody);
    const link = path.join(workspace, "jump");
    if (process.platform === "win32") {
      fs.symlinkSync(outsideDir, link, "junction");
    } else {
      fs.symlinkSync(outsideDir, link, "dir");
    }
    const linked = tools.handlers.read_file({
      callId: "call_link",
      name: "read_file",
      arguments: { path: path.join("jump", "secret.txt") },
    });
    assert.equal(linked.status, "denied");
    assert.equal(JSON.stringify(linked).includes(outsideBody), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("E7：未读取或读取后被改动时拒绝 edit_file", () => {
  const { root, workspace, tools } = workspaceCopy();
  const file = path.join(workspace, "2026-11-01.md");
  const original = fs.readFileSync(file, "utf8");
  try {
    const unread = tools.handlers.edit_file({
      callId: "call_edit",
      name: "edit_file",
      arguments: { path: "2026-11-01.md", old: "周宁", new: "李明" },
    });
    assert.equal(unread.status, "error");
    assert.equal(textOf(unread).includes("请先 read_file"), true);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    tools.handlers.read_file({ callId: "call_read", name: "read_file", arguments: { path: "2026-11-01.md" } });
    fs.writeFileSync(file, original.replace("周宁", "外部"));
    const stale = tools.handlers.edit_file({
      callId: "call_stale",
      name: "edit_file",
      arguments: { path: "2026-11-01.md", old: "周宁", new: "李明" },
    });
    assert.equal(stale.status, "error");
    assert.equal(textOf(stale).includes("请先重新读取"), true);
    assert.equal(fs.readFileSync(file, "utf8").includes("外部"), true);
    assert.equal(fs.readFileSync(file, "utf8").includes("李明"), false);
    tools.handlers.read_file({ callId: "call_reread", name: "read_file", arguments: { path: "2026-11-01.md" } });
    const edited = tools.handlers.edit_file({
      callId: "call_ok",
      name: "edit_file",
      arguments: { path: "2026-11-01.md", old: "外部", new: "周宁" },
    });
    assert.equal(edited.status, "ok");
    assert.equal(fs.readFileSync(file, "utf8").includes("周宁"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("search_files 能找到笔记中的事实，list_dir 不递归", () => {
  const { root, workspace, tools } = workspaceCopy();
  try {
    fs.mkdirSync(path.join(workspace, "nested"));
    fs.writeFileSync(path.join(workspace, "nested", "later.md"), "后续");
    const listed = tools.handlers.list_dir({ callId: "call_list", name: "list_dir", arguments: {} });
    assert.equal(textOf(listed).includes("later.md"), false);
    assert.equal(textOf(listed).includes("nested/"), true);
    const found = tools.handlers.search_files({ callId: "call_search", name: "search_files", arguments: { query: "周宁" } });
    assert.equal(found.status, "ok");
    assert.equal(textOf(found).includes("2026-11-01.md:1:"), true);
    assert.equal(textOf(found).includes("周宁"), true);
    const nested = tools.handlers.search_files({ callId: "call_nested", name: "search_files", arguments: { query: "后续" } });
    assert.equal(textOf(nested).includes("nested/later.md"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("超长文本会被截断，不把整文件放进结果", async () => {
  const { createFileHandlers } = await import("../dist/index.js");
  const body = "a".repeat(40000);
  const handlers = createFileHandlers({
    turn: { revisions: new Map() },
    resolve: () => ({ allowed: true, relativePath: "big.txt", absolutePath: "D:/work/notes/big.txt" }),
    files: {
      readFile() {
        return { kind: "file", text: body };
      },
      writeFile() {},
      listDir() {
        return { entries: [] };
      },
    },
  });
  const result = handlers.read_file({ callId: "call_big", name: "read_file", arguments: { path: "big.txt" } });
  const shown = textOf(result);
  assert.equal(shown.includes("已截断"), true);
  assert.equal(shown.includes("40000"), true);
  assert.equal(shown.length < body.length, true);
});
