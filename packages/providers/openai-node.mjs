import http from "node:http";
import https from "node:https";
import { createOpenAICompatibleProvider } from "./dist/index.js";

export function nodeOpenAIProvider(options) {
  const env = options.env ?? process.env;
  const apiKeyEnv = options.apiKeyEnv ?? "RUHUI_API_KEY";
  const apiKey = typeof env[apiKeyEnv] === "string" ? env[apiKeyEnv] : "";
  return createOpenAICompatibleProvider({
    baseUrl: options.baseUrl,
    model: options.model,
    apiKey,
    profile: options.profile,
    transport: nodeTransport(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

function nodeTransport() {
  return {
    post({ url, headers, body }) {
      return new Promise((resolve) => {
        let target;
        try {
          target = new URL(url);
        } catch {
          resolve({ kind: "connection" });
          return;
        }
        const lib = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
        if (!lib) {
          resolve({ kind: "connection" });
          return;
        }
        const request = lib.request(
          target,
          {
            method: "POST",
            headers: {
              ...headers,
              "content-length": Buffer.byteLength(body).toString(),
            },
          },
          (response) => {
            response.setEncoding("utf8");
            resolve({
              kind: "response",
              status: response.statusCode ?? 0,
              headers: flatHeaders(response.headers),
              chunks: chunksOf(response),
            });
          },
        );
        request.on("error", () => resolve({ kind: "connection" }));
        request.end(body);
      });
    },
  };
}

function flatHeaders(headers) {
  const flat = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      flat[name.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      flat[name.toLowerCase()] = value.join(", ");
    }
  }
  return flat;
}

async function* chunksOf(response) {
  for await (const chunk of response) {
    yield chunk;
  }
}
