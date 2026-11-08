import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closestToolName, executeToolBatch, phase0Tools, resolveToolName } from "../dist/index.js";

const missingContent = "参数不符合 write_file 的 schema：缺少 content（字符串）。文件未被写入。请补全参数后重试。";

function okResult(text) {
  return { status: "ok", content: [{ type: "text", text }], artifacts: [], sideEffects: [] };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("工具运行时源码不引用文件系统模块", () => {
  const sourceDir = path.dirname(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  for (const name of fs.readdirSync(sourceDir)) {
    const source = fs.readFileSync(path.join(sourceDir, name), "utf8");
    assert.equal(source.includes("node:"), false, name);
    assert.equal(source.includes("from \"fs\""), false, name);
  }
});

test("Phase 0 只注册八个工具，不注册网络和记忆工具", () => {
  assert.deepEqual(
    phase0Tools.map((tool) => tool.name),
    ["read_file", "write_file", "edit_file", "list_dir", "search_files", "execute_command", "update_plan", "ask_user"],
  );
  assert.equal(resolveToolName("web_fetch"), null);
  assert.equal(resolveToolName("web_search"), null);
  assert.equal(resolveToolName("memory"), null);
  assert.equal(resolveToolName("delegate_task"), null);
  assert.equal(closestToolName("read_fil"), "read_file");
});

test("别名和大小写都会落到已注册名称", () => {
  assert.equal(resolveToolName("ls")?.name, "list_dir");
  assert.equal(resolveToolName("CAT")?.name, "read_file");
  assert.equal(resolveToolName("Read-File")?.name, "read_file");
  assert.equal(resolveToolName("grep")?.name, "search_files");
});

test("未知工具不执行，并给出最接近的名称", async () => {
  let called = 0;
  const [result] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_web", name: "web_fetch", arguments: { url: "https://example.test" } }],
    handlers: {
      web_fetch() {
        called += 1;
        return okResult("不应执行");
      },
    },
  });
  assert.equal(called, 0);
  assert.equal(result.executed, false);
  assert.equal(result.name, "web_fetch");
  assert.equal(result.result.status, "error");
  assert.equal(result.result.correctiveHint, `未知工具 web_fetch。最接近的已注册名称是 ${closestToolName("web_fetch")}。调用未执行。`);
});

test("缺少 content 时不调用处理函数", async () => {
  let called = 0;
  const [result] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_write", name: "write", arguments: { path: "summary.md" } }],
    handlers: {
      write_file() {
        called += 1;
        return okResult("不应写入");
      },
    },
  });
  assert.equal(called, 0);
  assert.equal(result.executed, false);
  assert.equal(result.name, "write_file");
  assert.equal(result.policy.decision, "allow");
  assert.equal(result.result.status, "error");
  assert.equal(result.result.correctiveHint, missingContent);
});

test("类型不对、多余字段和命令参数错误都不执行", async () => {
  const handlers = { write_file() { throw new Error("不应执行"); }, execute_command() { throw new Error("不应执行"); } };
  const [wrongType] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_1", name: "write_file", arguments: { path: "summary.md", content: 1 } }],
    handlers,
  });
  const [extra] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_2", name: "write_file", arguments: { path: "summary.md", content: "a", mode: "full" } }],
    handlers,
  });
  const [badArgs] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_3", name: "execute_command", arguments: { args: ["echo", 1] } }],
    handlers,
  });
  const [badShell] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_4", name: "execute_command", arguments: { args: ["echo"], shell: "cmd" } }],
    handlers,
  });
  assert.equal(wrongType.result.correctiveHint.includes("content 必须是字符串"), true);
  assert.equal(extra.result.correctiveHint.includes("存在未知字段 mode"), true);
  assert.equal(badArgs.result.correctiveHint.includes("args 的每一项必须是字符串"), true);
  assert.equal(badShell.result.correctiveHint.includes("shell 必须是 none、pwsh 或 bash"), true);
  assert.equal(wrongType.executed || extra.executed || badArgs.executed || badShell.executed, false);
});

test("plan 在处理函数之前拒绝写入和命令", async () => {
  let called = 0;
  const handlers = {
    write_file() {
      called += 1;
      return okResult("不应写入");
    },
    execute_command() {
      called += 1;
      return okResult("不应执行");
    },
    ask_user() {
      called += 1;
      return {
        status: "needs_approval",
        content: [{ type: "text", text: "摘要使用哪个标题？" }],
        artifacts: [],
        sideEffects: [],
        correctiveHint: "等待使用者回答。",
      };
    },
  };
  const [write] = await executeToolBatch({
    mode: "plan",
    calls: [{ callId: "call_write", name: "write_file", arguments: { path: "summary.md", content: "a" } }],
    handlers,
  });
  const [command] = await executeToolBatch({
    mode: "plan",
    calls: [{ callId: "call_cmd", name: "execute_command", arguments: { args: ["echo", "hi"] } }],
    handlers,
  });
  const [ask] = await executeToolBatch({
    mode: "plan",
    calls: [{ callId: "call_ask", name: "ask_user", arguments: { question: "摘要使用哪个标题？" } }],
    handlers,
  });
  assert.equal(write.result.status, "denied");
  assert.equal(write.policy.decision, "deny");
  assert.equal(write.result.correctiveHint.includes("--mode workspace-write"), true);
  assert.equal(write.result.correctiveHint.includes("编码"), false);
  assert.equal(command.result.status, "denied");
  assert.equal(command.result.correctiveHint.includes("不允许命令"), true);
  assert.equal(ask.executed, true);
  assert.equal(ask.result.status, "needs_approval");
  assert.equal(called, 1);
});

test("workspace-write 允许后才进入处理函数，异常不会抛出", async () => {
  const [ok] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_write", name: "write_file", arguments: { path: "summary.md", content: "周宁" } }],
    handlers: {
      write_file(call) {
        assert.equal(Object.hasOwn(call.arguments, "content"), true);
        return okResult("已写入");
      },
    },
  });
  const [broken] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_read", name: "read_file", arguments: { path: "a.md" } }],
    handlers: {
      read_file() {
        throw new Error("boom");
      },
    },
  });
  const [invalid] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_list", name: "list_dir", arguments: {} }],
    handlers: { list_dir() { return { status: "ok" }; } },
  });
  const [missing] = await executeToolBatch({
    mode: "workspace-write",
    calls: [{ callId: "call_search", name: "search_files", arguments: { query: "周宁" } }],
    handlers: {},
  });
  assert.equal(ok.executed, true);
  assert.equal(ok.result.status, "ok");
  assert.equal(broken.executed, true);
  assert.equal(broken.result.status, "error");
  assert.equal(broken.result.correctiveHint, "工具执行失败。");
  assert.equal(JSON.stringify(broken.result).includes("boom"), false);
  assert.equal(invalid.result.correctiveHint, "工具结果无法归一化。");
  assert.equal(missing.executed, false);
  assert.equal(missing.result.correctiveHint.includes("尚未接入处理函数"), true);
});

test("同一批次里有串行工具时按调用顺序执行", async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const handler = (name) => async () => {
    order.push(`start:${name}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(20);
    active -= 1;
    order.push(`end:${name}`);
    return okResult(name);
  };
  await executeToolBatch({
    mode: "workspace-write",
    calls: [
      { callId: "call_list", name: "ls", arguments: {} },
      { callId: "call_write", name: "write_file", arguments: { path: "summary.md", content: "a" } },
    ],
    handlers: { list_dir: handler("list_dir"), write_file: handler("write_file") },
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start:list_dir", "end:list_dir", "start:write_file", "end:write_file"]);
});

test("全部只读时可以重叠执行，结果仍按调用顺序返回", async () => {
  let active = 0;
  let maxActive = 0;
  const read = async (call) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(call.arguments.path === "slow.md" ? 30 : 0);
    active -= 1;
    return okResult(call.arguments.path);
  };
  const results = await executeToolBatch({
    mode: "plan",
    calls: [
      { callId: "call_slow", name: "read_file", arguments: { path: "slow.md" } },
      { callId: "call_fast", name: "read_file", arguments: { path: "fast.md" } },
    ],
    handlers: { read_file: read },
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((item) => item.result.content[0].text), ["slow.md", "fast.md"]);
});

test("full 不能通过工具运行时放行", async () => {
  let called = 0;
  const [result] = await executeToolBatch({
    mode: "full",
    calls: [{ callId: "call_read", name: "read_file", arguments: { path: "a.md" } }],
    handlers: {
      read_file() {
        called += 1;
        return okResult("不应读取");
      },
    },
  });
  assert.equal(called, 0);
  assert.equal(result.result.status, "denied");
  assert.equal(result.result.correctiveHint.includes("Phase 0 不可用"), true);
});
