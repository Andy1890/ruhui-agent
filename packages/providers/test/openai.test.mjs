import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import { createTurn, openRollout, runLoop } from "../../core/dist/index.js";
import { createOpenAICompatibleProvider, retryDelayMs } from "../dist/index.js";
import { nodeOpenAIProvider } from "../openai-node.mjs";

const key = "test-key-a";
const otherKey = "test-key-b";

function request() {
  return {
    messages: [
      { role: "system", text: "使用工具完成任务。" },
      { role: "user", text: "阅读笔记" },
      { role: "tool", callId: "call_list", text: "2 个条目" },
    ],
  };
}

async function* once(text) {
  yield text;
}

async function* pieces(text) {
  for (let index = 0; index < text.length; index += 9) {
    yield text.slice(index, index + 9);
  }
}

function httpResponse(status, text, headers = {}) {
  return { kind: "response", status, headers, chunks: once(text) };
}

function sse(events) {
  return events.map((event) => `data: ${event}\n\n`).join("");
}

const toolStream = sse([
  JSON.stringify({ choices: [{ delta: { content: "先看目录" } }] }),
  JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_list", function: { name: "list_dir", arguments: "" } }] } }],
  }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
  JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 1, id: "call_read", function: { name: "read_file", arguments: '{"path":"a.md"}' } }] } }],
  }),
  JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }),
  "[DONE]",
]);

async function collect(provider, signal = { aborted: false }) {
  const events = [];
  for await (const event of provider.complete(request(), signal)) {
    events.push(event);
  }
  return events;
}

function providerWith(transport, extras = {}) {
  return createOpenAICompatibleProvider({
    baseUrl: extras.baseUrl ?? "http://127.0.0.1:9/v1",
    model: extras.model ?? "auto",
    apiKey: extras.apiKey ?? key,
    transport,
    sleep: extras.sleep ?? (async () => {}),
    now: () => 1_700_000_000_000,
  });
}

test("退避使用 Retry-After，没有这个头时按指数增加", () => {
  assert.equal(retryDelayMs(0, "0", 0), 0);
  assert.equal(retryDelayMs(1, undefined, 0), 400);
  assert.equal(retryDelayMs(0, "Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT") - 1500), 1500);
  assert.equal(retryDelayMs(0, "120", 0), 60_000);
});

test("流式工具调用和用量可以在分片到达时还原", async () => {
  const posts = [];
  const events = await collect(providerWith({
    async post(input) {
      posts.push(input);
      return { kind: "response", status: 200, headers: {}, chunks: pieces(toolStream) };
    },
  }));
  const body = JSON.parse(posts[0].body);
  assert.equal(posts[0].url, "http://127.0.0.1:9/v1/chat/completions");
  assert.equal(posts[0].headers.authorization, `Bearer ${key}`);
  assert.equal(body.stream, true);
  assert.equal(body.model, "auto");
  assert.deepEqual(body.messages, [
    { role: "system", content: "使用工具完成任务。" },
    { role: "user", content: "阅读笔记" },
    { role: "tool", tool_call_id: "call_list", content: "2 个条目" },
  ]);
  assert.equal(JSON.stringify(events).includes(key), false);
  assert.deepEqual(events.filter((event) => event.type === "tool_call").map((event) => event.call), [
    { callId: "call_list", name: "list_dir", arguments: { path: "." } },
    { callId: "call_read", name: "read_file", arguments: { path: "a.md" } },
  ]);
  assert.equal(events.some((event) => event.type === "text" && event.text === "先看目录"), true);
  assert.deepEqual(events.find((event) => event.type === "usage"), { type: "usage", inputTokens: 11, outputTokens: 7 });
  assert.equal(events.at(-1).type, "done");
});

test("429 和 5xx 会再请求，401 和 400 只请求一次", async () => {
  const delays = [];
  let hits = 0;
  const retried = await collect(providerWith({
    async post() {
      hits += 1;
      if (hits < 3) {
        return httpResponse(hits === 1 ? 429 : 500, "busy", { "retry-after": "0" });
      }
      return httpResponse(200, sse([JSON.stringify({ choices: [{ delta: { content: "好了" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), "[DONE]"]));
    },
  }, { sleep: async (ms) => delays.push(ms) }));
  assert.equal(hits, 3);
  assert.deepEqual(delays, [0, 0]);
  assert.equal(retried.some((event) => event.type === "text" && event.text === "好了"), true);

  let denied = 0;
  const auth = await collect(providerWith({
    async post() {
      denied += 1;
      return httpResponse(401, `secret-body-${key}`);
    },
  }));
  assert.equal(denied, 1);
  assert.deepEqual(auth.map((event) => event.type), ["error", "done"]);
  assert.equal(auth[0].code, "request_failed");
  assert.equal(JSON.stringify(auth).includes(key), false);
  assert.equal(JSON.stringify(auth).includes("secret-body"), false);

  let bad = 0;
  const other = await collect(providerWith({
    async post() {
      bad += 1;
      return httpResponse(400, "bad-request");
    },
  }));
  assert.equal(bad, 1);
  assert.equal(other[0].code, "request_failed");
});

test("连接失败最多请求 3 次，第三次仍失败就停止", async () => {
  let hits = 0;
  const events = await collect(providerWith({
    async post() {
      hits += 1;
      return { kind: "connection" };
    },
  }, { sleep: async () => {} }));
  assert.equal(hits, 3);
  assert.equal(events[0].code, "request_failed");
  assert.equal(events.at(-1).type, "done");
});

test("取消后不再请求端点", async () => {
  let hits = 0;
  const events = await collect(providerWith({
    async post() {
      hits += 1;
      return httpResponse(200, sse(["[DONE]"]));
    },
  }), { aborted: true });
  assert.equal(hits, 0);
  assert.deepEqual(events, [{ type: "error", code: "aborted" }]);
});

test("baseUrl 原样使用，代码不识别如辉域名", async () => {
  const source = fs.readFileSync(new URL("../src/openai.ts", import.meta.url), "utf8");
  const adapter = fs.readFileSync(new URL("../openai-node.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("api.rh.pub"), false);
  assert.equal(adapter.includes("api.rh.pub"), false);
  assert.equal(source.includes("node:"), false);
  const posts = [];
  await collect(providerWith({
    async post(input) {
      posts.push(input.url);
      return httpResponse(200, sse([JSON.stringify({ choices: [{ delta: { content: "甲" } }] }), "[DONE]"]));
    },
  }, { baseUrl: "https://api.rh.pub/v1/" }));
  await collect(providerWith({
    async post(input) {
      posts.push(input.url);
      return httpResponse(200, sse([JSON.stringify({ choices: [{ delta: { content: "乙" } }] }), "[DONE]"]));
    },
  }, { baseUrl: "http://127.0.0.1:9/v1", apiKey: otherKey }));
  assert.deepEqual(posts, ["https://api.rh.pub/v1/chat/completions", "http://127.0.0.1:9/v1/chat/completions"]);
});

test("本地夹具换 baseUrl 和密钥环境变量后，请求发往新地址", async () => {
  const seen = [];
  const first = await listen(async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([JSON.stringify({ choices: [{ delta: { content: "来自甲" } }] }), "[DONE]"]));
  });
  const second = await listen(async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([JSON.stringify({ choices: [{ delta: { content: "来自乙" } }] }), "[DONE]"]));
  });
  try {
    const alpha = nodeOpenAIProvider({
      baseUrl: first.baseUrl,
      model: "auto",
      apiKeyEnv: "RUHUI_API_KEY",
      env: { RUHUI_API_KEY: key },
    });
    const fromAlpha = await collect(alpha);
    const beta = nodeOpenAIProvider({
      baseUrl: second.baseUrl,
      model: "auto",
      apiKeyEnv: "RUHUI_OTHER_KEY",
      env: { RUHUI_OTHER_KEY: otherKey },
    });
    const fromBeta = await collect(beta);
    assert.equal(fromAlpha.some((event) => event.type === "text" && event.text === "来自甲"), true);
    assert.equal(fromBeta.some((event) => event.type === "text" && event.text === "来自乙"), true);
    assert.deepEqual(seen, [
      { url: "/v1/chat/completions", authorization: `Bearer ${key}` },
      { url: "/v1/chat/completions", authorization: `Bearer ${otherKey}` },
    ]);
  } finally {
    await first.close();
    await second.close();
  }
});

test("本地 429 向同一个夹具再请求，第三次成功", async () => {
  let hits = 0;
  const server = await listen(async (_req, res) => {
    hits += 1;
    if (hits < 3) {
      res.writeHead(429, { "retry-after": "0" });
      res.end("later");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([JSON.stringify({ choices: [{ delta: { content: "重试后" } }] }), "[DONE]"]));
  });
  try {
    const events = await collect(nodeOpenAIProvider({
      baseUrl: server.baseUrl,
      model: "auto",
      env: { RUHUI_API_KEY: key },
    }));
    assert.equal(hits, 3);
    assert.equal(events.some((event) => event.type === "text" && event.text === "重试后"), true);
  } finally {
    await server.close();
  }
});

test("本地 401 让 Loop 停止，并且只请求一次", async () => {
  let hits = 0;
  const server = await listen(async (_req, res) => {
    hits += 1;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(`{"error":"${key}"}`);
  });
  try {
    const files = new Map();
    const opened = openRollout({
      files: {
        read: (name) => files.get(name) ?? null,
        write: (name, text) => files.set(name, text),
        append: (name, text) => files.set(name, (files.get(name) ?? "") + text),
        remove: (name) => files.delete(name),
      },
      sessionId: "ses_openai",
      pid: 21,
      isAlive: () => false,
      now: "2026-11-08T04:00:01.000Z",
    });
    const turn = createTurn({
      id: "trn_openai",
      sessionId: "ses_openai",
      input: { text: "阅读笔记" },
      mode: "plan",
      budget: { maxModelCalls: 4 },
    });
    const result = await runLoop({
      turn: turn.value,
      provider: nodeOpenAIProvider({
        baseUrl: server.baseUrl,
        model: "auto",
        env: { RUHUI_API_KEY: key },
      }),
      tools: { execute() { throw new Error("不应执行"); } },
      rollout: opened.value,
      now: () => "2026-11-08T04:00:01.000Z",
    });
    opened.value.release();
    assert.equal(hits, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stop, "request_failed");
    assert.equal(result.text, "模型请求失败。");
    assert.equal(result.text.includes(key), false);
  } finally {
    await server.close();
  }
});

function listen(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    void Buffer.concat(chunks);
    try {
      await handler(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
