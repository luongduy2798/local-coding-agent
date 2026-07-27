import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const MIN_NODE_VERSION = "22.13.0";

function versionParts(version) {
  const match = String(version || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function compareNodeVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function nodeInstallGuidance(platform = process.platform, { wsl = false } = {}) {
  if (platform === "darwin") {
    return "Install Node.js 22 LTS from https://nodejs.org/ or run `brew install node@22`, then open a new terminal.";
  }
  if (platform === "win32") {
    return "Install Node.js 22 LTS from https://nodejs.org/ or run `winget install OpenJS.NodeJS.LTS`, then open a new terminal.";
  }
  if (platform === "linux" || wsl) {
    return "Install Node.js 22 LTS with your package/version manager (for example `nvm install 22 && nvm use 22`), then open a new shell.";
  }
  return "Install Node.js 22 LTS from https://nodejs.org/, then open a new terminal.";
}

export function assertSupportedNodeVersion(
  version = process.versions.node,
  platform = process.platform,
  options = {}
) {
  const comparison = compareNodeVersions(version, MIN_NODE_VERSION);
  if (comparison === null || comparison < 0) {
    throw new Error(
      `Node.js >=${MIN_NODE_VERSION} is required. Current version: ${String(version || "unknown")}. ${nodeInstallGuidance(platform, options)}`
    );
  }
  return true;
}

function capture(command, args) {
  return new Promise((resolveCapture) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveCapture(result);
    };
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: 127, stdout, stderr: error.message }));
    child.on("exit", (code) => finish({ code, stdout, stderr }));
  });
}

function pidIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupIsAlive(processGroupId) {
  const numericGroupId = Number(processGroupId);
  if (process.platform === "win32" || !Number.isInteger(numericGroupId) || numericGroupId <= 0) {
    return false;
  }
  try {
    process.kill(-numericGroupId, 0);
    return true;
  } catch (error) {
    // EPERM still proves that the process group exists; it merely means the
    // current user is not allowed to signal it.
    return error?.code === "EPERM";
  }
}

function firstCommandToken(command) {
  const value = String(command || "").trim();
  if (!value) return "";
  if (value.startsWith('"')) return value.match(/^"([^"]+)"/)?.[1] || "";
  if (value.startsWith("'")) return value.match(/^'([^']+)'/)?.[1] || "";
  return value.split(/\s+/, 1)[0];
}

function executableMatches(expected, observed, command = "") {
  if (!expected) return true;
  const expectedText = String(expected).trim();
  const candidates = [observed, firstCommandToken(command)].filter(Boolean).map(String);
  if (!candidates.length) return false;
  const normalize = (value) => {
    const normalized = process.platform === "win32" ? value.toLowerCase() : value;
    return normalized.replace(/^["']|["']$/g, "");
  };
  const expectedNormalized = normalize(expectedText);
  const expectedBase = normalize(basename(expectedText));
  const expectsPath = expectedText.includes("/") || expectedText.includes("\\");
  return candidates.some((candidate) => {
    const normalized = normalize(candidate);
    if (normalized === expectedNormalized) return true;
    return !expectsPath && normalize(basename(normalized)) === expectedBase;
  });
}

async function inspectLinuxProcess(pid) {
  try {
    const [stat, commandBuffer] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`)
    ]);
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return null;
    const fieldsAfterName = stat.slice(closingParen + 2).trim().split(/\s+/);
    const startToken = fieldsAfterName[19] || "";
    const processGroupId = Number(fieldsAfterName[2]) || null;
    let executable = "";
    try {
      executable = await readlink(`/proc/${pid}/exe`);
    } catch {
      // The command line still provides an executable verification fallback.
    }
    const command = commandBuffer.toString("utf8").split("\0").filter(Boolean).join(" ");
    return {
      alive: true,
      pid: Number(pid),
      startToken,
      processGroupId,
      executable,
      command
    };
  } catch {
    return null;
  }
}

async function inspectPosixProcess(pid) {
  const [result, group] = await Promise.all([
    capture("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="]),
    capture("ps", ["-p", String(pid), "-o", "pgid="])
  ]);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  const value = result.stdout.trim();
  const match = value.match(/^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]*)$/);
  if (!match) return null;
  const command = match[2].trim();
  const startedTime = Date.parse(match[1]);
  return {
    alive: true,
    pid: Number(pid),
    startToken: match[1].replace(/\s+/g, " "),
    startedAt: Number.isFinite(startedTime) ? new Date(startedTime).toISOString() : "",
    processGroupId: group.code === 0 ? Number(group.stdout.trim()) || null : null,
    executable: firstCommandToken(command),
    command
  };
}

async function inspectWindowsProcess(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"`,
    "if ($null -eq $p) { exit 3 }",
    "$started = (Get-Process -Id $p.ProcessId).StartTime.ToUniversalTime().ToString('o')",
    "[pscustomobject]@{ pid = [int]$p.ProcessId; startToken = $started; startedAt = $started; executable = [string]$p.ExecutablePath; command = [string]$p.CommandLine } | ConvertTo-Json -Compress"
  ].join("; ");
  const result = await capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  try {
    return { alive: true, ...JSON.parse(result.stdout.trim()) };
  } catch {
    return null;
  }
}

export async function inspectProcess(pid) {
  const numericPid = Number(pid);
  if (!pidIsAlive(numericPid)) return { alive: false, pid: numericPid || null };
  let observed = null;
  if (process.platform === "linux") observed = await inspectLinuxProcess(numericPid);
  else if (process.platform === "win32") observed = await inspectWindowsProcess(numericPid);
  else observed = await inspectPosixProcess(numericPid);
  return observed || { alive: pidIsAlive(numericPid), pid: numericPid };
}

export function processIdentityMatches(record, observed, expected = {}) {
  if (!record || !observed?.alive) return false;
  if (Number(record.pid) !== Number(observed.pid)) return false;
  if (expected.instanceNonce && record.instanceNonce !== expected.instanceNonce) return false;
  if (expected.role && record.role !== expected.role) return false;
  if (record.startToken && observed.startToken && record.startToken !== observed.startToken) return false;
  if (
    record.processGroupId &&
    observed.processGroupId &&
    Number(record.processGroupId) !== Number(observed.processGroupId)
  ) return false;
  if (record.startedAt && observed.startedAt) {
    const recordedTime = Date.parse(record.startedAt);
    const observedTime = Date.parse(observed.startedAt);
    if (Number.isFinite(recordedTime) && Number.isFinite(observedTime) && Math.abs(recordedTime - observedTime) > 2000) {
      return false;
    }
  }
  const executable = expected.executable || record.executable || record.expectedExecutable;
  if (!executableMatches(executable, observed.executable, observed.command)) return false;
  const commandMarker = expected.commandMarker || record.commandMarker;
  if (commandMarker && !String(observed.command || "").includes(commandMarker)) return false;
  return true;
}

export function createProcessRecord({
  role,
  pid,
  instanceNonce,
  expectedExecutable,
  commandMarker,
  observed,
  spawnedAt = new Date().toISOString()
}) {
  if (!processIdentityMatches(
    {
      pid,
      role,
      instanceNonce,
      expectedExecutable,
      commandMarker
    },
    observed,
    { instanceNonce, role, executable: expectedExecutable, commandMarker }
  )) {
    throw new Error(`Could not verify ${role} process identity for PID ${pid}.`);
  }
  return {
    pid: Number(pid),
    role,
    instanceNonce,
    spawnedAt,
    startedAt: observed.startedAt || "",
    startToken: observed.startToken || "",
    processGroupId: observed.processGroupId || null,
    executable: observed.executable || "",
    expectedExecutable: expectedExecutable || "",
    commandMarker: commandMarker || ""
  };
}

export async function adoptProcessRecord({
  role,
  pid,
  instanceNonce,
  expectedExecutable,
  commandMarker
}) {
  const observed = await inspectProcess(pid);
  if (!observed.alive) return { record: null, observed, reason: "not-running" };
  try {
    return {
      record: createProcessRecord({
        role,
        pid,
        instanceNonce,
        expectedExecutable,
        commandMarker,
        observed
      }),
      observed,
      reason: "verified"
    };
  } catch {
    return { record: null, observed, reason: "identity-mismatch" };
  }
}

export async function verifyProcessRecord(record, expected = {}) {
  if (!record?.pid) return { verified: false, alive: false, observed: null, reason: "missing-record" };
  const observed = await inspectProcess(record.pid);
  if (!observed.alive) return { verified: false, alive: false, observed, reason: "not-running" };
  const verified = processIdentityMatches(record, observed, expected);
  return {
    verified,
    alive: true,
    observed,
    reason: verified ? "verified" : "identity-mismatch"
  };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !pidIsAlive(pid);
}

async function waitForTermination(pid, processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processStopped = !pidIsAlive(pid);
    const groupStopped = !processGroupId || !processGroupIsAlive(processGroupId);
    if (processStopped && groupStopped) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !pidIsAlive(pid) && (!processGroupId || !processGroupIsAlive(processGroupId));
}

async function ownedTerminationGroup(record, verification) {
  if (process.platform === "win32") return null;
  const pid = Number(record?.pid);
  const savedGroupId = Number(record?.processGroupId);
  const observedGroupId = Number(verification?.observed?.processGroupId);
  if (
    !Number.isInteger(pid) || pid <= 0 ||
    !Number.isInteger(savedGroupId) || savedGroupId <= 0 ||
    savedGroupId !== observedGroupId ||
    savedGroupId !== pid
  ) {
    return null;
  }

  // A detached POSIX child becomes the leader of its own process group. Only
  // that exact shape is eligible for group shutdown. In particular, a
  // foreground process sharing the caller's terminal group is never signalled
  // as a group.
  const caller = await inspectProcess(process.pid);
  if (Number(caller?.processGroupId) === savedGroupId) return null;
  return savedGroupId;
}

export async function terminateProcessRecord(record, expected = {}, { timeoutMs = 4000 } = {}) {
  const verification = await verifyProcessRecord(record, expected);
  if (!verification.alive) return { stopped: true, verified: false, reason: "not-running" };
  if (!verification.verified) return { stopped: false, verified: false, reason: "identity-mismatch" };

  if (process.platform === "win32") {
    const result = await capture("taskkill.exe", ["/pid", String(record.pid), "/T", "/F"]);
    const stopped = await waitForExit(record.pid, timeoutMs);
    return { stopped, verified: true, reason: stopped ? "stopped" : (result.stderr.trim() || "timeout") };
  }

  const processGroupId = await ownedTerminationGroup(record, verification);
  const signalTarget = processGroupId ? -processGroupId : Number(record.pid);
  const scope = processGroupId ? "process-group" : "process";

  try {
    process.kill(signalTarget, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") {
      const stopped = await waitForTermination(record.pid, processGroupId, 250);
      return { stopped, verified: true, reason: stopped ? "not-running" : "signal-target-missing", scope };
    }
    return { stopped: false, verified: true, reason: error?.message || "signal-failed", scope };
  }
  if (await waitForTermination(record.pid, processGroupId, timeoutMs)) {
    return { stopped: true, verified: true, reason: "stopped", scope };
  }

  const finalVerification = await verifyProcessRecord(record, expected);
  if (finalVerification.alive && !finalVerification.verified) {
    return {
      stopped: false,
      verified: false,
      reason: "identity-changed-before-force-kill",
      scope
    };
  }

  // If the verified group leader exited while a descendant remained, the PGID
  // is still occupied by that same group and cannot be reused until the last
  // member exits. It is therefore safe to finish the already-verified group.
  if (!finalVerification.alive && !processGroupId) {
    return { stopped: true, verified: true, reason: "stopped", scope };
  }
  try {
    process.kill(signalTarget, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") {
      const stopped = await waitForTermination(record.pid, processGroupId, 250);
      return { stopped, verified: true, reason: stopped ? "stopped" : "force-target-missing", scope };
    }
    return { stopped: false, verified: true, reason: error?.message || "force-signal-failed", scope };
  }
  const stopped = await waitForTermination(record.pid, processGroupId, 1500);
  return { stopped, verified: true, reason: stopped ? "force-stopped" : "timeout", scope };
}

export async function atomicWriteJson(path, value, { mode = 0o600 } = {}) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode
    });
    try {
      await chmod(tempPath, mode);
    } catch {
      // Windows may ignore POSIX file modes.
    }
    await rename(tempPath, path);
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // The atomic rename already consumed the temporary file.
    }
  }
}

export function newInstanceNonce() {
  return randomUUID();
}

export function expectedExecutablePath(command, cwd = process.cwd()) {
  const value = String(command || "").trim();
  if (!value) return "";
  if (value.includes("/") || value.includes("\\")) return resolve(cwd, value);
  return value;
}
