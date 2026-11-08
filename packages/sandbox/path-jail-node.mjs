import fs from "node:fs";

const missing = new Set(["ENOENT", "ENOTDIR"]);

export function nodePathLook() {
  return {
    realPath(absolutePath) {
      try {
        return fs.realpathSync(absolutePath);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
        if (missing.has(code)) {
          return null;
        }
        return { error: code };
      }
    },
  };
}
