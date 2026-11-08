import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("核心包名是 pub.rh.agent.core", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /export const packageName = "pub\.rh\.agent\.core"/);
});
