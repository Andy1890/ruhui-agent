import fs from "node:fs";

export function nodeInstructionSource() {
  return {
    read(file) {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    entries(directory) {
      try {
        return fs.readdirSync(directory);
      } catch {
        return null;
      }
    },
  };
}
