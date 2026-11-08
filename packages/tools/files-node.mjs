import fs from "node:fs";
import path from "node:path";
import { containPath } from "../sandbox/dist/index.js";
import { nodePathLook } from "../sandbox/path-jail-node.mjs";
import { createFileHandlers } from "./dist/index.js";

export function nodeFileTools(workspaceRoot, turn = { revisions: new Map() }) {
  const look = nodePathLook();
  return {
    turn,
    handlers: createFileHandlers({
      files: nodeWorkspaceFiles(),
      turn,
      resolve(requested) {
        return containPath(workspaceRoot, requested, look);
      },
    }),
  };
}

function nodeWorkspaceFiles() {
  return {
    readFile(absolutePath, maxBytes) {
      let stat;
      try {
        stat = fs.statSync(absolutePath);
      } catch (error) {
        return missingCode(error) ? { kind: "missing" } : { kind: "unavailable" };
      }
      if (stat.isDirectory()) {
        return { kind: "directory" };
      }
      let fd;
      try {
        fd = fs.openSync(absolutePath, "r");
        const toRead = Math.min(stat.size, maxBytes);
        const buffer = Buffer.alloc(toRead);
        fs.readSync(fd, buffer, 0, toRead, 0);
        const text = buffer.toString("utf8");
        if (text.includes("\0")) {
          return { kind: "binary", bytes: stat.size };
        }
        if (stat.size > maxBytes) {
          return { kind: "truncated", text, bytes: stat.size };
        }
        return { kind: "file", text };
      } catch {
        return { kind: "unavailable" };
      } finally {
        if (fd !== undefined) {
          fs.closeSync(fd);
        }
      }
    },
    writeFile(absolutePath, text) {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, text, "utf8");
    },
    listDir(absolutePath) {
      let stat;
      try {
        stat = fs.statSync(absolutePath);
      } catch (error) {
        return { error: missingCode(error) ? "missing" : "unavailable" };
      }
      if (!stat.isDirectory()) {
        return { error: "not-directory" };
      }
      const entries = fs.readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink() ? "file" : entry.isDirectory() ? "directory" : "file",
      }));
      return { entries };
    },
  };
}

function missingCode(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  return code === "ENOENT" || code === "ENOTDIR";
}
