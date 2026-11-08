import assert from "node:assert/strict";
import test from "node:test";
import { scanText, scanTree } from "./scan.mjs";

test("私钥和云访问密钥会被拒绝", () => {
  const header = "-----BEGIN OPENSSH PRIVATE " + "KEY-----";
  const accessKey = "AKIA" + "IOSFODNN7EXAMPLE";
  assert.equal(scanText(header).length, 1);
  assert.equal(scanText(accessKey).length, 1);
});

test("夹具里的假密钥不会挡住仓库扫描", () => {
  assert.deepEqual(scanTree(), []);
});
