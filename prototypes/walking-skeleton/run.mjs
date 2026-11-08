/**
 * 可丢弃的行走骨架。不属于 pub.rh.agent，也不会进入 packages/。
 * 假模型按 list_dir → read_file → write_file → 最终答复 走通主路径。
 */
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../../evals/fixtures/notes");
const sentinel = "UNIQUE_SENTINEL_ruhui_prototype";

const role = argValue("--role") ?? "parent";

if (role === "child") {
  runChild();
} else {
  runParent()
    .then((report) => {
      process.stdout.write(`${report}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exit(1);
    });
}

async function runParent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-prototype-"));
  const workspace = path.join(root, "notes");
  fs.mkdirSync(workspace);
  fs.copyFileSync(path.join(fixtureDir, "2026-11-01.md"), path.join(workspace, "2026-11-01.md"));
  fs.copyFileSync(path.join(fixtureDir, "2026-11-02.md"), path.join(workspace, "2026-11-02.md"));
  fs.writeFileSync(path.join(root, "outside-secret.txt"), `${sentinel}\n`, "utf8");

  const happy = runHappy(workspace);
  const denied = runDenied(workspace, path.join(root, "outside-secret.txt"));
  const crashed = await runCrash(workspace);

  return [
    `workspace=${workspace}`,
    `happy=${happy.summaryPath}`,
    `facts=${happy.facts.join(",")}`,
    `denied=${denied.line}`,
    `sentinelLeaked=${denied.leaked}`,
    `crashLines=${crashed.seqs.join(",")}`,
    `crashPartialDiscarded=${crashed.partialDiscarded}`,
  ].join("\n");
}

function runHappy(workspace) {
  const rolloutPath = path.join(workspace, "happy.jsonl");
  const events = [];
  const push = (type, payload) => {
    const event = appendEvent(rolloutPath, events.length + 1, type, payload);
    events.push(event);
    process.stdout.write(`[tool] ${formatEvent(event)}\n`);
  };

  const listed = callTool(workspace, "list_dir", { path: "." });
  push("tool.finished", listed);
  for (const name of ["2026-11-01.md", "2026-11-02.md"]) {
    push("tool.finished", callTool(workspace, "read_file", { path: name }));
  }
  const summary = [
    "# 笔记摘要",
    "",
    "- 发布日期：2026-12-01",
    "- 负责人：周宁",
    "- 预算上限：2 万元，不包含差旅。",
    "",
  ].join("\n");
  push("tool.finished", callTool(workspace, "write_file", { path: "summary.md", content: summary }));
  push("message.completed", { text: "已生成 summary.md。发布日期为 2026-12-01，负责人为周宁，预算上限为 2 万元。" });

  const summaryPath = path.join(workspace, "summary.md");
  const body = fs.readFileSync(summaryPath, "utf8");
  const facts = ["2026-12-01", "周宁", "2 万元"].filter((fact) => body.includes(fact));
  if (facts.length !== 3) {
    throw new Error(`摘要缺少事实：${body}`);
  }
  if (events.length !== 5) {
    throw new Error(`主路径事件数应为 5，实际 ${events.length}`);
  }
  return { summaryPath, facts };
}

function runDenied(workspace, secretPath) {
  const relativeEscape = path.relative(workspace, secretPath);
  const result = callTool(workspace, "read_file", { path: relativeEscape });
  const absolute = callTool(workspace, "read_file", { path: secretPath });
  const line = `read_file ${relativeEscape} -> ${result.status} ${result.correctiveHint}`;
  process.stdout.write(`[deny] ${line}\n`);
  const blob = JSON.stringify(result) + JSON.stringify(absolute);
  if (result.status !== "denied" || absolute.status !== "denied") {
    throw new Error(blob);
  }
  if (blob.includes(sentinel)) {
    throw new Error("区外文件内容进入了结果");
  }
  if (result.correctiveHint.includes("绝对路径再试")) {
    throw new Error("拒绝提示给出了绕过建议");
  }
  return { line, leaked: false };
}

async function runCrash(workspace) {
  const rolloutPath = path.join(workspace, "crash.jsonl");
  const readyPath = path.join(workspace, "crash.ready");
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    "--role",
    "child",
    "--workspace",
    workspace,
    "--rollout",
    rolloutPath,
    "--ready",
    readyPath,
  ], { stdio: "ignore" });

  const started = Date.now();
  while (!fs.existsSync(readyPath)) {
    if (Date.now() - started > 5000) {
      child.kill();
      throw new Error("子进程没有在时限内写完完整步骤");
    }
    await delay(20);
  }
  child.kill();
  const [exitCode] = await once(child, "exit");
  const raw = fs.readFileSync(rolloutPath, "utf8");
  let body = raw;
  let partialDiscarded = false;
  if (!raw.endsWith("\n")) {
    partialDiscarded = true;
    const lastNewline = raw.lastIndexOf("\n");
    body = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  }
  const complete = body.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  const seqs = complete.map((event) => event.seq);
  if (seqs.join(",") !== "1,2,3" || !partialDiscarded) {
    throw new Error(`中断后的完整步骤应为 1,2,3 且半行被丢弃，实际 ${seqs.join(",")} partial=${partialDiscarded} raw=${JSON.stringify(raw)}`);
  }
  process.stdout.write(`[crash] exit=${exitCode} seq=${seqs.join(",")} partialDiscarded=${partialDiscarded}\n`);
  return { seqs, partialDiscarded };
}

function runChild() {
  const workspace = argValue("--workspace");
  const rolloutPath = argValue("--rollout");
  const readyPath = argValue("--ready");
  appendEvent(rolloutPath, 1, "tool.finished", callTool(workspace, "list_dir", { path: "." }));
  appendEvent(rolloutPath, 2, "tool.finished", callTool(workspace, "read_file", { path: "2026-11-01.md" }));
  appendEvent(rolloutPath, 3, "tool.finished", callTool(workspace, "read_file", { path: "2026-11-02.md" }));
  const fd = fs.openSync(rolloutPath, "a");
  fs.writeSync(fd, "{\"seq\":4,\"partial\":");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.writeFileSync(readyPath, "ready\n");
  setInterval(() => {}, 1000);
}

function callTool(workspace, name, args) {
  try {
    if (name === "list_dir") {
      const target = inside(workspace, args.path ?? ".");
      const names = fs.readdirSync(target).sort();
      return ok(name, args, names.join("\n"));
    }
    if (name === "read_file") {
      const target = inside(workspace, args.path);
      return ok(name, args, fs.readFileSync(target, "utf8"));
    }
    if (name === "write_file") {
      if (typeof args.content !== "string") {
        return {
          tool: name,
          args,
          status: "error",
          correctiveHint: "参数不符合 write_file 的 schema：缺少 content（字符串）。文件未被写入。请补全参数后重试。",
        };
      }
      const target = inside(workspace, args.path);
      fs.writeFileSync(target, args.content, "utf8");
      return ok(name, args, `已写入 ${args.path}`);
    }
    return { tool: name, args, status: "error", correctiveHint: `未知工具 ${name}` };
  } catch (error) {
    if (error?.code === "OUTSIDE") {
      return {
        tool: name,
        args,
        status: "denied",
        correctiveHint: `拒绝读取工作区外的路径：${error.path}。请改用工作区内的相对路径。`,
      };
    }
    return { tool: name, args, status: "error", correctiveHint: error.message };
  }
}

function inside(workspace, requested) {
  const root = fs.realpathSync(workspace);
  const candidate = path.resolve(root, requested);
  const nearest = nearestExisting(candidate);
  const realNearest = fs.realpathSync(nearest);
  const suffix = path.relative(nearest, candidate);
  const real = suffix ? path.resolve(realNearest, suffix) : realNearest;
  const rel = path.relative(root, real);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return real;
  }
  const error = new Error("outside");
  error.code = "OUTSIDE";
  error.path = real;
  throw error;
}

function nearestExisting(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function ok(tool, args, content) {
  return { tool, args, status: "ok", content };
}

function appendEvent(rolloutPath, seq, type, payload) {
  const event = { schemaVersion: 1, seq, time: new Date().toISOString(), type, payload };
  const fd = fs.openSync(rolloutPath, "a");
  fs.writeSync(fd, `${JSON.stringify(event)}\n`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return event;
}

function formatEvent(event) {
  const payload = event.payload;
  return `${payload.tool ?? event.type} ${JSON.stringify(payload.args ?? {})} -> ${payload.status ?? event.type}`;
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
