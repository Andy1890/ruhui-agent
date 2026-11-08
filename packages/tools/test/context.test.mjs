import assert from "node:assert/strict";
import test from "node:test";
import { assembleContext } from "../../core/dist/index.js";
import { phase0Tools } from "../dist/index.js";

test("已注册工具的 schema 按注册顺序出现在用户消息之前", () => {
  const assembled = assembleContext({
    profile: {
      id: "scripted",
      contextWindow: 128000,
      supportsTools: true,
      supportsParallelTools: false,
      supportsStreaming: true,
      supportsImages: false,
    },
    os: "windows",
    workspaceRoot: "D:/work/notes",
    date: "2026-11-08",
    network: false,
    sandbox: "path-jail",
    instructions: [],
    tools: phase0Tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: JSON.stringify(tool.inputSchema),
    })),
    userText: "阅读本目录的笔记，生成 summary.md",
  });
  const names = phase0Tools.map((tool) => tool.name);
  let previous = assembled.system.indexOf("工具：");
  for (const name of names) {
    const index = assembled.system.indexOf(`${name}：`);
    assert.equal(index > previous, true, name);
    previous = index;
  }
  assert.equal(assembled.system.includes("\"content\""), true);
  assert.equal(assembled.user, "阅读本目录的笔记，生成 summary.md");
  assert.equal(assembled.system.includes(assembled.user), false);
});
