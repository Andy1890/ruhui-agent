import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../packages/cli/ruhui.mjs");
const sdk = path.resolve(here, "../../packages/sdk/dist/index.js");
if (!fs.existsSync(cli) || !fs.existsSync(sdk)) {
  process.stderr.write("先在仓库根目录运行 npm test，编译完成后再运行这个示例。\n");
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruhui-meeting-notes-"));
const workspace = path.join(root, "notes");
const home = path.join(root, "home");
fs.mkdirSync(workspace);
for (const name of ["2026-11-01.md", "2026-11-02.md", "script.json"]) {
  fs.copyFileSync(path.join(here, name), path.join(workspace, name));
}

const env = {
  ...process.env,
  RUHUI_HOME: home,
  RUHUI_PROVIDER: "scripted",
  RUHUI_SCRIPT: path.join(workspace, "script.json"),
  RUHUI_ABORT_AFTER: "",
};

const doctor = await runCli(["doctor"]);
process.stdout.write(doctor.stdout);
process.stderr.write(doctor.stderr);
if (doctor.code !== 0) {
  process.exit(doctor.code ?? 1);
}

const result = await runCli(["run", "--mode", "workspace-write", "阅读本目录的笔记，生成 summary.md"]);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.code === 0) {
  process.stdout.write(`摘要 ${path.join(workspace, "summary.md")}\n`);
}
process.exit(result.code ?? 1);

function runCli(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: workspace, env, windowsHide: true });
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
  return once(child, "exit").then(([code]) => ({ code, stdout, stderr }));
}
