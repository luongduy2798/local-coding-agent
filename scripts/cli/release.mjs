// Local Coding Agent CLI transactional update and rollback.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectProcess,
  newInstanceNonce
} from "../process-lifecycle.mjs";
import {
  CONFIG_PATH,
  ENV_LOCAL_PATH,
  LEGACY_RELEASE_MIGRATION_STATE_PATH,
  MIGRATION_RECOVERY_ENV,
  REPO_ROOT,
  SCRIPT_DIR,
  SERVER_DIR,
  SKIP_MIGRATION_RECOVERY_ENV,
  RELEASE_MIGRATION_BACKUP_DIR,
  RELEASE_MIGRATION_LOCK_DIR,
  RELEASE_MIGRATION_STATE_PATH,
  effectiveOptions,
  ensureConfigDir,
  readJsonFile
} from "./config.mjs";
import { capture, runChecked } from "./processes.mjs";
import {
  chooseCliBinDir,
  installCliCommand,
  installDeps
} from "./setup.mjs";

let services = Object.create(null);

export function configureReleaseServices(next) {
  services = { ...services, ...next };
}

function readMigrationState() {
  return readJsonFile(RELEASE_MIGRATION_STATE_PATH, null) ||
    readJsonFile(LEGACY_RELEASE_MIGRATION_STATE_PATH, null);
}

function migrationTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const MIGRATION_TERMINAL_STAGES = new Set([
  "complete",
  "rolled_back",
  "rolled_back_after_failed_upgrade",
  "rollback_aborted"
]);

function migrationTransactionId(operation) {
  return `${operation}-${Date.now()}-${process.pid}-${newInstanceNonce().slice(0, 8)}`;
}

function durableAtomicWriteJson(path, value, { mode = 0o600 } = {}) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${newInstanceNonce()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    try {
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch {
      // Directory fsync is unavailable on some Windows/filesystem combinations.
    }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { rmSync(temporary, { force: true }); } catch { /* rename already consumed it */ }
  }
}

function migrationOperation(state) {
  if (state?.operation === "update" || state?.operation === "rollback") return state.operation;
  if (state?.stage === "prepared") return "update";
  return "";
}

export function createMigrationTransactionState({
  operation,
  transactionId,
  createdAt,
  sourceCommit,
  sourceBranch = "",
  targetCommit = "",
  runningBefore = false,
  dirtyBefore = false,
  forceAuthorized = false,
  backup = null,
  safetyBackup = null,
  priorMigration = null
}) {
  if (!["update", "rollback"].includes(operation)) {
    throw new Error(`Unsupported migration operation: ${operation || "missing"}`);
  }
  if (!sourceCommit) throw new Error("Migration source commit is required.");
  return {
    schema_version: 2,
    transaction_id: transactionId || migrationTransactionId(operation),
    operation,
    stage: "prepared",
    created_at: createdAt || new Date().toISOString(),
    source_commit: sourceCommit,
    source_branch: sourceBranch || "",
    target_commit: targetCommit || "",
    previous_commit: operation === "update" ? sourceCommit : (targetCommit || priorMigration?.previous_commit || ""),
    previous_branch: operation === "update" ? (sourceBranch || "") : (priorMigration?.previous_branch || ""),
    running_before: Boolean(runningBefore),
    dirty_before: Boolean(dirtyBefore),
    force_authorized: Boolean(forceAuthorized),
    backup,
    safety_backup: safetyBackup,
    prior_migration: priorMigration,
    runtime_data_preserved_on_rollback: true,
    connector_refresh_required: false
  };
}

export function classifyMigrationRecovery(state, {
  head = "",
  dirty = false,
  force = false
} = {}) {
  if (!state || typeof state !== "object") return { status: "none", action: "none" };
  if (MIGRATION_TERMINAL_STAGES.has(String(state.stage || ""))) {
    return { status: "terminal", action: "none" };
  }
  const operation = migrationOperation(state);
  if (!operation) {
    return { status: "blocked", action: "none", reason: "unknown migration operation" };
  }
  const source = String(state.source_commit || state.previous_commit || "");
  const target = String(state.target_commit || state.current_commit || "");
  const current = String(head || "");
  const forceAllowed = Boolean(force || state.force_authorized);
  if (!source || !current) {
    return { status: "blocked", action: "none", reason: "missing source or current revision" };
  }

  if (operation === "update") {
    if (current === source) {
      return { status: "recoverable", action: "abort_update", operation };
    }
    if (target && current === target) {
      const rollingBack = state.stage === "update_failed" || state.recovery_action === "rollback_update";
      if (rollingBack && dirty && !forceAllowed) {
        return {
          status: "blocked",
          action: "none",
          operation,
          reason: "failed update has dirty files; --force is required before changing checkout"
        };
      }
      return {
        status: "recoverable",
        action: rollingBack ? "rollback_update" : "resume_update",
        operation
      };
    }
  } else {
    if (current === source) {
      return { status: "recoverable", action: "abort_rollback", operation };
    }
    if (target && current === target) {
      const revertingRollback = state.stage === "rollback_failed" || state.recovery_action === "recover_rollback_source";
      if (revertingRollback && dirty && !forceAllowed) {
        return {
          status: "blocked",
          action: "none",
          operation,
          reason: "failed rollback has dirty files; --force is required before changing checkout"
        };
      }
      return {
        status: "recoverable",
        action: revertingRollback ? "recover_rollback_source" : "resume_rollback",
        operation
      };
    }
  }
  return {
    status: "blocked",
    action: "none",
    operation,
    reason: `checkout ${current} is neither recorded source ${source} nor target ${target || "(unset)"}`
  };
}

async function copyMigrationSnapshotEntry(source, destination) {
  if (!existsSync(source)) return { exists: false, source, backup: null };
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(source, destination, {
    recursive: statSync(source).isDirectory(),
    force: true,
    preserveTimestamps: true
  });
  try {
    await chmod(destination, statSync(source).mode & 0o777);
  } catch {
    // Windows may ignore POSIX modes.
  }
  return { exists: true, source, backup: destination };
}

async function copyMigrationRecoveryBundle(backupDir) {
  const recoveryDir = join(backupDir, "recovery");
  mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  const cli = await copyMigrationSnapshotEntry(
    join(SCRIPT_DIR, "local-coding-agent.mjs"),
    join(recoveryDir, "local-coding-agent.mjs")
  );
  await copyMigrationSnapshotEntry(
    join(SCRIPT_DIR, "process-lifecycle.mjs"),
    join(recoveryDir, "process-lifecycle.mjs")
  );
  await copyMigrationSnapshotEntry(
    join(SCRIPT_DIR, "cli"),
    join(recoveryDir, "cli")
  );
  return { script: cli.backup, directory: recoveryDir };
}

async function createMigrationSnapshot({ label, previousCommit, previousBranch }) {
  const backupDir = join(
    RELEASE_MIGRATION_BACKUP_DIR,
    `${migrationTimestamp()}-${String(label || "snapshot").replace(/[^A-Za-z0-9_-]/g, "-")}-${process.pid}`
  );
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  try { await chmod(backupDir, 0o700); } catch { /* Windows may ignore POSIX modes. */ }
  const entries = {
    config: await copyMigrationSnapshotEntry(CONFIG_PATH, join(backupDir, "cli-config.json")),
    env: await copyMigrationSnapshotEntry(ENV_LOCAL_PATH, join(backupDir, ".env.local")),
    runtime: await copyMigrationSnapshotEntry(services.cliRuntimeDataDir(), join(backupDir, "runtime-data"))
  };
  const recovery = await copyMigrationRecoveryBundle(backupDir);
  const manifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    label,
    previous_commit: previousCommit || null,
    previous_branch: previousBranch || null,
    backup_dir: backupDir,
    entries,
    recovery
  };
  durableAtomicWriteJson(join(backupDir, "manifest.json"), manifest, { mode: 0o600 });
  return manifest;
}

async function restoreMigrationConfig(snapshot) {
  for (const key of ["config", "env"]) {
    const entry = snapshot?.entries?.[key];
    if (!entry) continue;
    if (!entry.exists) {
      if (entry.source === CONFIG_PATH || entry.source === ENV_LOCAL_PATH) {
        rmSync(entry.source, { force: true });
      }
      continue;
    }
    if (!entry.backup || !existsSync(entry.backup)) {
      throw new Error(`Migration backup is missing ${key}: ${entry.backup || "unset"}`);
    }
    mkdirSync(dirname(entry.source), { recursive: true });
    cpSync(entry.backup, entry.source, {
      recursive: statSync(entry.backup).isDirectory(),
      force: true,
      preserveTimestamps: true
    });
    try { await chmod(entry.source, statSync(entry.backup).mode & 0o777); } catch { /* Windows may ignore POSIX modes. */ }
  }
}

async function prepareRuntimeState(opts) {
  let registry;
  let router;
  try {
    registry = await services.openCliWorkspaceRegistry();
    if (opts.workspace && existsSync(opts.workspace)) {
      await registry.registerWorkspace(opts.workspace, {
        metadata: {
          label: basename(opts.workspace),
          trusted: true,
          source: "migration"
        }
      });
    }
    const { TaskRouter } = await import(
      pathToFileURL(join(SERVER_DIR, "src", "workspace", "task-router.mjs")).href
    );
    router = await TaskRouter.open({ dataDir: services.cliRuntimeDataDir(), busyTimeoutMs: 5_000 });
    const [registryHealth, taskHealth] = await Promise.all([
      registry.health(),
      router.health()
    ]);
    if (
      String(registryHealth.integrity || "").toLowerCase() !== "ok" ||
      String(taskHealth.integrity || "").toLowerCase() !== "ok"
    ) {
      throw new Error("Runtime SQLite integrity check did not return ok.");
    }
    return {
      registry: registryHealth,
      task_router: taskHealth,
      data_dir: services.cliRuntimeDataDir()
    };
  } finally {
    await router?.close().catch(() => {});
    await registry?.close().catch(() => {});
  }
}

async function writeMigrationState(state) {
  ensureConfigDir();
  durableAtomicWriteJson(RELEASE_MIGRATION_STATE_PATH, {
    schema_version: 2,
    updated_at: new Date().toISOString(),
    ...state
  }, { mode: 0o600 });
}

async function writeMigrationStage(state, stage, details = {}) {
  const next = {
    ...state,
    ...details,
    schema_version: 2,
    stage,
    updated_at: new Date().toISOString()
  };
  await writeMigrationState(next);
  return next;
}

async function acquireMigrationLock() {
  const tryAcquire = async () => {
    mkdirSync(RELEASE_MIGRATION_LOCK_DIR, { mode: 0o700 });
    const observed = await inspectProcess(process.pid);
    const owner = {
      pid: process.pid,
      start_token: observed.startToken || "",
      nonce: newInstanceNonce(),
      acquired_at: new Date().toISOString()
    };
    durableAtomicWriteJson(join(RELEASE_MIGRATION_LOCK_DIR, "owner.json"), owner);
    return owner;
  };
  try {
    return await tryAcquire();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = readJsonFile(join(RELEASE_MIGRATION_LOCK_DIR, "owner.json"), null);
    const observed = owner?.pid ? await inspectProcess(owner.pid) : null;
    if (observed?.alive && (!owner.start_token || observed.startToken === owner.start_token)) {
      throw new Error(`Another migration coordinator is active (PID ${owner.pid}).`);
    }
    rmSync(RELEASE_MIGRATION_LOCK_DIR, { recursive: true, force: true });
    return tryAcquire();
  }
}

function releaseMigrationLock(owner) {
  const saved = readJsonFile(join(RELEASE_MIGRATION_LOCK_DIR, "owner.json"), null);
  if (!saved || saved.nonce !== owner?.nonce) return;
  rmSync(RELEASE_MIGRATION_LOCK_DIR, { recursive: true, force: true });
}

async function withMigrationLock(callback) {
  const owner = await acquireMigrationLock();
  try {
    return await callback();
  } finally {
    releaseMigrationLock(owner);
  }
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function installMigrationRecoveryShim(snapshot) {
  const recoveryScript = snapshot?.recovery?.script;
  if (!recoveryScript || !existsSync(recoveryScript)) {
    throw new Error("Migration recovery bundle is missing its CLI script.");
  }
  const marker = "local-coding-agent lca wrapper";
  const binDir = chooseCliBinDir();
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const cmdPath = join(binDir, "lca.cmd");
    const psPath = join(binDir, "lca.ps1");
    for (const target of [cmdPath, psPath]) {
      if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
        throw new Error(`Refusing to overwrite: ${target}`);
      }
    }
    writeFileSync(cmdPath, `@echo off\r\nrem ${marker}\r\nset "LCA_REPO_ROOT=${REPO_ROOT}"\r\nset "LCA_CONFIG_PATH=${CONFIG_PATH}"\r\nset "${MIGRATION_RECOVERY_ENV}=1"\r\nnode "${recoveryScript}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    writeFileSync(psPath, `# ${marker}\n$env:LCA_REPO_ROOT = ${JSON.stringify(REPO_ROOT)}\n$env:LCA_CONFIG_PATH = ${JSON.stringify(CONFIG_PATH)}\n$env:${MIGRATION_RECOVERY_ENV} = '1'\n& node ${JSON.stringify(recoveryScript)} @args\nexit $LASTEXITCODE\n`, "utf8");
    return cmdPath;
  }
  const target = join(binDir, "lca");
  if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
    throw new Error(`Refusing to overwrite: ${target}`);
  }
  writeFileSync(
    target,
    `#!/usr/bin/env bash\n# ${marker}\nexec env LCA_REPO_ROOT=${quotePosix(REPO_ROOT)} LCA_CONFIG_PATH=${quotePosix(CONFIG_PATH)} ${MIGRATION_RECOVERY_ENV}=1 node ${quotePosix(recoveryScript)} "$@"\n`,
    "utf8"
  );
  await chmod(target, 0o755);
  return target;
}

async function gitRevisionState(git) {
  const [commit, branch] = await Promise.all([
    capture(git, ["rev-parse", "HEAD"], { cwd: REPO_ROOT }),
    capture(git, ["branch", "--show-current"], { cwd: REPO_ROOT })
  ]);
  if (commit.code !== 0) throw new Error(`git rev-parse failed: ${commit.stderr || commit.stdout}`);
  return {
    commit: commit.stdout.trim(),
    branch: branch.code === 0 ? branch.stdout.trim() : ""
  };
}

async function gitCheckoutState(git) {
  const [revision, status] = await Promise.all([
    gitRevisionState(git),
    capture(git, ["status", "--short"], { cwd: REPO_ROOT })
  ]);
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr || status.stdout}`);
  const dirtyLines = status.stdout.split(/\r?\n/).filter(Boolean);
  return { ...revision, dirty: dirtyLines.length > 0, dirtyLines };
}

async function switchCheckout(git, commit, { discardChanges = false } = {}) {
  const args = ["switch", "--detach"];
  if (discardChanges) args.push("--discard-changes");
  args.push(commit);
  await runChecked("git", git, args, { cwd: REPO_ROOT });
}

async function restartFromCurrentCheckout(opts) {
  const node = opts.node || process.execPath;
  await runChecked(
    "restart",
    node,
    [join(REPO_ROOT, "scripts", "local-coding-agent.mjs"), "start", "--background"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, [SKIP_MIGRATION_RECOVERY_ENV]: "1" }
    }
  );
}

async function restoreRuntimeFromTransaction(state, opts) {
  if (!state.running_before) return;
  const running = await services.runningStatusForConfig(opts);
  if (!running.running) await restartFromCurrentCheckout(opts);
}

async function validateUpdatedCheckout(opts) {
  await installDeps(opts);
  const cliScript = join(REPO_ROOT, "scripts", "local-coding-agent.mjs");
  await runChecked("check", process.execPath, ["--check", cliScript], { cwd: REPO_ROOT });
  await runChecked("check", process.execPath, ["--check", join(REPO_ROOT, "scripts", "network-doctor.mjs")], { cwd: REPO_ROOT });
  await runChecked("skills", process.execPath, [join(REPO_ROOT, "scripts", "validate-skills.mjs")], { cwd: REPO_ROOT });
}

async function completeUpdateTransaction(state, opts) {
  state = await writeMigrationStage(state, "dependency_install_pending", { active_runtime: "current" });
  await validateUpdatedCheckout(opts);
  state = await writeMigrationStage(state, "storage_prepare_pending");
  const storage = await prepareRuntimeState(opts);
  state = await writeMigrationStage(state, "runtime_restore_pending", { storage });
  await restoreRuntimeFromTransaction(state, opts);
  await services.doctor({}, { requireServer: Boolean(state.running_before) });
  state = await writeMigrationStage(state, "complete", {
    active_runtime: "current",
    completed_at: new Date().toISOString(),
    connector_refresh_required: true,
    recovery_action: null
  });
  await installCliCommand();
  return state;
}

async function abortUpdateTransaction(state, opts, git, { switchFromTarget = false, force = false } = {}) {
  if (switchFromTarget) {
    state = await writeMigrationStage(state, state.stage, { recovery_action: "rollback_update" });
    await switchCheckout(git, state.source_commit || state.previous_commit, { discardChanges: Boolean(force) });
    await installDeps(opts);
  }
  await restoreMigrationConfig(state.backup);
  state = await writeMigrationStage(state, "runtime_restore_pending", {
    active_runtime: "previous",
    recovery_action: "rollback_update"
  });
  await restoreRuntimeFromTransaction(state, effectiveOptions());
  if (!state.backup && state.prior_migration && typeof state.prior_migration === "object") {
    const priorStage = MIGRATION_TERMINAL_STAGES.has(String(state.prior_migration.stage || ""))
      ? state.prior_migration.stage
      : "rolled_back_after_failed_upgrade";
    state = await writeMigrationStage(state.prior_migration, priorStage, {
      last_update_recovered_at: new Date().toISOString(),
      last_update_failure: state.failure || null
    });
    await installCliCommand();
    return state;
  }
  state = await writeMigrationStage(state, "rolled_back_after_failed_upgrade", {
    active_runtime: "previous",
    recovered_at: new Date().toISOString(),
    connector_refresh_required: Boolean(state.target_commit),
    recovery_action: null
  });
  await installCliCommand();
  return state;
}

async function completeRollbackTransaction(state, opts) {
  state = await writeMigrationStage(state, "config_restore_pending", { active_runtime: "previous" });
  await restoreMigrationConfig(state.backup);
  state = await writeMigrationStage(state, "dependency_install_pending");
  await installDeps(opts);
  state = await writeMigrationStage(state, "runtime_restore_pending");
  await restoreRuntimeFromTransaction(state, effectiveOptions());
  state = await writeMigrationStage(state, "rolled_back", {
    active_runtime: "previous",
    rolled_back_at: new Date().toISOString(),
    rolled_back_from_commit: state.source_commit,
    rollback_safety_backup: state.safety_backup,
    connector_refresh_required: true,
    recovery_action: null
  });
  await installCliCommand();
  return state;
}

async function abortRollbackTransaction(state, opts, git, { switchFromTarget = false, force = false } = {}) {
  if (switchFromTarget) {
    state = await writeMigrationStage(state, state.stage, { recovery_action: "recover_rollback_source" });
    await switchCheckout(git, state.source_commit, { discardChanges: Boolean(force) });
    await installDeps(opts);
  }
  await restoreMigrationConfig(state.safety_backup);
  state = await writeMigrationStage(state, "runtime_restore_pending", {
    active_runtime: "current",
    recovery_action: "recover_rollback_source"
  });
  await restoreRuntimeFromTransaction(state, effectiveOptions());
  const prior = state.prior_migration && typeof state.prior_migration === "object"
    ? state.prior_migration
    : state;
  state = await writeMigrationStage({
    ...prior,
    schema_version: 2,
    operation: "rollback",
    transaction_id: state.transaction_id,
    running_before: state.running_before,
    source_commit: state.source_commit,
    target_commit: state.target_commit,
    safety_backup: state.safety_backup
  }, "rollback_aborted", {
    active_runtime: "current",
    rollback_aborted_at: new Date().toISOString(),
    connector_refresh_required: true,
    recovery_action: null
  });
  await installCliCommand();
  return state;
}

async function recoverMigrationTransactionUnlocked(flags = {}) {
  let state = readMigrationState();
  if (!state || MIGRATION_TERMINAL_STAGES.has(String(state.stage || ""))) {
    if (process.env[MIGRATION_RECOVERY_ENV] === "1") await installCliCommand();
    return { handled: false, handoff: process.env[MIGRATION_RECOVERY_ENV] === "1", state };
  }
  const git = process.platform === "win32" ? "git.exe" : "git";
  const checkout = await gitCheckoutState(git);
  const decision = classifyMigrationRecovery(state, {
    head: checkout.commit,
    dirty: checkout.dirty,
    force: Boolean(flags.force)
  });
  if (decision.status === "blocked") {
    throw new Error(`Migration recovery is blocked: ${decision.reason}. No checkout changes were made.`);
  }
  const opts = effectiveOptions(flags);
  console.log(`Recovering interrupted ${decision.operation}: ${decision.action}.`);
  try {
    if (decision.action === "abort_update") {
      state = await abortUpdateTransaction(state, opts, git);
    } else if (decision.action === "resume_update") {
      state = await completeUpdateTransaction(state, opts);
    } else if (decision.action === "rollback_update") {
      state = await abortUpdateTransaction(state, opts, git, {
        switchFromTarget: true,
        force: Boolean(flags.force || state.force_authorized)
      });
    } else if (decision.action === "abort_rollback") {
      state = await abortRollbackTransaction(state, opts, git);
    } else if (decision.action === "resume_rollback") {
      state = await completeRollbackTransaction(state, opts);
    } else if (decision.action === "recover_rollback_source") {
      state = await abortRollbackTransaction(state, opts, git, {
        switchFromTarget: true,
        force: Boolean(flags.force || state.force_authorized)
      });
    }
    return { handled: true, handoff: true, state };
  } catch (error) {
    const failureStage = decision.operation === "rollback" ? "rollback_failed" : "update_failed";
    await writeMigrationStage(state, failureStage, {
      failure: error?.message || String(error),
      failed_at: new Date().toISOString()
    }).catch(() => {});
    throw error;
  }
}

async function recoverPendingMigration(flags = {}) {
  const state = readMigrationState();
  if (
    process.env[MIGRATION_RECOVERY_ENV] !== "1" &&
    (!state || MIGRATION_TERMINAL_STAGES.has(String(state.stage || "")))
  ) {
    return { handled: false, handoff: false, state };
  }
  return withMigrationLock(() => recoverMigrationTransactionUnlocked(flags));
}

async function updateSelfUnlocked(flags) {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const before = await capture(git, ["status", "--short", "--branch"], { cwd: REPO_ROOT });
  if (before.code !== 0) throw new Error(`git status failed: ${before.stderr || before.stdout}`);
  console.log(before.stdout.trim() || "working tree clean");
  const dirtyLines = before.stdout.split(/\r?\n/).filter((line) => line && !line.startsWith("##"));
  if (dirtyLines.length && !flags.force) {
    throw new Error("Local changes detected. Review them first, then rerun with --force only if you want to proceed.");
  }
  const opts = effectiveOptions(flags);
  const previous = await gitRevisionState(git);
  const running = await services.runningStatusForConfig(opts);
  let snapshot;
  let state = createMigrationTransactionState({
    operation: "update",
    sourceCommit: previous.commit,
    sourceBranch: previous.branch,
    runningBefore: running.running,
    dirtyBefore: dirtyLines.length > 0,
    forceAuthorized: Boolean(flags.force),
    priorMigration: readMigrationState()
  });
  try {
    state = await writeMigrationStage(state, "runtime_stop_pending", { active_runtime: "previous" });
    if (running.running) await services.stop(flags);
    state = await writeMigrationStage(state, "runtime_stopped");
    snapshot = await createMigrationSnapshot({
      label: "pre-upgrade",
      previousCommit: previous.commit,
      previousBranch: previous.branch
    });
    state = await writeMigrationStage(state, "prepared", { backup: snapshot });
    await installMigrationRecoveryShim(snapshot);
    state = await writeMigrationStage(state, "recovery_armed", {
      recovery_script: snapshot.recovery.script
    });
  } catch (error) {
    state = await writeMigrationStage(state, "update_failed", {
      failure: error?.message || String(error),
      failed_at: new Date().toISOString()
    }).catch(() => state);
    const recovery = await recoverMigrationTransactionUnlocked(flags).catch((recoveryError) => ({
      error: recoveryError?.message || String(recoveryError)
    }));
    throw new Error(`${error?.message || error}${recovery?.error ? ` Recovery pending: ${recovery.error}` : " The previous runtime was restored."}`);
  }
  try {
    await runChecked("git", git, ["fetch", "origin", "main", "--tags"], { cwd: REPO_ROOT });
    const target = await capture(git, ["rev-parse", "origin/main"], { cwd: REPO_ROOT });
    if (target.code !== 0 || !target.stdout.trim()) {
      throw new Error(`git could not resolve origin/main: ${target.stderr || target.stdout}`);
    }
    const targetCommit = target.stdout.trim();
    const fastForward = await capture(git, ["merge-base", "--is-ancestor", previous.commit, targetCommit], { cwd: REPO_ROOT });
    if (fastForward.code !== 0) throw new Error("origin/main is not a fast-forward from the current checkout.");
    const incoming = await capture(git, ["log", "--oneline", "--decorate", "--max-count=10", "HEAD..origin/main"], { cwd: REPO_ROOT });
    if (incoming.stdout.trim()) {
      console.log("\nIncoming changes:");
      console.log(incoming.stdout.trim());
    } else {
      console.log("\nAlready up to date with origin/main.");
    }
    state = await writeMigrationStage(state, "checkout_update_intent", { target_commit: targetCommit });
    await runChecked("git", git, ["merge", "--ff-only", targetCommit], { cwd: REPO_ROOT });
    const current = await gitRevisionState(git);
    if (current.commit !== targetCommit) {
      throw new Error(`Updated checkout ${current.commit} does not match recorded target ${targetCommit}.`);
    }
    state = await writeMigrationStage(state, "checkout_updated", {
      current_commit: current.commit,
      active_runtime: "current"
    });
    state = await completeUpdateTransaction(state, opts);
    console.log("\nUpdate complete.");
    console.log("Refresh the ChatGPT connector once and open a new chat for the current 35-tool catalog.");
  } catch (error) {
    state = await writeMigrationStage(state, "update_failed", {
      failure: error?.message || String(error),
      failed_at: new Date().toISOString()
    }).catch(() => state);
    const recovery = await recoverMigrationTransactionUnlocked(flags).catch((recoveryError) => ({
      error: recoveryError?.message || String(recoveryError)
    }));
    throw new Error(`${error?.message || error}${recovery?.error ? ` Recovery pending: ${recovery.error}` : " The previous runtime was restored."}`);
  }
}

async function updateSelf(flags) {
  return withMigrationLock(() => updateSelfUnlocked(flags));
}

async function rollbackToPreviousRuntimeUnlocked(flags) {
  const migration = readMigrationState();
  if (!migration?.previous_commit || !migration?.backup) {
    throw new Error("No release upgrade rollback point was found.");
  }
  const git = process.platform === "win32" ? "git.exe" : "git";
  const before = await capture(git, ["status", "--short", "--branch"], { cwd: REPO_ROOT });
  if (before.code !== 0) throw new Error(`git status failed: ${before.stderr || before.stdout}`);
  const dirtyLines = before.stdout.split(/\r?\n/).filter((line) => line && !line.startsWith("##"));
  if (dirtyLines.length && !flags.force) {
    throw new Error("Rollback would replace local changes. Review them first or rerun `lca rollback --force`.");
  }

  const opts = effectiveOptions(flags);
  const running = await services.runningStatusForConfig(opts);
  const current = await gitRevisionState(git);
  let safetySnapshot;
  let state = createMigrationTransactionState({
    operation: "rollback",
    sourceCommit: current.commit,
    sourceBranch: current.branch,
    targetCommit: migration.previous_commit,
    runningBefore: running.running,
    dirtyBefore: dirtyLines.length > 0,
    forceAuthorized: Boolean(flags.force),
    backup: migration.backup,
    priorMigration: migration
  });
  try {
    state = await writeMigrationStage(state, "runtime_stop_pending", { active_runtime: "current" });
    if (running.running) await services.stop(flags);
    state = await writeMigrationStage(state, "runtime_stopped");
    safetySnapshot = await createMigrationSnapshot({
      label: "pre-rollback",
      previousCommit: current.commit,
      previousBranch: current.branch
    });
    state = await writeMigrationStage(state, "prepared", {
      safety_backup: safetySnapshot,
      recovery_script: safetySnapshot.recovery.script
    });
    await installMigrationRecoveryShim(safetySnapshot);
    state = await writeMigrationStage(state, "recovery_armed");
  } catch (error) {
    state = await writeMigrationStage(state, "rollback_failed", {
      failure: error?.message || String(error),
      failed_at: new Date().toISOString()
    }).catch(() => state);
    const recovery = await recoverMigrationTransactionUnlocked(flags).catch((recoveryError) => ({
      error: recoveryError?.message || String(recoveryError)
    }));
    throw new Error(`${error?.message || error}${recovery?.error ? ` Recovery pending: ${recovery.error}` : " The current runtime was restored."}`);
  }

  try {
    state = await writeMigrationStage(state, "checkout_rollback_intent");
    await switchCheckout(git, migration.previous_commit, {
      discardChanges: Boolean(flags.force)
    });
    state = await writeMigrationStage(state, "checkout_rolled_back", { active_runtime: "previous" });
    state = await completeRollbackTransaction(state, opts);
    console.log(`Rolled back to ${migration.previous_commit}.`);
    console.log(`Runtime data remains preserved at ${services.cliRuntimeDataDir()}.`);
    console.log("Refresh the ChatGPT connector again if the rolled-back release uses a different catalog.");
  } catch (error) {
    state = await writeMigrationStage(state, "rollback_failed", {
      failure: error?.message || String(error),
      failed_at: new Date().toISOString()
    }).catch(() => state);
    const recovery = await recoverMigrationTransactionUnlocked(flags).catch((recoveryError) => ({
      error: recoveryError?.message || String(recoveryError)
    }));
    throw new Error(`${error?.message || error}${recovery?.error ? ` Recovery pending: ${recovery.error}` : " The current runtime was restored."}`);
  }
}

async function rollbackToPreviousRuntime(flags) {
  return withMigrationLock(() => rollbackToPreviousRuntimeUnlocked(flags));
}


export {
  recoverPendingMigration,
  rollbackToPreviousRuntime,
  updateSelf
};
