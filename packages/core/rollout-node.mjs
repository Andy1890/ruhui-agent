import fs from "node:fs";
import path from "node:path";

export function nodeSessionFiles(root) {
  const full = (name) => path.join(root, name);
  return {
    read(name) {
      const file = full(name);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    },
    write(name, text) {
      const file = full(name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    append(name, text) {
      const file = full(name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text);
    },
    remove(name) {
      const file = full(name);
      if (fs.existsSync(file)) {
        fs.rmSync(file);
      }
    },
  };
}

export function nodeProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
