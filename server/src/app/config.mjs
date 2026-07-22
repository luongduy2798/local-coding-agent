// Local Coding Agent application configuration.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FIGMA_DESKTOP_MCP_URL } from "../integrations/figma-desktop.mjs";
import { boundedNumber, comparePath, dedupe } from "../shared/utils.mjs";
import {
  prepareRuntimeDataDirectory,
  RuntimeDataMigrationError
} from "../storage/runtime-data.mjs";

export async function loadApplicationConfig() {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(sourceDir, "../..");
  const repositoryDir = path.resolve(packageDir, "..");
  const packageMetadata = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const version = String(packageMetadata.version);
  const productTier = "pro";
  const port = Number(process.env.PORT || 8789);
  const host = process.env.AGENT_HOST || "127.0.0.1";
  const configId = String(process.env.AGENT_CONFIG_ID || "");
  const instanceNonce = String(process.env.LCA_INSTANCE_NONCE || "");
  const companionWidgetPath = path.join(packageDir, "resources", "lca-compact-input-v2.html");
  const primaryRoot = path.resolve(process.env.AGENT_WORKSPACE || path.join(repositoryDir, "agent-workspace"));
  const startupProfile = readStartupProfile(primaryRoot);
  const roots = dedupe([primaryRoot, ...parseExtraRoots(startupProfile)]);
  const mode = String(process.env.AGENT_MODE || startupProfile?.mode || "safe").toLowerCase() === "full"
    ? "full"
    : "safe";
  const allowDangerous = process.env.AGENT_ALLOW_DANGEROUS === "1";
  const authToken = process.env.MCP_AUTH_TOKEN || "";
  const allowedOrigins = new Set(
    String(process.env.MCP_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean)
  );
  const runtimeActivation = await prepareRuntimeDataDirectory({
    agentDataDir: process.env.AGENT_DATA_DIR || "",
    configRoot: defaultConfigRoot(),
    assertStopped: () => assertRuntimePortStopped(host, port)
  });
  const runtimeDataDir = runtimeActivation.runtimeDir;
  const dataDir = path.dirname(runtimeDataDir);
  const workspaceId = createHash("sha256").update(comparePath(primaryRoot)).digest("hex").slice(0, 16);
  const workspaceDataDir = path.join(runtimeDataDir, "workspaces", workspaceId);
  const checkpointPath = path.resolve(workspaceDataDir, "checkpoint.json");
  const auditPath = path.resolve(runtimeDataDir, "audit.log");
  const auditEnabled = process.env.AGENT_AUDIT !== "0";
  const auditArgs = process.env.AGENT_AUDIT_ARGS !== "0";
  const auditRotateBytes = boundedNumber(
    process.env.AGENT_AUDIT_ROTATE_BYTES,
    10 * 1024 * 1024,
    process.env.LCA_TEST_RUN_ID ? 4 * 1024 : 256 * 1024,
    1024 * 1024 * 1024
  );
  const auditRotateFiles = boundedNumber(process.env.AGENT_AUDIT_ROTATE_FILES, 5, 1, 20);
  const httpLog = process.env.AGENT_HTTP_LOG === "1";
  const figmaDesktopUrl = String(process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL).trim();
  const figmaDesktopTimeoutMs = boundedNumber(process.env.FIGMA_DESKTOP_TIMEOUT_MS, 30_000, 1_000, 120_000);
  const figmaReadOnlyTools = new Set([
    "get_code_connect_map",
    "get_code_connect_suggestions",
    "get_design_context",
    "get_figjam",
    "get_metadata",
    "get_screenshot",
    "get_shader_effect",
    "get_shader_fill",
    "get_variable_defs",
    "list_shader_effects",
    "list_shader_fills"
  ]);
  const indexPath = path.resolve(workspaceDataDir, "index.json");
  const agentStateDir = path.join(primaryRoot, ".agent", "state");
  const taskPlanPath = path.join(agentStateDir, "current-task.json");
  const approvalsDir = path.resolve(runtimeDataDir, "approvals");
  const approvalTtlMinutes = boundedNumber(process.env.AGENT_APPROVAL_TTL_MINUTES, 10, 1, 30);
  const policyValue = String(process.env.AGENT_POLICY || startupProfile?.policy || "balanced").toLowerCase();
  const policy = policyValue === "strict" || policyValue === "full" ? policyValue : "balanced";
  const skillDirectories = dedupe([
    ...(process.env.AGENT_SKILLS_DIR ? [path.resolve(process.env.AGENT_SKILLS_DIR)] : []),
    path.join(repositoryDir, "skills"),
    ...roots.flatMap((root) => [path.join(root, ".claude", "skills"), path.join(root, ".agent", "skills")])
  ]);
  const maxReadChars = boundedNumber(process.env.AGENT_MAX_READ_CHARS, 200_000, 10_000, 2_000_000);
  const readDefault = boundedNumber(process.env.AGENT_READ_DEFAULT, 12_000, 1_000, maxReadChars);
  const readManyFileDefault = boundedNumber(process.env.AGENT_READ_MANY_FILE_DEFAULT, 16_000, 1_000, maxReadChars);
  const commandOutputDefault = boundedNumber(process.env.AGENT_CMD_OUTPUT_DEFAULT, 8_000, 500, 200_000);
  const maxCommandOutput = boundedNumber(process.env.AGENT_MAX_COMMAND_OUTPUT, 200_000, 10_000, 2_000_000);
  const maxBatchReadChars = boundedNumber(process.env.AGENT_MAX_BATCH_READ_CHARS, 100_000, 10_000, 2_000_000);
  const searchOutputDefault = boundedNumber(process.env.AGENT_SEARCH_OUTPUT_DEFAULT, 15_000, 2_000, 200_000);
  const runCommandsOutputDefault = boundedNumber(process.env.AGENT_RUN_COMMANDS_OUTPUT_DEFAULT, 40_000, 2_000, 500_000);
  const maxBodyBytes = Number(process.env.AGENT_MAX_BODY_BYTES || 16 * 1024 * 1024);
  const defaultResponseChars = boundedNumber(process.env.AGENT_DEFAULT_RESPONSE_CHARS, 64 * 1024, 10_000, 200 * 1024);
  const maxSerializedResponseChars = boundedNumber(
    process.env.AGENT_MAX_RESPONSE_CHARS,
    200 * 1024,
    defaultResponseChars,
    200 * 1024
  );
  const maxPageOffset = 100_000;
  const maxSessions = boundedNumber(process.env.AGENT_MCP_MAX_SESSIONS, 32, 1, 256);
  const sessionIdleTtlMs = boundedNumber(process.env.AGENT_MCP_SESSION_IDLE_TTL_MS, 30 * 60_000, 10_000, 24 * 60 * 60_000);
  const maxSearchProcesses = boundedNumber(process.env.AGENT_MAX_SEARCH_PROCESSES, 4, 1, 16);
  const hotWorkspaceLimit = boundedNumber(process.env.AGENT_HOT_WORKSPACES, 2, 1, 16);
  const workspaceIdleUnloadMs = boundedNumber(
    process.env.AGENT_WORKSPACE_IDLE_UNLOAD_MS,
    10 * 60_000,
    10_000,
    24 * 60 * 60_000
  );
  const nonGitMutationMaxFiles = boundedNumber(process.env.AGENT_NON_GIT_MUTATION_MAX_FILES, 10_000, 100, 100_000);
  const nonGitMutationMaxFileBytes = boundedNumber(
    process.env.AGENT_NON_GIT_MUTATION_MAX_FILE_BYTES,
    16 * 1024 * 1024,
    64 * 1024,
    256 * 1024 * 1024
  );
  const nonGitMutationMaxTotalBytes = boundedNumber(
    process.env.AGENT_NON_GIT_MUTATION_MAX_TOTAL_BYTES,
    64 * 1024 * 1024,
    1024 * 1024,
    1024 * 1024 * 1024
  );
  const nonGitMutationTimeoutMs = boundedNumber(process.env.AGENT_NON_GIT_MUTATION_TIMEOUT_MS, 5_000, 250, 30_000);
  const skipDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
    ".venv",
    "__pycache__",
    ...((Array.isArray(startupProfile?.ignoredDirs) ? startupProfile.ignoredDirs : []).map(String))
  ]);
  return {
    AGENT_POLICY: policy,
    AGENT_STATE_DIR: agentStateDir,
    ALLOWED_ORIGINS: allowedOrigins,
    ALLOW_DANGEROUS: allowDangerous,
    APPROVALS_DIR: approvalsDir,
    APPROVAL_TTL_MINUTES: approvalTtlMinutes,
    AUDIT_ARGS: auditArgs,
    AUDIT_ENABLED: auditEnabled,
    AUDIT_PATH: auditPath,
    AUDIT_ROTATE_BYTES: auditRotateBytes,
    AUDIT_ROTATE_FILES: auditRotateFiles,
    AUTH_TOKEN: authToken,
    CATASTROPHIC: catastrophicCommands(),
    CHECKPOINT_PATH: checkpointPath,
    CMD_OUTPUT_DEFAULT: commandOutputDefault,
    COMPANION_WIDGET_PATH: companionWidgetPath,
    CONFIG_ID: configId,
    DATA_DIR: dataDir,
    DEFAULT_CMD_TIMEOUT: 60_000,
    DEFAULT_RESPONSE_CHARS: defaultResponseChars,
    FIGMA_DESKTOP_MCP_URL: figmaDesktopUrl,
    FIGMA_DESKTOP_READ_ONLY_TOOLS: figmaReadOnlyTools,
    FIGMA_DESKTOP_TIMEOUT_MS: figmaDesktopTimeoutMs,
    HOST: host,
    HOT_WORKSPACE_LIMIT: hotWorkspaceLimit,
    HTTP_LOG: httpLog,
    INDEX_PATH: indexPath,
    INSTANCE_NONCE: instanceNonce,
    MAX_BATCH_READ_CHARS: maxBatchReadChars,
    MAX_BODY_BYTES: maxBodyBytes,
    MAX_COMMAND_OUTPUT: maxCommandOutput,
    MAX_PAGE_OFFSET: maxPageOffset,
    MAX_PROCS: 24,
    MAX_READ_CHARS: maxReadChars,
    MAX_SEARCH_PROCESSES: maxSearchProcesses,
    MAX_SERIALIZED_RESPONSE_CHARS: maxSerializedResponseChars,
    MCP_MAX_SESSIONS: maxSessions,
    MCP_SESSION_IDLE_TTL_MS: sessionIdleTtlMs,
    MODE: mode,
    NON_GIT_MUTATION_MAX_FILES: nonGitMutationMaxFiles,
    NON_GIT_MUTATION_MAX_FILE_BYTES: nonGitMutationMaxFileBytes,
    NON_GIT_MUTATION_MAX_TOTAL_BYTES: nonGitMutationMaxTotalBytes,
    NON_GIT_MUTATION_TIMEOUT_MS: nonGitMutationTimeoutMs,
    PAGE_CURSOR_SECRET: randomUUID(),
    PORT: port,
    PRIMARY_ROOT: primaryRoot,
    PROC_BUFFER: 200_000,
    PRODUCT_TIER: productTier,
    READ_DEFAULT: readDefault,
    READ_MANY_FILE_DEFAULT: readManyFileDefault,
    REPOSITORY_DIR: repositoryDir,
    ROOTS: roots,
    RUNTIME_DATA_DIR: runtimeDataDir,
    RUN_COMMANDS_OUTPUT_DEFAULT: runCommandsOutputDefault,
    SAFE_MODE_BLOCKS: safeModeBlocks(),
    SEARCH_OUTPUT_DEFAULT: searchOutputDefault,
    SKILLS_DIRS: skillDirectories,
    SKIP_DIRS: skipDirectories,
    STARTUP_PROFILE: startupProfile,
    TASK_PLAN_PATH: taskPlanPath,
    TEST_RUNTIME_DIAGNOSTICS: Boolean(process.env.LCA_TEST_RUN_ID && process.env.LCA_TEST_RUNTIME_DIAGNOSTICS === "1"),
    VERSION: version,
    WORKSPACE_DATA_DIR: workspaceDataDir,
    WORKSPACE_ID: workspaceId,
    WORKSPACE_IDLE_UNLOAD_MS: workspaceIdleUnloadMs
  };
}

function assertRuntimePortStopped(host, port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) return Promise.resolve();
  const probeHost = ["", "0.0.0.0", "::", "::0"].includes(String(host || ""))
    ? "127.0.0.1"
    : String(host);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: probeHost, port: numericPort });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(500, () => finish(new RuntimeDataMigrationError(
      "RUNTIME_PROCESS_CHECK_FAILED",
      `Timed out while checking ${probeHost}:${numericPort} before runtime data migration.`
    )));
    socket.once("connect", () => finish(new RuntimeDataMigrationError(
      "RUNTIME_PROCESS_ACTIVE",
      `Port ${probeHost}:${numericPort} is active. Stop the existing Local Coding Agent before migrating runtime data.`
    )));
    socket.once("error", (error) => {
      if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"].includes(error?.code)) {
        finish();
        return;
      }
      finish(new RuntimeDataMigrationError(
        "RUNTIME_PROCESS_CHECK_FAILED",
        `Could not verify that ${probeHost}:${numericPort} is stopped before runtime data migration.`,
        { cause: error?.code || error?.message || String(error) }
      ));
    });
  });
}

function readStartupProfile(primaryRoot) {
  try {
    return JSON.parse(readFileSync(path.join(primaryRoot, ".agent", "profile.json"), "utf8"));
  } catch {
    return null;
  }
}

function parseExtraRoots(startupProfile) {
  const profileRoots = Array.isArray(startupProfile?.extraRoots) ? startupProfile.extraRoots : [];
  const json = process.env.AGENT_EXTRA_ROOTS_JSON;
  if (json?.trim()) {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed) || parsed.some((root) => typeof root !== "string")) {
        throw new Error("AGENT_EXTRA_ROOTS_JSON must be a JSON string array.");
      }
      return dedupe([...parsed, ...profileRoots]).map((root) => path.resolve(root));
    } catch (error) {
      console.warn(`Invalid AGENT_EXTRA_ROOTS_JSON ignored: ${error?.message || error}`);
    }
  }
  return dedupe([...(process.env.AGENT_EXTRA_ROOTS || "").split(";"), ...profileRoots])
    .map((root) => String(root).trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
}

function defaultConfigRoot() {
  const home = os.homedir();
  return process.platform === "win32"
    ? path.resolve(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "LocalCodingAgent")
    : process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "LocalCodingAgent")
      : path.resolve(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "LocalCodingAgent");
}

function catastrophicCommands() {
  return [
    /(^|[;&|]\s*)format(\.com)?\s+(\/|[a-z]:)/i,
    /\bdiskpart\b/i,
    /\bmkfs\b/i,
    /\bfdisk\b/i,
    /\bshutdown\b/i,
    /\brestart-computer\b/i,
    /\bstop-computer\b/i,
    /\bremove-item\b[^\n]*\b(c:\\\\|c:\/|\$env:systemroot|system32|windows\\\\)/i,
    /\b(rd|rmdir)\b\s+\/s[^\n]*\bc:\\\\/i,
    /\bdel\b[^\n]*\/s[^\n]*\bc:\\\\/i,
    /\bcipher\b\s+\/w/i,
    /\b(reg)\b\s+delete\s+hk(lm|ey_local_machine)/i,
    /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
    /\brm\s+-[rRfile]*\s+(--no-preserve-root\s+)?\/(\s|$|\*)/i,
    /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/i,
    /\bmkfs\.[a-z0-9]+\b/i,
    /\b(reboot|halt|poweroff|init\s+0)\b/i,
    /\bchmod\s+-R\s*0*\s+\//i,
    />\s*\/dev\/(sd|nvme|disk|hd)[a-z0-9]/i
  ];
}

function safeModeBlocks() {
  return [
    /\b(del|erase|rmdir|rd|remove-item|rm|format|shutdown|restart-computer|stop-computer|diskpart)\b/i,
    /\bgit\s+clean\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\breg\s+delete\b/i,
    /\btakeown\b/i,
    /\bicacls\b/i,
    /[a-z]:\\/i,
    /(^|\s)~[\\/]/i
  ];
}
