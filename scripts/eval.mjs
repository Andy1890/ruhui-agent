import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const required = [
  "evals/fixtures/notes/2026-11-01.md",
  "evals/fixtures/notes/2026-11-02.md",
  "evals/fixtures/rollout/valid.jsonl",
  "evals/fixtures/rollout/partial-line.jsonl",
  "evals/fixtures/rollout/gap.jsonl",
  "evals/fixtures/rollout/secret.jsonl",
];

const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length > 0) {
  process.stderr.write(`缺少评测夹具：${missing.join(", ")}\n`);
  process.exit(1);
}

process.stdout.write("评测夹具就绪。真实模型不在 CI 中运行。\n");
