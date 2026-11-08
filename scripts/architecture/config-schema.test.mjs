import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSchema, validateConfig } from "./validate-config.mjs";

const schemaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../schema/config.schema.json",
);
const schema = loadSchema(schemaPath);

const valid = {
  model: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fake",
    apiKeyEnv: "RUHUI_API_KEY",
  },
  mode: "workspace-write",
  sandbox: {
    backend: "path-jail",
    network: false,
  },
};

test("合法的 Phase 0 配置通过", () => {
  assert.deepEqual(validateConfig(schema, valid), []);
});

test("项目配置不能把 mode 设为 full", () => {
  const errors = validateConfig(schema, { ...valid, mode: "full" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /mode/);
});

test("未知字段被拒绝", () => {
  const errors = validateConfig(schema, { ...valid, allowOutsideWorkspace: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /allowOutsideWorkspace/);
});

test("apiKeyEnv 不能写成路径", () => {
  const errors = validateConfig(schema, {
    ...valid,
    model: { ...valid.model, apiKeyEnv: "../secrets.env" },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /apiKeyEnv/);
});
