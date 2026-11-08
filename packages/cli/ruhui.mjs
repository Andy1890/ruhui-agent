#!/usr/bin/env node
import { parseCommand } from "../sdk/dist/index.js";
import { executeCommand } from "../sdk/agent-node.mjs";

const parsed = parseCommand(process.argv.slice(2));
if (parsed.kind === "usage") {
  process.stderr.write(parsed.text.endsWith("\n") ? parsed.text : `${parsed.text}\n`);
  process.exit(parsed.exitCode);
}

const signal = { aborted: false };
process.on("SIGINT", () => {
  signal.aborted = true;
});

const result = await executeCommand(parsed, {
  cwd: process.cwd(),
  env: process.env,
  pid: process.pid,
  signal,
});
if (result.stdout) {
  process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
}
if (result.stderr) {
  process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
}
process.exit(result.exitCode);
