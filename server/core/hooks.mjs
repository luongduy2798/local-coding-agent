// User-configured lifecycle hooks. Hooks only run when explicitly present in
// .agent/hooks.json, preserving the explicit-only verification contract.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildChildEnv } from "./child-env.mjs";
import { wrapSpawnSpec } from "./execution-boundary.mjs";

export const HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "TaskCreated", "PlanCreated",
  "BeforeImplement", "BeforeTool", "AfterTool", "BeforeMutation",
  "AfterMutation", "BeforeVerification", "AfterVerification",
  "BeforeCheckpoint", "AfterCheckpoint", "TaskCompleted", "TaskFailed"
];

function normalizeHook(raw) {
  if (typeof raw === "string") return { command: raw, shell: true, timeoutMs: 60000, blocking: true };
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw.command)) {
    const [file, ...args] = raw.command.map(String);
    return { file, args, shell: false, timeoutMs: raw.timeout_ms || raw.timeoutMs || 60000, blocking: raw.blocking !== false, cwd: raw.cwd, env: raw.env || {} };
  }
  if (typeof raw.file === "string") return { file: raw.file, args: Array.isArray(raw.args) ? raw.args.map(String) : [], shell: false, timeoutMs: raw.timeout_ms || raw.timeoutMs || 60000, blocking: raw.blocking !== false, cwd: raw.cwd, env: raw.env || {} };
  if (typeof raw.command === "string") return { command: raw.command, shell: true, timeoutMs: raw.timeout_ms || raw.timeoutMs || 60000, blocking: raw.blocking !== false, cwd: raw.cwd, env: raw.env || {} };
  return null;
}

function hookSpawnSpec(hook) {
  if (!hook.shell) return { file: hook.file, args: hook.args || [], opts: {} };
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", hook.command], opts: {} };
  }
  return { file: process.env.SHELL || "/bin/sh", args: ["-lc", hook.command], opts: {} };
}

function runOne(hook, root, event, payload, excludedEnv = [], accessMode = "full") {
  return new Promise((resolve) => {
    const cwd = path.resolve(root, hook.cwd || ".");
    const env = buildChildEnv(process.env, {
      AGENT_WORKSPACE: root,
      LCA_HOOK_EVENT: event,
      LCA_HOOK_PAYLOAD: JSON.stringify(payload || {}),
      ...(hook.env || {})
    }, { exclude: excludedEnv });
    const wrapped = wrapSpawnSpec(hookSpawnSpec(hook), cwd, accessMode);
    const options = { cwd, env, windowsHide: true, ...(wrapped.opts || {}) };
    const child = spawn(wrapped.file, wrapped.args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { if (stdout.length < 50000) stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < 50000) stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      resolve({ ok: false, timed_out: true, exit_code: null, stdout, stderr });
    }, Math.max(1000, Number(hook.timeoutMs || 60000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, timed_out: false, exit_code: null, error: String(error?.message || error), stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, timed_out: false, exit_code: code, signal, stdout, stderr });
    });
  });
}

export function createHookManager({ root, excludedEnv = [], accessMode = "full" }) {
  const configPath = path.join(root, ".agent", "hooks.json");
  let cache = null;
  let loadedAt = null;

  async function load(force = false) {
    if (!force && cache) return cache;
    if (!existsSync(configPath)) {
      cache = {};
      loadedAt = new Date().toISOString();
      return cache;
    }
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    cache = {};
    for (const event of HOOK_EVENTS) {
      const entries = Array.isArray(parsed[event]) ? parsed[event] : parsed[event] ? [parsed[event]] : [];
      cache[event] = entries.map(normalizeHook).filter(Boolean);
    }
    loadedAt = new Date().toISOString();
    return cache;
  }

  async function run(event, payload = {}, options = {}) {
    if (!HOOK_EVENTS.includes(event)) throw new Error(`Unsupported hook event: ${event}`);
    const config = await load();
    const hooks = config[event] || [];
    const results = [];
    for (let index = 0; index < hooks.length; index++) {
      const hook = hooks[index];
      if (hook.blocking === false && options.awaitNonBlocking !== true) {
        runOne(hook, root, event, payload, excludedEnv, accessMode).catch(() => {});
        results.push({ index, scheduled: true, blocking: false });
        continue;
      }
      const result = await runOne(hook, root, event, payload, excludedEnv, accessMode);
      results.push({ index, blocking: hook.blocking !== false, ...result });
      if (!result.ok && hook.blocking !== false) break;
    }
    return { ok: results.every((item) => item.ok !== false), event, configured: hooks.length, results };
  }

  async function status() {
    const config = await load();
    return {
      path: configPath,
      exists: existsSync(configPath),
      loadedAt,
      events: Object.fromEntries(HOOK_EVENTS.map((event) => [event, (config[event] || []).length])),
      explicitOnly: true
    };
  }

  return { load, run, status, configPath };
}
