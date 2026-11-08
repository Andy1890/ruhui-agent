import assert from "node:assert/strict";
import test from "node:test";
import { findViolations } from "./boundaries.mjs";

test("core 引用 tools 被拒绝", () => {
  const violations = findViolations({ core: ["tools"] }, "phase0");
  assert.deepEqual(violations, [
    { from: "core", to: "tools", rule: "forbidden-dependency" },
  ]);
});

test("Phase 0 的合法组合可以通过", () => {
  const violations = findViolations({
    providers: ["core"],
    sandbox: ["core"],
    tools: ["core", "sandbox"],
    sdk: ["core", "providers", "sandbox", "tools"],
    cli: ["sdk"],
  }, "phase0");
  assert.deepEqual(violations, []);
});

test("cli 不能直接引用 tools", () => {
  const violations = findViolations({ cli: ["tools"] }, "phase0");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].to, "tools");
});
