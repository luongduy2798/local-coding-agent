// Local Coding Agent command and process execution services
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

let ALLOW_DANGEROUS;
let CATASTROPHIC;
let MAX_COMMAND_OUTPUT;
let MODE;
let PRIMARY_ROOT;
let PROC_BUFFER;
let SAFE_MODE_BLOCKS;
let appendLimited;
let hasCommand;
let isoNow;
let processes;

export function configureExecutionServices(dependencies) {
  ({
    ALLOW_DANGEROUS,
    CATASTROPHIC,
    MAX_COMMAND_OUTPUT,
    MODE,
    PRIMARY_ROOT,
    PROC_BUFFER,
    SAFE_MODE_BLOCKS,
    appendLimited,
    hasCommand,
    isoNow,
    processes
  } = dependencies);
}

export function assertCommandAllowed(command) {
  const cmd = String(command);
  if (!ALLOW_DANGEROUS && CATASTROPHIC.some((re) => re.test(cmd))) {
    throw new Error("Command blocked: catastrophic system operation (set AGENT_ALLOW_DANGEROUS=1 to override).");
  }
  if (MODE !== "full" && SAFE_MODE_BLOCKS.some((re) => re.test(cmd))) {
    throw new Error("Command blocked by safe mode. Switch to AGENT_MODE=full for unrestricted in-root commands.");
  }
}

export function defaultShell() {
  if (process.platform === "win32") return "cmd";
  return hasCommand("bash") ? "bash" : "sh";
}

function buildSpawn(command, shell) {
  const s = shell || defaultShell();
  if (s === "powershell") {
    const file = process.platform === "win32" ? "powershell.exe" : hasCommand("pwsh") ? "pwsh" : "powershell";
    return { file, args: ["-NoProfile", "-NonInteractive", "-Command", command], opts: {} };
  }
  if (s === "bash") {
    return { file: "bash", args: ["-lc", command], opts: {} };
  }
  if (s === "sh") {
    return { file: "sh", args: ["-c", command], opts: {} };
  }
  if (s === "zsh") {
    return { file: "zsh", args: ["-lc", command], opts: {} };
  }
  // cmd / default: rely on the OS shell so pipes/redirects work.
  return { file: command, args: [], opts: { shell: true } };
}

function spawnOptions(cwd, opts = {}, env) {
  return {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    ...(env ? { env } : {}),
    ...opts
  };
}

function terminateChildTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export function runShellCommand(command, cwd, shell, timeoutMs, workspaceRoot = PRIMARY_ROOT) {
  const { file, args, opts } = buildSpawn(command, shell);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, spawnOptions(cwd, opts, {
        ...process.env,
        AGENT_WORKSPACE: path.resolve(workspaceRoot)
      }));
    } catch (err) {
      resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout = appendLimited(stdout, c.toString(), MAX_COMMAND_OUTPUT)));
    child.stderr?.on("data", (c) => (stderr = appendLimited(stderr, c.toString(), MAX_COMMAND_OUTPUT)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit_code: null, timed_out: timedOut, stdout, stderr: stderr + String(err?.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code, timed_out: timedOut, stdout, stderr });
    });
  });
}

export function spawnCapture(file, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, spawnOptions(cwd));
    } catch (err) {
      resolve({
        exit_code: null,
        timed_out: false,
        stdout: "",
        stderr: String(err?.message || err),
        stdout_truncated: false,
        stderr_truncated: false
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (c) => {
      stdoutBytes += c.length;
      stdout = appendLimited(stdout, c.toString(), MAX_COMMAND_OUTPUT);
    });
    child.stderr?.on("data", (c) => {
      stderrBytes += c.length;
      stderr = appendLimited(stderr, c.toString(), MAX_COMMAND_OUTPUT);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exit_code: null,
        timed_out: timedOut,
        stdout,
        stderr: stderr + String(err?.message || err),
        stdout_truncated: stdoutBytes > Buffer.byteLength(stdout),
        stderr_truncated: stderrBytes > Buffer.byteLength(stderr)
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        timed_out: timedOut,
        stdout,
        stderr,
        stdout_truncated: stdoutBytes > Buffer.byteLength(stdout),
        stderr_truncated: stderrBytes > Buffer.byteLength(stderr)
      });
    });
  });
}

export function spawnOutputHash(file, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (exitCode, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: exitCode,
        timed_out: timedOut,
        stdout_hash: hash.digest("hex"),
        stdout_bytes: stdoutBytes,
        stderr: appendLimited(stderr, error ? String(error?.message || error) : "", 8_000)
      });
    };
    try {
      child = spawn(file, args, spawnOptions(cwd));
    } catch (error) {
      resolve({
        exit_code: null,
        timed_out: false,
        stdout_hash: null,
        stdout_bytes: 0,
        stderr: String(error?.message || error)
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      hash.update(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), 8_000);
    });
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
}

export function startBackground(command, cwd, shell, name, workspaceRoot = PRIMARY_ROOT) {
  const { file, args, opts } = buildSpawn(command, shell);
  const child = spawn(file, args, spawnOptions(cwd, opts, {
    ...process.env,
    AGENT_WORKSPACE: path.resolve(workspaceRoot)
  }));
  const proc = {
    id: randomUUID(),
    name: name || command.slice(0, 40),
    command,
    child,
    status: "running",
    exitCode: null,
    startedAt: isoNow(),
    stdout: "",
    stderr: ""
  };
  child.stdout?.on("data", (c) => (proc.stdout = appendLimited(proc.stdout, c.toString(), PROC_BUFFER)));
  child.stderr?.on("data", (c) => (proc.stderr = appendLimited(proc.stderr, c.toString(), PROC_BUFFER)));
  child.on("error", (err) => {
    proc.status = "error";
    proc.stderr = appendLimited(proc.stderr, String(err?.message || err), PROC_BUFFER);
  });
  child.on("close", (code) => {
    proc.status = "exited";
    proc.exitCode = code;
  });
  processes.set(proc.id, proc);
  return proc;
}

export function killProcessTree(proc) {
  if (!proc?.child || proc.status !== "running") {
    if (proc) proc.status = proc.status === "running" ? "stopped" : proc.status;
    return;
  }
  const pid = proc.child.pid;
  try {
    if (pid) terminateChildTree(proc.child, "SIGTERM");
  } catch {}
  proc.status = "stopped";
}
