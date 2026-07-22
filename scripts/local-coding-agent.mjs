#!/usr/bin/env node
// Local Coding Agent CLI entrypoint.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSupportedNodeVersion } from "./process-lifecycle.mjs";
import { approvalCommand } from "./cli/approval.mjs";
import {
  LOG_PATH,
  REPO_ROOT,
  SKIP_MIGRATION_RECOVERY_ENV,
  effectiveOptions,
  isWsl,
  parseArgs,
  setupUsage,
  usage,
  validate
} from "./cli/config.mjs";
import {
  ensureFigmaDesktopConnected,
  figmaCommand
} from "./cli/integrations.mjs";
import {
  cliCommand,
  handoffAfterMigrationRecovery,
  keysCommand,
  skillsCommand
} from "./cli/misc.mjs";
import { writeTunnelProfile } from "./cli/processes.mjs";
import {
  configureReleaseServices,
  recoverPendingMigration,
  rollbackToPreviousRuntime,
  updateSelf
} from "./cli/release.mjs";
import {
  installDeps,
  openVsCodeExtension,
  setup,
  setupVsCodeExtension,
  uninstallVsCodeExtension
} from "./cli/setup.mjs";
import {
  configCommand,
  configureStatusServices,
  doctor,
  keyCommand,
  runningStatusForConfig,
  status,
  stop
} from "./cli/status.mjs";
import {
  configureSupervisorServices,
  decodeSupervisorPayload,
  start,
  superviseRuntime
} from "./cli/supervisor.mjs";
import {
  cliRuntimeDataDir,
  configureWorkspaceServices,
  detectWorkspaceRoot,
  openCliWorkspaceRegistry,
  prepareCliRuntimeDataDirectory,
  readCliRuntimeStatus,
  runCurrentWorkspace,
  selectCliWorkspace,
  workspaceCommand
} from "./cli/workspace.mjs";

configureWorkspaceServices({ runningStatusForConfig, start });
configureSupervisorServices({ prepareCliRuntimeDataDirectory, selectCliWorkspace, stop });
configureStatusServices({ readCliRuntimeStatus });
configureReleaseServices({
  cliRuntimeDataDir,
  doctor,
  openCliWorkspaceRegistry,
  runningStatusForConfig,
  stop
});

async function main() {
  assertSupportedNodeVersion(process.versions.node, process.platform, { wsl: isWsl() });
  const argv = process.argv.slice(2);
  const { command, rest, flags } = parseArgs(argv);
  if (command !== "supervise" && process.env[SKIP_MIGRATION_RECOVERY_ENV] !== "1") {
    const recovery = await recoverPendingMigration(flags);
    if (recovery.handled && ["update", "rollback"].includes(command)) {
      console.log("Interrupted migration recovery is complete. Run the command again if you want a new operation.");
      return;
    }
    if (recovery.handoff) return handoffAfterMigrationRecovery(argv);
  }
  if (flags.help) return command === "setup" || command === "init" ? setupUsage() : usage();
  if (command === "help") return usage();
  if (command === "run" || command === "here") return runCurrentWorkspace(flags);
  if (command === "setup" || command === "init") {
    if (rest.length) throw new Error("Usage: lca setup");
    return setup(flags, { detectWorkspaceRoot, ensureFigmaDesktopConnected, start, status });
  }
  if (command === "extension") {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "run")) {
      return openVsCodeExtension(flags, { detectWorkspaceRoot });
    }
    if (rest.length === 1 && rest[0] === "setup") return setupVsCodeExtension();
    if (rest.length === 1 && ["uninstall", "remove"].includes(rest[0])) return uninstallVsCodeExtension();
    throw new Error("Usage: lca extension [run] | lca extension setup | lca extension uninstall");
  }
  if (command === "install") return installDeps(effectiveOptions(flags));
  if (command === "cli") return cliCommand();
  if (command === "keys") return keysCommand();
  if (command === "workspace") return workspaceCommand(rest, flags);
  if (command === "approval") return approvalCommand(rest);
  if (command === "figma") return figmaCommand(rest, flags);
  if (command === "supervise") {
    if (rest.length) throw new Error("Invalid internal supervisor arguments.");
    return superviseRuntime(decodeSupervisorPayload());
  }
  if (command === "start") return start(flags);
  if (command === "stop") return stop(flags);
  if (command === "status") return status(flags);
  if (command === "doctor") return doctor(flags);
  if (command === "profile") {
    const opts = effectiveOptions(flags);
    validate(opts);
    console.log(writeTunnelProfile(opts));
    return;
  }
  if (command === "url") {
    const opts = effectiveOptions(flags);
    console.log(`http://127.0.0.1:${opts.port}/mcp`);
    return;
  }
  if (command === "logs") {
    console.log(LOG_PATH);
    if (existsSync(LOG_PATH)) console.log(await readFile(LOG_PATH, "utf8"));
    return;
  }
  if (command === "config") return configCommand(rest);
  if (command === "key") return keyCommand(rest);
  if (command === "update") return updateSelf(flags);
  if (command === "rollback") return rollbackToPreviousRuntime(flags);
  if (command === "skills") return skillsCommand(rest);
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}

export {
  applySetupSecurityConsent,
  mergeDotEnvText,
  normalize,
  normalizeTunnelArch,
  parseDotEnv,
  ripgrepInstallCommand,
  setupSecurityDefaults,
  tunnelAssetName,
  tunnelAssetUrl
} from "./cli/config.mjs";
export { supervisorBackoffMs } from "./cli/processes.mjs";
export {
  classifyMigrationRecovery,
  createMigrationTransactionState
} from "./cli/release.mjs";
export { resolveCliRuntimeDataDir } from "./cli/workspace.mjs";
