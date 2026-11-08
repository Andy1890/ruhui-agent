import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const skip = new Set(["node_modules", ".git", "dist", "coverage"]);
const patterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-(?:live|proj)-[A-Za-z0-9_-]{20,}/g,
];
const allowed = new Set(["sk-test-fixture-not-a-secret"]);

export function scanText(text) {
  const hits = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!allowed.has(match[0])) {
        hits.push(match[0]);
      }
    }
  }
  return hits;
}

export function scanTree(directory = root) {
  const failures = [];
  for (const file of walk(directory)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hits = scanText(text);
    if (hits.length > 0) {
      failures.push({ file: path.relative(root, file), hits });
    }
  }
  return failures;
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile() && !full.endsWith(".png") && !full.endsWith(".jpg")) {
      files.push(full);
    }
  }
  return files;
}

if (import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href || process.argv[1]?.endsWith("scan.mjs")) {
  const failures = scanTree();
  if (failures.length > 0) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exit(1);
  }
}
