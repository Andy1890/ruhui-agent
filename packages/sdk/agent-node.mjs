import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, validateConfig } from "../../scripts/architecture/validate-config.mjs";
import { assembleContext, createSession, createTurn, discoverInstructions, openRollout, runLoop } from "../core/dist/index.js";
import { nodeInstructionSource } from "../core/context-node.mjs";
import { nodeProcessAlive, nodeSessionFiles } from "../core/rollout-node.mjs";
import { createScriptedProvider } from "../providers/dist/index.js";
import { nodeOpenAIProvider } from "../providers/openai-node.mjs";
import { sandboxBackend } from "../sandbox/dist/index.js";
import { createPlanHandlers, executeToolBatch, phase0Tools } from "../tools/dist/index.js";
import { nodeCommandTools } from "../tools/command-node.mjs";
import { nodeFileTools } from "../tools/files-node.mjs";
import { completedWriteKeys, exitCodeFor, phase1ModeText, renderDoctor, renderRun, resolveMode, runtimeVersion, sdkEventsFor, skippedWriteResult, writeTarget } from "./dist/index.js";

const schema = loadSchema(fileURLToPath(new URL("../../schema/config.schema.json", import.meta.url)));
const budgetKeys = ["maxModelCalls", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "wallClockMs"];

export async function executeCommand(command, options) {
  const io = {
    cwd: options.cwd,
    env: options.env ?? {},
    pid: options.pid,
    signal: options.signal,
    home: homeDirectory(options.env ?? {}),
    source: nodeInstructionSource(),
  };
  try {
    if (command.kind === "doctor") {
      return doctor(command, io);
    }
    if (command.kind === "run") {
      return await runTask(command, io);
    }
    if (command.kind === "resume") {
      return await resumeTask(command, io);
    }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "运行失败。";
    return fail(1, message);
  }
  return fail(2, "用法错误。");
}

function doctor(command, io) {
  const workspace = workspaceRoot(io.cwd, io.home, io.source);
  const configs = loadConfigs(io.home, workspace);
  if (!configs.ok) {
    return fail(2, configs.text);
  }
  const mode = resolveMode({ cli: command.mode, user: configs.user.mode, project: configs.project.mode });
  if (!mode.ok) {
    return fail(2, mode.text);
  }
  return output(0, renderDoctor({
    version: runtimeVersion,
    workspaceRoot: workspace,
    mode: mode.mode,
    sandbox: sandboxBackend,
  }));
}

async function runTask(command, io) {
  const workspace = workspaceRoot(io.cwd, io.home, io.source);
  const placed = rejectHomeInside(workspace, io.home);
  if (!placed.ok) {
    return placed;
  }
  const configs = loadConfigs(io.home, workspace);
  if (!configs.ok) {
    return fail(2, configs.text);
  }
  const mode = resolveMode({ cli: command.mode, user: configs.user.mode, project: configs.project.mode });
  if (!mode.ok) {
    return fail(2, mode.text);
  }
  const provider = createProvider(io.env, configs);
  if (!provider.ok) {
    return fail(provider.exitCode, provider.text);
  }
  const sessionId = command.sessionId ?? newId("ses_");
  const created = createSession({
    id: sessionId,
    workspaceRoot: workspace,
    createdAt: timestamp(),
    runtimeVersion,
  });
  if (!created.ok) {
    return fail(1, "无法创建会话。");
  }
  const files = nodeSessionFiles(path.join(io.home, "sessions", sessionId));
  files.write("meta.json", `${JSON.stringify(created.value)}\n`);
  const budget = budgetFor(command, configs);
  return executeTurn({
    io,
    files,
    provider: provider.provider,
    workspace,
    sessionId,
    mode: mode.mode,
    budget,
    task: command.task,
    prior: [],
    resumedFrom: undefined,
  });
}

async function resumeTask(command, io) {
  const files = nodeSessionFiles(path.join(io.home, "sessions", command.sessionId));
  const raw = files.read("meta.json");
  if (raw === null) {
    return fail(1, "找不到会话。");
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return fail(1, "会话无法读取。");
  }
  if (!meta || meta.id !== command.sessionId || typeof meta.workspaceRoot !== "string" || meta.workspaceRoot.trim() === "") {
    return fail(1, "会话无法读取。");
  }
  const workspace = path.resolve(meta.workspaceRoot);
  const placed = rejectHomeInside(workspace, io.home);
  if (!placed.ok) {
    return placed;
  }
  const configs = loadConfigs(io.home, workspace);
  if (!configs.ok) {
    return fail(2, configs.text);
  }
  const provider = createProvider(io.env, configs);
  if (!provider.ok) {
    return fail(provider.exitCode, provider.text);
  }
  const rollout = openSession(files, command.sessionId, io);
  if (!rollout.ok) {
    return rollout;
  }
  try {
    const events = rollout.handle.read.events;
    const started = [...events].reverse().find((event) => event.type === "turn.started");
    if (!started || events.length === 0) {
      return fail(1, "轨迹无法恢复。");
    }
    const payload = started.payload;
    return await executeTurn({
      io,
      files,
      rollout: rollout.handle,
      provider: provider.provider,
      workspace,
      sessionId: command.sessionId,
      mode: payload.mode,
      budget: payload.budget,
      task: payload.input.text,
      prior: events,
      resumedFrom: events[events.length - 1].seq,
    });
  } finally {
    if (rollout.handle) {
      rollout.handle.release();
    }
  }
}

async function executeTurn(input) {
  const turn = createTurn({
    id: newId("trn_"),
    sessionId: input.sessionId,
    input: { text: input.task },
    mode: input.mode,
    budget: input.budget,
  });
  if (!turn.ok) {
    return fail(1, "无法创建本轮。");
  }
  const ownsRollout = input.rollout === undefined;
  const opened = ownsRollout ? openSession(input.files, input.sessionId, input.io) : { ok: true, handle: input.rollout };
  if (!opened.ok) {
    return opened;
  }
  const rollout = { ok: true, handle: observeRollout(opened.handle, input.onEvent) };
  try {
    const assembled = assembleContext({
      profile: input.provider.profile,
      os: process.platform === "win32" ? "windows" : process.platform,
      workspaceRoot: input.workspace,
      date: timestamp().slice(0, 10),
      network: false,
      sandbox: sandboxBackend,
      instructions: discoverInstructions({
        homeFile: path.join(input.io.home, "RUHUI.md"),
        cwd: input.workspace,
        source: input.io.source,
      }).files,
      tools: phase0Tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: JSON.stringify(tool.inputSchema),
      })),
      budget: input.budget.maxToolCalls === undefined ? undefined : { toolCalls: 0, maxToolCalls: input.budget.maxToolCalls },
      userText: input.task,
    });
    const result = await runLoop({
      turn: turn.value,
      provider: input.provider,
      tools: toolExecutor(input.mode, input.workspace, completedWriteKeys(input.prior), input.io.env),
      rollout: rollout.handle,
      signal: input.io.signal,
      now: timestamp,
      context: { system: assembled.system },
    });
    return output(result.exitCode, renderRun({
      sessionId: input.sessionId,
      workspaceRoot: input.workspace,
      mode: input.mode,
      sandbox: sandboxBackend,
      tools: shownTools(rollout.handle.read.events, turn.value.id),
      text: result.text,
      stop: result.stop,
      resumedFrom: input.resumedFrom,
    }));
  } finally {
    if (ownsRollout) {
      rollout.handle.release();
    }
  }
}

function observeRollout(handle, onEvent) {
  if (!onEvent) {
    return handle;
  }
  return {
    get read() {
      return handle.read;
    },
    append(input) {
      const written = handle.append(input);
      if (written.ok) {
        for (const event of sdkEventsFor(written.value)) {
          onEvent(event);
        }
      }
      return written;
    },
    release() {
      handle.release();
    },
  };
}

export class Agent {
  constructor(options = {}) {
    this.options = options;
  }

  async run(task) {
    let completed = null;
    let requested = null;
    let sessionId = "";
    for await (const event of this.stream(task)) {
      sessionId = event.sessionId;
      if (event.type === "turn.completed") {
        completed = event;
      }
      if (event.type === "user.requested") {
        requested = event;
      }
    }
    if (requested && !completed) {
      return { text: requested.question, sessionId, status: "waiting_user", exitCode: 3 };
    }
    if (!completed) {
      return { text: "", sessionId, status: "failed", exitCode: 1 };
    }
    return { text: completed.text, sessionId, status: completed.status, exitCode: exitCodeFor(completed.status) };
  }

  async *stream(task) {
    const queue = [];
    let notify = () => {};
    let finished = false;
    let failure = null;
    const pending = runObserved(this.options, task, (event) => {
      queue.push(event);
      notify();
    }).then(
      () => {
        finished = true;
        notify();
      },
      (error) => {
        failure = error;
        finished = true;
        notify();
      },
    );
    while (queue.length > 0 || !finished) {
      if (queue.length === 0) {
        await new Promise((resolve) => {
          notify = resolve;
        });
        continue;
      }
      yield queue.shift();
    }
    await pending;
    if (failure) {
      throw failure;
    }
  }
}

async function runObserved(options, task, onEvent) {
  if (typeof task !== "string" || task.trim() === "") {
    throw new Error("任务不能为空。");
  }
  if (options.mode === "default" || options.mode === "full") {
    throw new Error(phase1ModeText);
  }
  const env = options.env ?? {};
  const home = typeof options.home === "string" && options.home.trim() !== "" ? path.resolve(options.home) : homeDirectory(env);
  const source = nodeInstructionSource();
  if (typeof options.workspace !== "string" || options.workspace.trim() === "") {
    throw new Error("需要工作区。");
  }
  const workspace = workspaceRoot(options.workspace, home, source);
  const placed = rejectHomeInside(workspace, home);
  if (!placed.ok) {
    throw new Error(placed.stderr.trim());
  }
  const configs = loadConfigs(home, workspace);
  if (!configs.ok) {
    throw new Error(configs.text);
  }
  const mode = resolveMode({ cli: options.mode, user: configs.user.mode, project: configs.project.mode });
  if (!mode.ok) {
    throw new Error(mode.text);
  }
  const provider = Array.isArray(options.script)
    ? { ok: true, provider: createScriptedProvider(options.script) }
    : createProvider(env, configs);
  if (!provider.ok) {
    throw new Error(provider.text);
  }
  const sessionId = options.sessionId ?? newId("ses_");
  const created = createSession({
    id: sessionId,
    workspaceRoot: workspace,
    createdAt: timestamp(),
    runtimeVersion,
  });
  if (!created.ok) {
    throw new Error("无法创建会话。");
  }
  const files = nodeSessionFiles(path.join(home, "sessions", sessionId));
  files.write("meta.json", `${JSON.stringify(created.value)}\n`);
  const rendered = await executeTurn({
    io: { env, pid: process.pid, signal: options.signal, home, source },
    files,
    provider: provider.provider,
    workspace,
    sessionId,
    mode: mode.mode,
    budget: budgetFor({ maxToolCalls: options.budget?.maxToolCalls }, configs),
    task,
    prior: [],
    resumedFrom: undefined,
    onEvent,
  });
  if (rendered.stderr) {
    throw new Error(rendered.stderr.trim());
  }
  return rendered;
}

function toolExecutor(mode, workspace, priorKeys, env) {
  const plan = { steps: [] };
  const files = nodeFileTools(workspace);
  const commands = nodeCommandTools(workspace);
  const handlers = { ...files.handlers, ...commands.handlers, ...createPlanHandlers({ plan }) };
  const keys = new Set(priorKeys);
  const abortAfter = typeof env.RUHUI_ABORT_AFTER === "string" ? env.RUHUI_ABORT_AFTER : "";
  return {
    async execute(call, signal) {
      const target = writeTarget(call.arguments);
      if (target !== "" && keys.has(`${call.name}\n${target}`)) {
        return skippedWriteResult(call.name, target);
      }
      const [outcome] = await executeToolBatch({ calls: [call], mode, handlers });
      if (abortAfter !== "" && call.name === abortAfter && outcome.result.status === "ok") {
        signal.aborted = true;
      }
      return outcome.result;
    },
  };
}

function openSession(files, sessionId, io) {
  const opened = openRollout({
    files,
    sessionId,
    pid: io.pid,
    isAlive: nodeProcessAlive,
    now: timestamp(),
    secrets: ["RUHUI_API_KEY", "RUHUI_OTHER_KEY"]
      .map((name) => io.env[name])
      .filter((value) => typeof value === "string" && value.length > 0),
  });
  if (!opened.ok) {
    return fail(1, opened.error === "locked" ? "会话正在使用。" : opened.error === "seq-gap" ? "轨迹断号，拒绝恢复。" : "轨迹无法恢复。");
  }
  return { ok: true, handle: opened.value };
}

function shownTools(events, turnId) {
  const args = new Map();
  for (const event of events) {
    if (event.turnId === turnId && event.type === "tool.started") {
      args.set(event.payload.callId, event.payload.arguments);
    }
  }
  const tools = [];
  for (const event of events) {
    if (event.turnId !== turnId || event.type !== "tool.finished") {
      continue;
    }
    tools.push({
      name: event.payload.name,
      arguments: args.get(event.payload.callId) ?? {},
      status: event.payload.result.status,
      text: visibleText(event.payload.result),
    });
  }
  return tools;
}

function visibleText(result) {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const block = blocks.find((item) => item && typeof item.text === "string" && item.text !== "");
  if (block) {
    return block.text;
  }
  return typeof result.correctiveHint === "string" ? result.correctiveHint : "";
}

function createProvider(env, configs) {
  if (env.RUHUI_PROVIDER === "scripted") {
    if (typeof env.RUHUI_SCRIPT !== "string" || env.RUHUI_SCRIPT === "") {
      return { ok: false, exitCode: 1, text: "未提供假模型脚本。" };
    }
    let script;
    try {
      script = JSON.parse(fs.readFileSync(env.RUHUI_SCRIPT, "utf8"));
    } catch {
      return { ok: false, exitCode: 1, text: "假模型脚本无法读取。" };
    }
    if (!Array.isArray(script)) {
      return { ok: false, exitCode: 1, text: "假模型脚本必须是数组。" };
    }
    return { ok: true, provider: createScriptedProvider(script) };
  }
  const model = configs.project.model ?? configs.user.model;
  if (!model || typeof model.baseUrl !== "string" || typeof model.model !== "string") {
    return { ok: false, exitCode: 1, text: "未配置模型。" };
  }
  return {
    ok: true,
    provider: nodeOpenAIProvider({
      baseUrl: model.baseUrl,
      model: model.model,
      apiKeyEnv: model.apiKeyEnv,
      env,
    }),
  };
}

function loadConfigs(home, workspace) {
  const user = readConfig(path.join(home, "config.json"), "用户配置");
  if (!user.ok) {
    return user;
  }
  const project = readConfig(path.join(workspace, ".ruhui", "config.json"), "项目配置");
  if (!project.ok) {
    return project;
  }
  return { ok: true, user: user.value, project: project.value };
}

function readConfig(file, label) {
  if (!fs.existsSync(file)) {
    return { ok: true, value: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, text: `${label}不是合法 JSON。` };
  }
  if (parsed && typeof parsed === "object" && (parsed.mode === "default" || parsed.mode === "full")) {
    return { ok: false, text: phase1ModeText };
  }
  const errors = validateConfig(schema, parsed);
  if (errors.length > 0) {
    return { ok: false, text: `${label}${errors[0]}` };
  }
  return { ok: true, value: parsed };
}

function budgetFor(command, configs) {
  const budget = {};
  const configured = { ...(configs.user.budget ?? {}), ...(configs.project.budget ?? {}) };
  for (const key of budgetKeys) {
    if (configured[key] !== undefined) {
      budget[key] = configured[key];
    }
  }
  if (command.maxToolCalls !== undefined) {
    budget.maxToolCalls = command.maxToolCalls;
  }
  return budget;
}

function workspaceRoot(cwd, home, source) {
  const found = discoverInstructions({ homeFile: path.join(home, "RUHUI.md"), cwd, source });
  return path.resolve(found.root);
}

function homeDirectory(env) {
  if (typeof env.RUHUI_HOME === "string" && env.RUHUI_HOME.trim() !== "") {
    return path.resolve(env.RUHUI_HOME);
  }
  return path.join(os.homedir(), ".ruhui");
}

function rejectHomeInside(workspace, home) {
  const relative = path.relative(workspace, home);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return fail(1, "RUHUI_HOME 不能放在工作区里面。");
  }
  return { ok: true };
}

function newId(prefix) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let body = Date.now().toString(36);
  for (let count = 0; count < 6; count += 1) {
    body += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${prefix}${body}`;
}

function timestamp() {
  return new Date().toISOString();
}

function output(exitCode, text) {
  return { exitCode, stdout: `${text}\n`, stderr: "" };
}

function fail(exitCode, text) {
  return { exitCode, stdout: "", stderr: text.endsWith("\n") ? text : `${text}\n` };
}
