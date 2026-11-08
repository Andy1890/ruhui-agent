import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assembleContext, createTurn, discoverInstructions, maxInstructionBytes, openRollout, runLoop } from "../dist/index.js";
import { nodeInstructionSource } from "../context-node.mjs";

const profile = {
  id: "openai-compatible",
  contextWindow: 128000,
  supportsTools: true,
  supportsParallelTools: false,
  supportsStreaming: true,
  supportsImages: false,
};

const userText = "阅读本目录的笔记，生成 summary.md";

function sourceFrom(files, directories) {
  const reads = [];
  return {
    reads,
    source: {
      read(file) {
        reads.push(file);
        return files.has(file) ? files.get(file) : null;
      },
      entries(directory) {
        return directories.has(directory) ? directories.get(directory) : null;
      },
    },
  };
}

test("指令按用户级、工作区根到当前目录排列，同层 RUHUI.md 优先", () => {
  const source = fs.readFileSync(new URL("../src/context.ts", import.meta.url), "utf8");
  assert.equal(source.includes("node:"), false);
  const files = new Map([
    ["C:/home/RUHUI.md", "用户级说明"],
    ["D:/AGENTS.md", "越界说明"],
    ["D:/work/RUHUI.md", "根指令"],
    ["D:/work/CLAUDE.md", "CLAUDE-SECRET"],
    ["D:/work/nested/AGENTS.md", "不应读取的代理说明"],
    ["D:/work/nested/RUHUI.md", "子目录如辉"],
    ["D:/work/nested/src/AGENTS.md", "当前目录说明"],
    ["D:/work/nested/.cursor/rules", "CURSOR-RULE"],
  ]);
  const directories = new Map([
    ["D:/", ["work"]],
    ["D:/work", [".git", "nested", "CLAUDE.md", "RUHUI.md"]],
    ["D:/work/nested", [".ruhui", "src", "AGENTS.md", "RUHUI.md", ".cursor"]],
    ["D:/work/nested/src", ["AGENTS.md"]],
  ]);
  const looked = sourceFrom(files, directories);
  const found = discoverInstructions({
    homeFile: "C:/home/RUHUI.md",
    cwd: "D:\\work\\nested\\src",
    source: looked.source,
  });
  assert.equal(found.root, "D:/work");
  assert.deepEqual(found.files.map((file) => file.path), [
    "C:/home/RUHUI.md",
    "D:/work/RUHUI.md",
    "D:/work/nested/RUHUI.md",
    "D:/work/nested/src/AGENTS.md",
  ]);
  assert.equal(found.files.some((file) => file.text.includes("不应读取的代理说明")), false);
  assert.equal(looked.reads.some((file) => file.endsWith("CLAUDE.md")), false);
  assert.equal(looked.reads.some((file) => file.includes(".cursor")), false);
  assert.equal(looked.reads.includes("D:/AGENTS.md"), false);
});

test("指令顺序固定，超限只截断指令文件，用户消息保持原样", async () => {
  const body = `HEAD${"x".repeat(40000)}TAIL-MARKER`;
  const assembled = assembleContext({
    profile,
    os: "windows",
    workspaceRoot: "D:/work/notes",
    date: "2026-11-08",
    network: false,
    sandbox: "path-jail",
    instructions: [{ path: "D:/work/notes/RUHUI.md", text: body }],
    tools: [
      { name: "list_dir", description: "列出目录", schema: "{\"type\":\"object\"}" },
      { name: "read_file", description: "读取文本", schema: "{\"type\":\"object\"}" },
    ],
    plan: [{ title: "阅读笔记" }],
    budget: { toolCalls: 0, maxToolCalls: 8 },
    userText,
  });
  const system = assembled.system;
  const markers = [
    "使用工具完成任务。不要伪造工具结果。",
    "能力：工具调用已启用",
    "环境：操作系统 windows；工作区 D:/work/notes；日期 2026-11-08；网络关闭；沙箱 path-jail。",
    "指令文件已截断：",
    "项目指令：",
    "HEAD",
    "工具：",
    "list_dir",
    "read_file",
    "计划：",
    "预算：工具调用 0/8。",
  ];
  let previous = -1;
  for (const marker of markers) {
    const index = system.indexOf(marker);
    assert.equal(index > previous, true, marker);
    previous = index;
  }
  assert.equal(system.includes("TAIL-MARKER"), false);
  assert.equal(system.includes("openai"), false);
  assert.equal(system.includes(`原始 ${body.length} 字节`), true);
  assert.equal(system.includes(`保留 ${maxInstructionBytes} 字节`), true);
  assert.equal(assembled.user, userText);

  const files = new Map();
  const opened = openRollout({
    files: {
      read: (name) => files.get(name) ?? null,
      write: (name, text) => files.set(name, text),
      append: (name, text) => files.set(name, (files.get(name) ?? "") + text),
      remove: (name) => files.delete(name),
    },
    sessionId: "ses_context",
    pid: 21,
    isAlive: () => false,
    now: "2026-11-08T04:00:01.000Z",
  });
  const turn = createTurn({
    id: "trn_context",
    sessionId: "ses_context",
    input: { text: userText },
    mode: "workspace-write",
    budget: { maxToolCalls: 8 },
  });
  const requests = [];
  const result = await runLoop({
    turn: turn.value,
    context: { system: assembled.system },
    provider: {
      id: "scripted",
      profile,
      async *complete(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "tool_call", call: { callId: "call_list", name: "list_dir", arguments: { path: "." } } };
        } else {
          yield { type: "text", text: "已生成 summary.md。" };
        }
        yield { type: "done" };
      },
    },
    tools: { execute: () => ({ status: "ok", content: [{ type: "text", text: "2 个条目" }], artifacts: [], sideEffects: [] }) },
    rollout: opened.value,
    now: () => "2026-11-08T04:00:01.000Z",
  });
  opened.value.release();
  assert.equal(result.exitCode, 0);
  assert.equal(requests[0].messages[0].role, "system");
  assert.equal(requests[0].messages[1].role, "user");
  assert.equal(requests[0].messages[1].text, userText);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[1].messages[1].text, userText);
});

test("真实目录只读取 RUHUI.md，缺失时才读取 AGENTS.md", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-context-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "ws");
  const nested = path.join(workspace, "sub");
  fs.mkdirSync(home);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(home, "RUHUI.md"), "用户级说明");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "越界说明");
  fs.writeFileSync(path.join(workspace, ".git"), "gitdir: x");
  fs.writeFileSync(path.join(workspace, "RUHUI.md"), "根指令");
  fs.writeFileSync(path.join(workspace, "CLAUDE.md"), "CLAUDE-SECRET");
  fs.mkdirSync(path.join(nested, ".cursor"));
  fs.writeFileSync(path.join(nested, ".cursor", "rules"), "CURSOR-RULE");
  fs.writeFileSync(path.join(nested, "AGENTS.md"), "子目录说明");
  const ceiling = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const disk = nodeInstructionSource();
  try {
    const found = discoverInstructions({
      homeFile: path.join(home, "RUHUI.md"),
      cwd: nested,
      source: {
        read(file) {
          if (!file.replaceAll("\\", "/").startsWith(ceiling)) {
            return null;
          }
          return disk.read(file);
        },
        entries(directory) {
          const normalized = directory.replaceAll("\\", "/");
          if (normalized !== ceiling && !normalized.startsWith(`${ceiling}/`)) {
            return null;
          }
          return disk.entries(directory);
        },
      },
    });
    assert.equal(found.files.map((file) => file.text).join("\n"), "用户级说明\n根指令\n子目录说明");
    assert.equal(found.files.some((file) => file.text.includes("CLAUDE-SECRET")), false);
    assert.equal(found.files.some((file) => file.text.includes("CURSOR-RULE")), false);
    assert.equal(found.files.some((file) => file.text.includes("越界说明")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
