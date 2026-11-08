import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { containPath, sandboxBackend } from "../dist/index.js";
import { nodePathLook } from "../path-jail-node.mjs";

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/fixtures/paths/jail.json");
const outsideBody = "OUTSIDE-SECRET-BODY";

function lookFrom(entries) {
  const map = new Map(Object.entries(entries));
  return {
    realPath(absolutePath) {
      const key = absolutePath.replaceAll("\\", "/");
      return map.has(key) ? map.get(key) : null;
    },
  };
}

test("沙箱后端名称是 path-jail", () => {
  assert.equal(sandboxBackend, "path-jail");
  const source = fs.readFileSync(new URL("../src/path-jail.ts", import.meta.url), "utf8");
  const adapter = fs.readFileSync(new URL("../path-jail-node.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("node:"), false);
  assert.equal(adapter.includes("readFile"), false);
  assert.equal(adapter.includes("bubblewrap"), false);
});

test("越界夹具在解析符号链接后仍必须留在工作区内", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(JSON.stringify(fixture).includes(outsideBody), false);
  for (const group of [fixture.windows, fixture.posix]) {
    const look = lookFrom(group.entries);
    for (const item of group.cases) {
      const decision = containPath(group.workspaceRoot, item.requested, look);
      assert.equal(JSON.stringify(decision).includes(outsideBody), false, item.requested);
      assert.equal(decision.allowed, item.allowed, item.requested);
      if (item.allowed) {
        assert.equal(decision.relativePath, item.relativePath, item.requested);
        assert.equal(decision.absolutePath.endsWith(item.relativePath), true, item.requested);
      } else {
        assert.equal(decision.requestedPath, item.requested, item.requested);
        assert.equal(decision.reason, item.reason, item.requested);
        assert.equal(Object.hasOwn(decision, "absolutePath"), false);
      }
    }
  }
});

test("真实目录里的越界路径被拒绝，且结果不含区外正文", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-jail-"));
  const workspace = path.join(root, "notes");
  const outside = path.join(root, "outside");
  const sibling = path.join(root, "notes-evil");
  try {
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(workspace, "notes.md"), "inside");
    fs.writeFileSync(path.join(outside, "secret.txt"), outsideBody);
    fs.writeFileSync(path.join(sibling, "x"), "sibling");
    const look = nodePathLook();
    const inside = containPath(workspace, "notes.md", look);
    assert.equal(inside.allowed, true);
    assert.equal(inside.relativePath, "notes.md");
    const escaped = containPath(workspace, path.join("..", "outside", "secret.txt"), look);
    const absolute = containPath(workspace, path.join(outside, "secret.txt"), look);
    const prefixed = containPath(workspace, path.join(sibling, "x"), look);
    for (const decision of [escaped, absolute, prefixed]) {
      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, "outside");
      assert.equal(JSON.stringify(decision).includes(outsideBody), false);
    }
    assert.equal(absolute.requestedPath, path.join(outside, "secret.txt"));
    if (process.platform === "win32") {
      fs.symlinkSync(outside, path.join(workspace, "jump"), "junction");
    } else {
      fs.symlinkSync(outside, path.join(workspace, "jump"), "dir");
    }
    const linked = containPath(workspace, path.join("jump", "secret.txt"), look);
    assert.equal(linked.allowed, false);
    assert.equal(linked.reason, "outside");
    assert.equal(JSON.stringify(linked).includes(outsideBody), false);
    const created = containPath(workspace, path.join("new", "summary.md"), look);
    assert.equal(created.allowed, true);
    assert.equal(created.relativePath, "new/summary.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
