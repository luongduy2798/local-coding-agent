// Local Coding Agent CLI configuration and argument contract.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = dirname(fileURLToPath(new URL("../local-coding-agent.mjs", import.meta.url)));
export const REPO_ROOT = process.env.LCA_REPO_ROOT
  ? resolve(process.env.LCA_REPO_ROOT)
  : resolve(SCRIPT_DIR, "..");
export const SERVER_DIR = join(REPO_ROOT, "server");
export const SERVER_SCRIPT = "server.mjs";
export const VSCODE_EXTENSION_DIR = join(REPO_ROOT, "vscode-extension");
export const ENV_LOCAL_PATH = join(REPO_ROOT, ".env.local");
export const ENV_EXAMPLE_PATH = join(REPO_ROOT, ".env.example");
export const CONFIG_PATH = process.env.LCA_CONFIG_PATH || defaultConfigPath();
export const PID_PATH = join(dirname(CONFIG_PATH), "processes.json");
export const LOG_PATH = join(dirname(CONFIG_PATH), "launcher.log");
export const VSCODE_EXTENSION_STATE_PATH = join(dirname(CONFIG_PATH), "vscode-extension.json");
export const INTEGRATIONS_STATE_PATH = join(dirname(CONFIG_PATH), "integrations.json");
export const RELEASE_MIGRATION_STATE_PATH = join(dirname(CONFIG_PATH), "release-migration.json");
export const LEGACY_RELEASE_MIGRATION_STATE_PATH = join(dirname(CONFIG_PATH), "v5-migration.json");
export const RELEASE_MIGRATION_BACKUP_DIR = join(dirname(CONFIG_PATH), "migration-backups");
export const RELEASE_MIGRATION_LOCK_DIR = join(dirname(CONFIG_PATH), "release-migration.lock");
export const DEFAULT_PORT = "8789";
export const DEFAULT_TUNNEL_VERSION = process.env.TUNNEL_CLIENT_VERSION || "v0.0.10";
export const DEFAULT_FIGMA_DESKTOP_MCP_URL = "http://127.0.0.1:3845/mcp";
export const PROCESS_STATE_SCHEMA_VERSION = 2;
export const FULL_ACCESS_CONSENT_VERSION = 1;
export const INTERNAL_SUPERVISOR_ENV = "LCA_INTERNAL_SUPERVISOR_PAYLOAD";
export const MIGRATION_RECOVERY_ENV = "LCA_MIGRATION_RECOVERY";
export const SKIP_MIGRATION_RECOVERY_ENV = "LCA_SKIP_MIGRATION_RECOVERY";
export const SUPERVISOR_MAX_RESTARTS = 5;
export const SUPERVISOR_STABLE_WINDOW_MS = 60_000;
export const SUPERVISOR_BACKOFF_MS = Object.freeze([250, 500, 1_000, 2_000, 4_000]);
export const TUNNEL_RELEASE_BASE = "https://github.com/openai/tunnel-client/releases/download";
export const KEY_URLS = [
  "https://platform.openai.com/settings/organization/tunnels",
  "https://platform.openai.com/settings/organization/api-keys"
];

loadRepoEnvIntoProcess();

function defaultConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "LocalCodingAgent", "cli-config.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "LocalCodingAgent", "cli-config.json");
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "LocalCodingAgent", "cli-config.json");
}

function defaultOptions() {
  loadRepoEnvIntoProcess();
  return {
    node: process.env.NODE || "node",
    workspace: process.env.AGENT_WORKSPACE || "",
    extraRoots: process.env.AGENT_EXTRA_ROOTS || "",
    mode: process.env.AGENT_MODE || "safe",
    policy: process.env.AGENT_POLICY || "balanced",
    port: process.env.PORT || DEFAULT_PORT,
    authToken: process.env.MCP_AUTH_TOKEN || "",
    tunnelBin:
      process.env.TUNNEL_BIN ||
      defaultTunnelBinForPlatform(detectSetupPlatform()),
    profile: process.env.TUNNEL_PROFILE || "local-coding-agent",
    profileDir: process.env.TUNNEL_PROFILE_DIR || join(REPO_ROOT, "tools", "profiles"),
    tunnelId: process.env.CONTROL_PLANE_TUNNEL_ID || process.env.TUNNEL_ID || "",
    organizationId: process.env.OPENAI_ORGANIZATION || process.env.OPENAI_ORG_ID || "",
    runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
    runtimeKey: "",
    noTunnel: false
  };
}

function usage() {
  console.log(`Local Coding Agent universal CLI

Usage:
  lca
  lca run
  node scripts/local-coding-agent.mjs setup [options]
  node scripts/local-coding-agent.mjs ui
  node scripts/local-coding-agent.mjs integrations list
  node scripts/local-coding-agent.mjs integrations setup <vscode|jetbrains|web>
  node scripts/local-coding-agent.mjs integrations open <vscode|jetbrains|web>
  node scripts/local-coding-agent.mjs integrations uninstall <vscode|jetbrains|web>
  node scripts/local-coding-agent.mjs extension [run|setup|uninstall]  # deprecated VS Code alias
  node scripts/local-coding-agent.mjs install
  node scripts/local-coding-agent.mjs start [options]
  node scripts/local-coding-agent.mjs stop
  node scripts/local-coding-agent.mjs status
  node scripts/local-coding-agent.mjs workspace
  node scripts/local-coding-agent.mjs workspace list
  node scripts/local-coding-agent.mjs workspace use <path|workspace-id>
  node scripts/local-coding-agent.mjs workspace archive <path|workspace-id>
  node scripts/local-coding-agent.mjs workspace restore <path|workspace-id>
  node scripts/local-coding-agent.mjs workspace remove <path|workspace-id>
  node scripts/local-coding-agent.mjs approval list
  node scripts/local-coding-agent.mjs approval approve <request-id>
  node scripts/local-coding-agent.mjs approval deny <request-id>
  node scripts/local-coding-agent.mjs figma [connect|status|tools|open]
  node scripts/local-coding-agent.mjs keys
  node scripts/local-coding-agent.mjs cli
  node scripts/local-coding-agent.mjs doctor
  node scripts/local-coding-agent.mjs profile [options]
  node scripts/local-coding-agent.mjs url
  node scripts/local-coding-agent.mjs logs
  node scripts/local-coding-agent.mjs config                 # interactive TUI
  node scripts/local-coding-agent.mjs config show|path|set <key> <value>|unset <key>
  node scripts/local-coding-agent.mjs key set|clear
  node scripts/local-coding-agent.mjs update
  node scripts/local-coding-agent.mjs rollback
  node scripts/local-coding-agent.mjs skills list|validate

Common options:
  --workspace <path>          Workspace root the agent may access
  --extra-roots <paths>       Extra roots, semicolon-separated
  --mode <safe|full>          Command guardrail mode
  --policy <strict|balanced|full>
  --port <port>               MCP server port
  --auth-token <token>        Optional MCP bearer token
  --node <path>               Node executable
  --background                Keep server/tunnel running after this command exits

Tunnel options:
  --no-tunnel                 Start only the local MCP server
  --tunnel-bin <path>         Path to tunnel-client(.exe)
  --tunnel-id <id>            OpenAI tunnel ID, e.g. tunnel_...
  --organization-id <id>      Optional OpenAI organization ID/header
  --profile <name>            Tunnel profile name
  --profile-dir <path>        Tunnel profile directory
  --runtime-key-env <name>    Env var containing Runtime API key
  --runtime-key <key>         Runtime API key for this process
  --choose-os                 With setup, show OS picker instead of auto-detect
  --save                      With setup, save provided options to config
  --force                     With update, continue even when local changes exist
                              With rollback, allow replacing a dirty checkout
                              With workspace remove, confirm non-interactive deletion
  --confirm-label <label>     Exact workspace label required by permanent removal
  --preview                   With workspace remove, inspect without deleting

Fast path:
  scripts\\lca.cmd setup       # Windows
  bash scripts/lca setup       # macOS/Linux
  node scripts/local-coding-agent.mjs setup
  lca                         # From any repo, set workspace to git root and run
  lca ui                      # Open the standalone local Control Center
  lca integrations list       # Inspect VS Code, JetBrains and web integrations
  lca integrations setup web
  lca integrations setup vscode
  lca integrations setup jetbrains

One-shot examples:
  node scripts/local-coding-agent.mjs start --workspace "<path-to-repo>" --no-tunnel
  CONTROL_PLANE_API_KEY=sk-proj-... node scripts/local-coding-agent.mjs start --workspace /path/repo --tunnel-id tunnel_...
`);
}

function setupUsage() {
  console.log(`Local Coding Agent setup wizard

Usage:
  bash scripts/lca setup          # macOS/Linux/WSL
  scripts\\lca.cmd setup          # Windows
  node scripts/local-coding-agent.mjs setup

The wizard uses only Node.js built-ins. It auto-detects the current OS, checks
prerequisites, creates or updates .env.local, installs server dependencies,
checks the local Figma Desktop MCP bridge, downloads tunnel-client when possible,
writes local CLI config, installs the global lca command, and prints health/status checks.
The startup workspace defaults to this local-coding-agent repository; use
--workspace only when you intentionally want a different startup workspace.
It does not install editor integrations. Build or install optional Control Center hosts with:

  lca integrations setup web
  lca integrations setup vscode
  lca integrations setup jetbrains

Open the standalone local UI with lca ui. The old lca extension command remains a deprecated VS Code alias.

Use --choose-os only when you want instruction mode for another OS.
`);
}

function parseArgs(argv) {
  if (argv.length === 0) {
    return { command: "run", rest: [], flags: {} };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", rest: [], flags: { help: true } };
  }
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      if (i + 1 >= rest.length) throw new Error(`Missing value for ${arg}`);
      return rest[++i];
    };
    switch (arg) {
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--workspace":
        flags.workspace = next();
        break;
      case "--extra-roots":
        flags.extraRoots = next();
        break;
      case "--mode":
        flags.mode = next();
        break;
      case "--policy":
        flags.policy = next();
        break;
      case "--port":
        flags.port = next();
        break;
      case "--auth-token":
        flags.authToken = next();
        break;
      case "--node":
        flags.node = next();
        break;
      case "--background":
      case "--daemon":
        flags.background = true;
        break;
      case "--no-tunnel":
        flags.noTunnel = true;
        break;
      case "--tunnel-bin":
        flags.tunnelBin = next();
        break;
      case "--tunnel-id":
        flags.tunnelId = next();
        break;
      case "--organization-id":
        flags.organizationId = next();
        break;
      case "--profile":
        flags.profile = next();
        break;
      case "--profile-dir":
        flags.profileDir = next();
        break;
      case "--runtime-key-env":
        flags.runtimeKeyEnv = next();
        break;
      case "--runtime-key":
        flags.runtimeKey = next();
        break;
      case "--choose-os":
        flags.chooseOs = true;
        break;
      case "--save":
        flags.save = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "--confirm-label":
        flags.confirmLabel = next();
        break;
      case "--preview":
        flags.preview = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--include-instance-nonce":
        flags.includeInstanceNonce = true;
        break;
      case "--print-url":
        flags.printUrl = true;
        break;
      case "--no-open":
        flags.noOpen = true;
        break;
      case "--host":
        flags.hostKind = next();
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
        positional.push(arg);
        break;
    }
  }
  return { command, rest: positional, flags };
}

function ensureConfigDir() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

function readJsonFile(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  return { ...defaultOptions(), ...readJsonFile(CONFIG_PATH, {}) };
}

async function saveConfig(cfg) {
  ensureConfigDir();
  await writeFile(CONFIG_PATH, `${JSON.stringify(stripRuntimeFields(cfg), null, 2)}\n`, "utf8");
  try { await chmod(CONFIG_PATH, 0o600); } catch { /* Windows may ignore POSIX mode. */ }
}

function effectiveOptions(flags = {}) {
  loadRepoEnvIntoProcess();
  const cfg = loadConfig();
  return normalize({ ...defaultOptions(), ...cfg, ...flags });
}

export function normalize(opts) {
  const out = { ...opts };
  out.port = String(out.port || DEFAULT_PORT);
  out.mode = out.mode || "safe";
  out.policy = out.policy || "balanced";
  out.runtimeKeyEnv = out.runtimeKeyEnv || "CONTROL_PLANE_API_KEY";
  out.profile = out.profile || "local-coding-agent";
  out.profileDir = out.profileDir || join(REPO_ROOT, "tools", "profiles");
  out.tunnelBin = out.tunnelBin || defaultOptions().tunnelBin;
  out.node = out.node || "node";
  out.noTunnel = toBool(out.noTunnel);
  return out;
}

export function setupSecurityDefaults(flags = {}) {
  return {
    mode: flags.mode || "full",
    policy: flags.policy || "full"
  };
}

export function applySetupSecurityConsent(config = {}, flags = {}, accepted = false) {
  const next = { ...config };
  const explicit = Boolean(flags.mode || flags.policy);
  if (explicit) {
    const requested = setupSecurityDefaults(flags);
    next.mode = requested.mode;
    next.policy = requested.policy;
    if (requested.mode === "full" && requested.policy === "full") {
      next.fullAccessConsentVersion = FULL_ACCESS_CONSENT_VERSION;
      next.fullAccessConsentedAt ||= new Date().toISOString();
      next.fullAccessConsentSource = "explicit-cli";
    }
    return next;
  }
  if (
    Number(next.fullAccessConsentVersion || 0) >= FULL_ACCESS_CONSENT_VERSION &&
    next.mode === "full" &&
    next.policy === "full"
  ) {
    return next;
  }
  if (accepted) {
    next.mode = "full";
    next.policy = "full";
    next.fullAccessConsentVersion = FULL_ACCESS_CONSENT_VERSION;
    next.fullAccessConsentedAt = new Date().toISOString();
    next.fullAccessConsentSource = "setup";
    return next;
  }
  next.mode = next.mode === "full" ? "safe" : (next.mode || "safe");
  next.policy = next.policy === "full" ? "balanced" : (next.policy || "balanced");
  return next;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value.replace(/\\n/g, "\n");
  }
  return values;
}

function readRepoEnvFile() {
  if (!existsSync(ENV_LOCAL_PATH)) return {};
  return parseDotEnv(readFileSync(ENV_LOCAL_PATH, "utf8"));
}

function loadRepoEnvIntoProcess({ override = false } = {}) {
  const values = readRepoEnvFile();
  for (const [key, value] of Object.entries(values)) {
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

function envValueNeedsQuotes(value) {
  return /[\s"'#]/.test(String(value));
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (!envValueNeedsQuotes(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function mergeDotEnvText(existingText, updates) {
  const keys = new Set(Object.keys(updates).filter((key) => updates[key] !== undefined));
  const seen = new Set();
  const lines = String(existingText || "").trim() ? String(existingText || "").split(/\r?\n/) : [];
  const hadTrailingBlank = lines.length > 1 && lines[lines.length - 1] === "";
  const nextLines = [];
  for (const rawLine of lines) {
    if (!rawLine && rawLine === lines[lines.length - 1] && hadTrailingBlank) continue;
    const match = rawLine.match(/^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match || !keys.has(match[2])) {
      nextLines.push(rawLine);
      continue;
    }
    seen.add(match[2]);
    nextLines.push(`${match[1]}${match[2]}${match[3]}${formatEnvValue(updates[match[2]])}`);
  }
  for (const key of keys) {
    if (!seen.has(key)) nextLines.push(`${key}=${formatEnvValue(updates[key])}`);
  }
  return `${nextLines.filter((line, index) => line || index < nextLines.length - 1).join("\n")}\n`;
}

async function writeRepoEnv(updates) {
  const existing = existsSync(ENV_LOCAL_PATH)
    ? readFileSync(ENV_LOCAL_PATH, "utf8")
    : existsSync(ENV_EXAMPLE_PATH)
      ? readFileSync(ENV_EXAMPLE_PATH, "utf8")
      : "";
  await writeFile(ENV_LOCAL_PATH, mergeDotEnvText(existing, updates), "utf8");
  try { await chmod(ENV_LOCAL_PATH, 0o600); } catch { /* Windows may ignore POSIX mode. */ }
  loadRepoEnvIntoProcess({ override: true });
}

function isPlaceholder(value) {
  const text = String(value || "").trim();
  return !text || text.endsWith("...") || text.includes("<") || text.includes("your-");
}

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function normalizeTunnelArch(arch = os.arch()) {
  const value = String(arch).toLowerCase();
  if (["x64", "amd64"].includes(value)) return "amd64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  throw new Error(`Unsupported CPU architecture for tunnel-client: ${arch}`);
}

export function detectSetupPlatform() {
  const raw = process.platform;
  if (isWsl()) return { id: "wsl", label: "WSL", tunnelOs: "linux", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "darwin") return { id: "darwin", label: "macOS", tunnelOs: "darwin", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "linux") return { id: "linux", label: "Linux", tunnelOs: "linux", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "win32") return { id: "win32", label: "Windows", tunnelOs: "windows", arch: normalizeTunnelArch(), executable: "tunnel-client.exe" };
  return { id: raw, label: raw, tunnelOs: raw, arch: normalizeTunnelArch(), executable: raw === "win32" ? "tunnel-client.exe" : "tunnel-client" };
}

function setupPlatformChoices() {
  const arch = normalizeTunnelArch();
  return [
    { id: "darwin", label: "macOS", tunnelOs: "darwin", arch, executable: "tunnel-client" },
    { id: "linux", label: "Linux", tunnelOs: "linux", arch, executable: "tunnel-client" },
    { id: "win32", label: "Windows", tunnelOs: "windows", arch, executable: "tunnel-client.exe" },
    { id: "wsl", label: "WSL", tunnelOs: "linux", arch, executable: "tunnel-client" }
  ];
}

function platformMatchesHost(selected, host = detectSetupPlatform()) {
  return selected.id === host.id;
}

function defaultTunnelBinForPlatform(platform = detectSetupPlatform()) {
  return join(REPO_ROOT, "tools", platform.executable || (platform.tunnelOs === "windows" ? "tunnel-client.exe" : "tunnel-client"));
}

export function tunnelAssetName(version = DEFAULT_TUNNEL_VERSION, tunnelOs = detectSetupPlatform().tunnelOs, arch = normalizeTunnelArch()) {
  return `tunnel-client-${version}-${tunnelOs}-${normalizeTunnelArch(arch)}.zip`;
}

export function tunnelAssetUrl(version = DEFAULT_TUNNEL_VERSION, tunnelOs = detectSetupPlatform().tunnelOs, arch = normalizeTunnelArch()) {
  return `${TUNNEL_RELEASE_BASE}/${version}/${tunnelAssetName(version, tunnelOs, arch)}`;
}

export function ripgrepInstallCommand(platform = detectSetupPlatform(), availableCommands = []) {
  const has = (name) => availableCommands.includes(name);
  if (platform.id === "darwin") {
    return has("brew") ? { label: "Homebrew", command: "brew", args: ["install", "ripgrep"] } : null;
  }
  if (platform.id === "win32") {
    return has("winget") ? { label: "winget", command: "winget", args: ["install", "--id", "BurntSushi.ripgrep.MSVC", "-e"] } : null;
  }
  if (platform.id === "linux" || platform.id === "wsl") {
    const sudo = typeof process.getuid === "function" && process.getuid() === 0 ? [] : has("sudo") ? ["sudo"] : [];
    if (has("apt-get")) return { label: "apt-get", command: sudo[0] || "apt-get", args: [...sudo.slice(1), ...(sudo[0] ? ["apt-get"] : []), "install", "-y", "ripgrep"] };
    if (has("dnf")) return { label: "dnf", command: sudo[0] || "dnf", args: [...sudo.slice(1), ...(sudo[0] ? ["dnf"] : []), "install", "-y", "ripgrep"] };
    if (has("yum")) return { label: "yum", command: sudo[0] || "yum", args: [...sudo.slice(1), ...(sudo[0] ? ["yum"] : []), "install", "-y", "ripgrep"] };
    if (has("pacman")) return { label: "pacman", command: sudo[0] || "pacman", args: [...sudo.slice(1), ...(sudo[0] ? ["pacman"] : []), "-S", "--noconfirm", "ripgrep"] };
    if (has("zypper")) return { label: "zypper", command: sudo[0] || "zypper", args: [...sudo.slice(1), ...(sudo[0] ? ["zypper"] : []), "--non-interactive", "install", "ripgrep"] };
  }
  return null;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validate(opts, { requireWorkspace = false, requireTunnel = false } = {}) {
  if (!["safe", "full"].includes(opts.mode)) throw new Error("--mode must be safe or full.");
  if (!["strict", "balanced", "full"].includes(opts.policy)) throw new Error("--policy must be strict, balanced, or full.");
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be a TCP port.");
  if (requireWorkspace) {
    if (!opts.workspace) throw new Error("Missing workspace. Run `setup` or pass --workspace.");
    if (!existsSync(opts.workspace)) throw new Error(`Workspace does not exist: ${opts.workspace}`);
  }
  if (requireTunnel && !opts.noTunnel) {
    if (!opts.tunnelId) throw new Error("Missing tunnel ID. Run `setup` or pass --tunnel-id.");
    if (!existsSync(opts.tunnelBin)) throw new Error(`Tunnel client not found: ${opts.tunnelBin}`);
  }
}

function yamlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function configId(opts) {
  const serverPath = join(SERVER_DIR, SERVER_SCRIPT);
  const serverImplementationPath = join(SERVER_DIR, "src", SERVER_SCRIPT);
  const figmaBridgePath = join(SERVER_DIR, "src", "integrations", "figma-desktop.mjs");
  const material = JSON.stringify({
    mode: opts.mode,
    policy: opts.policy,
    extraRoots: opts.extraRoots || "",
    authTokenDigest: opts.authToken ? sha256(Buffer.from(opts.authToken)).slice(0, 16) : "",
    port: String(opts.port),
    node: String(opts.node || "node"),
    serverHash: existsSync(serverPath) ? sha256(readFileSync(serverPath)).slice(0, 16) : "missing",
    serverImplementationHash: existsSync(serverImplementationPath)
      ? sha256(readFileSync(serverImplementationPath)).slice(0, 16)
      : "missing",
    figmaBridgeHash: existsSync(figmaBridgePath) ? sha256(readFileSync(figmaBridgePath)).slice(0, 16) : "missing",
    figmaDesktopMcpUrl: figmaDesktopEndpoint(),
    figmaDesktopTimeoutMs: process.env.FIGMA_DESKTOP_TIMEOUT_MS || "30000",
    figmaDesktopAllowRemote: process.env.FIGMA_DESKTOP_ALLOW_REMOTE === "1"
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function tunnelConfigId(opts, runtimeKey) {
  const material = JSON.stringify({
    port: String(opts.port),
    tunnelBin: resolve(String(opts.tunnelBin || "")),
    tunnelId: String(opts.tunnelId || ""),
    organizationId: String(opts.organizationId || ""),
    profile: String(opts.profile || ""),
    profileDir: resolve(String(opts.profileDir || "")),
    authTokenDigest: opts.authToken ? sha256(Buffer.from(opts.authToken)).slice(0, 16) : "",
    runtimeKeyDigest: runtimeKey ? sha256(Buffer.from(runtimeKey)).slice(0, 16) : ""
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function tunnelHealthConfig(instanceNonce = process.pid) {
  const safeNonce = String(instanceNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  if (process.platform === "win32") {
    ensureConfigDir();
    const urlFile = join(dirname(PID_PATH), `.tunnel-health-${safeNonce || process.pid}.url`);
    rmSync(urlFile, { force: true });
    return {
      kind: "url-file",
      urlFile,
      args: [
        "--health.listen-addr", "127.0.0.1:0",
        "--health.url-file", urlFile
      ]
    };
  }
  const socketPath = `/tmp/lca-tunnel-${safeNonce || process.pid}.sock`;
  rmSync(socketPath, { force: true });
  return {
    kind: "unix-socket",
    socketPath,
    args: ["--health.unix-socket", socketPath]
  };
}


function figmaDesktopEndpoint() {
  return process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL;
}

function stripRuntimeFields(cfg) {
  const clean = { ...cfg };
  delete clean.runtimeKey;
  delete clean.authToken;
  delete clean.background;
  delete clean.force;
  delete clean.confirmLabel;
  delete clean.preview;
  delete clean.json;
  delete clean.chooseOs;
  delete clean.save;
  delete clean.runtimeKeyFromFlag;
  delete clean.includeInstanceNonce;
  delete clean.printUrl;
  delete clean.noOpen;
  delete clean.hostKind;
  return clean;
}

export {
  configId,
  defaultTunnelBinForPlatform,
  defaultConfigPath,
  defaultOptions,
  effectiveOptions,
  ensureConfigDir,
  figmaDesktopEndpoint,
  formatEnvValue,
  isPlaceholder,
  isWsl,
  loadConfig,
  loadRepoEnvIntoProcess,
  parseArgs,
  platformMatchesHost,
  readJsonFile,
  readRepoEnvFile,
  saveConfig,
  setupPlatformChoices,
  setupUsage,
  sha256,
  stripRuntimeFields,
  toBool,
  tunnelConfigId,
  tunnelHealthConfig,
  usage,
  validate,
  writeRepoEnv,
  yamlEscape
};
