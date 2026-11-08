import { spawn } from "node:child_process";
import { containPath } from "../sandbox/dist/index.js";
import { nodePathLook } from "../sandbox/path-jail-node.mjs";
import { createCommandHandlers } from "./dist/index.js";

const maxStoredBytes = 30000;

export function nodeCommandTools(workspaceRoot, options = {}) {
  const look = nodePathLook();
  return {
    handlers: createCommandHandlers({
      cwd: workspaceRoot,
      timeoutMs: options.timeoutMs,
      resolve(requested) {
        return containPath(workspaceRoot, requested, look);
      },
      runner: nodeCommandRunner(),
    }),
  };
}

function nodeCommandRunner() {
  return {
    run(request) {
      return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let timer;
        let backup;
        const finish = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          clearTimeout(backup);
          resolve(value);
        };
        let child;
        try {
          child = spawn(request.file, request.args, {
            shell: false,
            cwd: request.cwd,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          finish({ kind: "failed" });
          return;
        }
        const stdout = collect(child.stdout);
        const stderr = collect(child.stderr);
        const started = Date.now();
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
          backup = setTimeout(() => {
            finish({ kind: "timeout", elapsedMs: Date.now() - started, stdout: "", stderr: "" });
          }, 2000);
        }, request.timeoutMs);
        child.on("error", () => {
          if (!timedOut) {
            finish({ kind: "failed" });
          }
        });
        child.on("close", (code) => {
          Promise.all([stdout, stderr]).then(([out, err]) => {
            if (timedOut) {
              finish({ kind: "timeout", elapsedMs: Date.now() - started, stdout: out.text, stderr: err.text });
              return;
            }
            finish({
              kind: "exit",
              code: code ?? 1,
              stdout: out.text,
              stderr: err.text,
              stdoutBytes: out.bytes,
              stderrBytes: err.bytes,
            });
          });
        });
      });
    },
  };
}

function collect(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let stored = 0;
    let bytes = 0;
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (stored < maxStoredBytes) {
        const take = Math.min(buffer.length, maxStoredBytes - stored);
        chunks.push(buffer.subarray(0, take));
        stored += take;
      }
    });
    const done = () => resolve({ text: Buffer.concat(chunks).toString("utf8"), bytes });
    stream.on("end", done);
    stream.on("error", done);
    stream.on("close", done);
  });
}
