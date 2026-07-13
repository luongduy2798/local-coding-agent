// OS command boundary. Full mode bypasses all wrapping. Balanced/safe use a
// native sandbox adapter when one is available, while existing policy checks
// still decide which commands may be attempted.

import path from "node:path";
import { existsSync } from "node:fs";

function seatbeltEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function macProfile(cwd, accessMode) {
  const workspace = seatbeltEscape(path.resolve(cwd));
  const home = seatbeltEscape(process.env.HOME || "/Users");
  const network = accessMode === "balanced" ? "(allow network*)" : "";
  return [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    `(allow file-write* (subpath \"${workspace}\") (subpath \"/tmp\") (subpath \"/private/tmp\") (subpath \"${home}/Library/Caches\"))`,
    network
  ].filter(Boolean).join(" ");
}

export function boundaryStatus(accessMode, cwd) {
  const preference = String(process.env.AGENT_OS_SANDBOX || "auto").toLowerCase();
  if (accessMode === "full") return { accessMode, active: false, adapter: "direct", preference, reason: "full mode bypass" };
  if (["0", "off", "false", "disabled"].includes(preference)) return { accessMode, active: false, adapter: "policy-only", preference, reason: "AGENT_OS_SANDBOX disabled" };
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return { accessMode, active: true, adapter: "macos-seatbelt", preference, cwd: path.resolve(cwd) };
  if (process.platform === "linux" && (existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap"))) return { accessMode, active: true, adapter: "bubblewrap", preference, cwd: path.resolve(cwd), networkIsolated: accessMode === "safe" };
  if (process.platform === "win32") return { accessMode, active: false, adapter: "windows-process-guards", preference, reason: "restricted-token adapter unavailable in pure Node runtime" };
  return { accessMode, active: false, adapter: "policy-only", preference, reason: preference === "required" ? "required native sandbox adapter unavailable" : "native sandbox adapter unavailable" };
}

export function wrapSpawnSpec({ file, args = [], opts = {} }, cwd, accessMode) {
  const status = boundaryStatus(accessMode, cwd);
  if (!status.active) return { file, args, opts, boundary: status };
  if (status.adapter === "macos-seatbelt") {
    return {
      file: "/usr/bin/sandbox-exec",
      args: ["-p", macProfile(cwd, accessMode), "--", file, ...args],
      opts: { ...opts, shell: false },
      boundary: status
    };
  }
  const bwrap = existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : "/bin/bwrap";
  const resolvedCwd = path.resolve(cwd);
  const wrapperArgs = [
    "--die-with-parent",
    "--new-session",
    "--ro-bind", "/", "/",
    "--bind", resolvedCwd, resolvedCwd,
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--chdir", resolvedCwd
  ];
  if (accessMode === "safe") wrapperArgs.push("--unshare-net");
  wrapperArgs.push("--", file, ...args);
  return { file: bwrap, args: wrapperArgs, opts: { ...opts, shell: false }, boundary: status };
}
