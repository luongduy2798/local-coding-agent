import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  applySetupSecurityConsent,
  classifyMigrationRecovery,
  createMigrationTransactionState,
  mergeDotEnvText,
  normalize,
  normalizeTunnelArch,
  parseDotEnv,
  resolveCliRuntimeDataDir,
  resolveSetupWorkspace,
  ripgrepInstallCommand,
  setupSecurityDefaults,
  supervisorBackoffMs,
  tunnelAssetName,
  tunnelAssetUrl
} from "./local-coding-agent.mjs";
import {
  MIN_NODE_VERSION,
  assertSupportedNodeVersion,
  compareNodeVersions,
  createProcessRecord,
  inspectProcess,
  nodeInstallGuidance,
  processIdentityMatches,
  terminateProcessRecord
} from "./process-lifecycle.mjs";
import {
  assertRepositoryIntact,
  createGitFixture,
  createIsolatedTestRoot,
  safeRemove,
  snapshotRepositoryState
} from "../server/tests/helpers/test-guard.mjs";

const execFileAsync = promisify(execFile);
const TEST_SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(TEST_SCRIPT_DIR, "local-coding-agent.mjs");
const REAL_REPOSITORY_ROOT = resolve(TEST_SCRIPT_DIR, "..");

async function runGitFixture(repositoryRoot, args) {
  const { stdout } = await execFileAsync(process.platform === "win32" ? "git.exe" : "git", args, {
    cwd: repositoryRoot,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

async function runMigrationCli(args, { cwd, env }) {
  return execFileAsync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

test("places default runtime state beside CLI config instead of inside the repository", () => {
  const config = resolve("isolated", "config", "cli-config.json");
  assert.equal(resolveCliRuntimeDataDir("", config), join(dirname(config), "data", "runtime"));
  const explicit = resolve("isolated", "agent-data");
  assert.equal(resolveCliRuntimeDataDir(explicit, config), resolve(explicit, "runtime"));
});

test("setup defaults to its local-coding-agent repository unless workspace is explicit", () => {
  const repositoryRoot = resolve("isolated", "local-coding-agent");
  const explicitWorkspace = resolve("isolated", "project");
  assert.equal(resolveSetupWorkspace("", repositoryRoot), repositoryRoot);
  assert.equal(resolveSetupWorkspace(explicitWorkspace, repositoryRoot), explicitWorkspace);
});

test("migration transaction persists restart and safety intent without secrets", () => {
  const state = createMigrationTransactionState({
    operation: "update",
    transactionId: "update-fixture",
    createdAt: "2026-07-17T00:00:00.000Z",
    sourceCommit: "source-commit",
    sourceBranch: "main",
    runningBefore: true,
    dirtyBefore: false,
    forceAuthorized: false,
    backup: { backup_dir: "/isolated/backup" }
  });
  assert.equal(state.schema_version, 2);
  assert.equal(state.stage, "prepared");
  assert.equal(state.running_before, true);
  assert.equal(state.source_commit, "source-commit");
  assert.equal(state.previous_commit, "source-commit");
  assert.equal(state.runtime_data_preserved_on_rollback, true);
  assert.equal(JSON.stringify(state).includes("runtimeKey"), false);
});

test("classifies interrupted update on either side of checkout intent", () => {
  const state = {
    operation: "update",
    stage: "checkout_update_intent",
    source_commit: "old",
    target_commit: "new"
  };
  assert.deepEqual(classifyMigrationRecovery(state, { head: "old" }), {
    status: "recoverable",
    action: "abort_update",
    operation: "update"
  });
  assert.deepEqual(classifyMigrationRecovery(state, { head: "new" }), {
    status: "recoverable",
    action: "resume_update",
    operation: "update"
  });
  assert.match(
    classifyMigrationRecovery(state, { head: "unrelated" }).reason,
    /neither recorded source.*nor target/
  );
});

test("failed update never discards a dirty checkout without force", () => {
  const state = {
    operation: "update",
    stage: "update_failed",
    source_commit: "old",
    target_commit: "new",
    force_authorized: false
  };
  const blocked = classifyMigrationRecovery(state, { head: "new", dirty: true });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /--force/);
  assert.equal(
    classifyMigrationRecovery(state, { head: "new", dirty: true, force: true }).action,
    "rollback_update"
  );
});

test("classifies rollback recovery and preserves the recorded running state", () => {
  const state = createMigrationTransactionState({
    operation: "rollback",
    transactionId: "rollback-fixture",
    createdAt: "2026-07-17T00:00:00.000Z",
    sourceCommit: "current",
    targetCommit: "previous",
    runningBefore: true,
    safetyBackup: { backup_dir: "/isolated/runtime" },
    priorMigration: { previous_commit: "previous", previous_branch: "main" }
  });
  state.stage = "checkout_rollback_intent";
  assert.equal(classifyMigrationRecovery(state, { head: "current" }).action, "abort_rollback");
  assert.equal(classifyMigrationRecovery(state, { head: "previous" }).action, "resume_rollback");
  assert.equal(state.running_before, true);

  state.stage = "rollback_failed";
  const blocked = classifyMigrationRecovery(state, { head: "previous", dirty: true });
  assert.equal(blocked.status, "blocked");
  assert.equal(
    classifyMigrationRecovery(state, { head: "previous", dirty: true, force: true }).action,
    "recover_rollback_source"
  );
});

test("completed migration records do not trigger recovery", () => {
  for (const stage of [
    "complete",
    "rolled_back",
    "rolled_back_after_failed_upgrade",
    "rollback_aborted"
  ]) {
    assert.deepEqual(classifyMigrationRecovery({ operation: "update", stage }, {
      head: "new"
    }), { status: "terminal", action: "none" }, stage);
  }
  assert.deepEqual(classifyMigrationRecovery(null, { head: "new" }), {
    status: "none",
    action: "none"
  });
});

test("classifies crash recovery at every durable update and rollback stage", () => {
  const expectAction = ({ operation, stage, head, action }) => {
    const source = operation === "update" ? "previous" : "current";
    const target = operation === "update" ? "current" : "previous";
    assert.deepEqual(classifyMigrationRecovery({
      operation,
      stage,
      source_commit: source,
      target_commit: target
    }, { head }), {
      status: "recoverable",
      action,
      operation
    }, `${operation}:${stage}:${head}`);
  };

  for (const stage of [
    "runtime_stop_pending",
    "runtime_stopped",
    "prepared",
    "recovery_armed",
    "checkout_update_intent"
  ]) {
    expectAction({ operation: "update", stage, head: "previous", action: "abort_update" });
  }
  for (const stage of [
    "checkout_update_intent",
    "checkout_updated",
    "dependency_install_pending",
    "storage_prepare_pending",
    "runtime_restore_pending"
  ]) {
    expectAction({ operation: "update", stage, head: "current", action: "resume_update" });
  }
  expectAction({ operation: "update", stage: "update_failed", head: "previous", action: "abort_update" });
  expectAction({ operation: "update", stage: "update_failed", head: "current", action: "rollback_update" });

  for (const stage of [
    "runtime_stop_pending",
    "runtime_stopped",
    "prepared",
    "recovery_armed",
    "checkout_rollback_intent"
  ]) {
    expectAction({ operation: "rollback", stage, head: "current", action: "abort_rollback" });
  }
  for (const stage of [
    "checkout_rollback_intent",
    "checkout_rolled_back",
    "config_restore_pending",
    "dependency_install_pending",
    "runtime_restore_pending"
  ]) {
    expectAction({ operation: "rollback", stage, head: "previous", action: "resume_rollback" });
  }
  expectAction({ operation: "rollback", stage: "rollback_failed", head: "current", action: "abort_rollback" });
  expectAction({ operation: "rollback", stage: "rollback_failed", head: "previous", action: "recover_rollback_source" });
});

test("migration recovery uses isolated Git HEADs and preserves runtime data", async () => {
  const realRepositoryBefore = await snapshotRepositoryState(REAL_REPOSITORY_ROOT);
  const context = await createIsolatedTestRoot({
    prefix: "lca-migration-recovery-",
    protectedPaths: [REAL_REPOSITORY_ROOT]
  });
  const fixture = await createGitFixture(context, {
    initialFiles: {
      "README.md": "previous fixture\n",
      "scripts/local-coding-agent.mjs": await readFile(CLI_PATH, "utf8"),
      "scripts/process-lifecycle.mjs": await readFile(join(TEST_SCRIPT_DIR, "process-lifecycle.mjs"), "utf8")
    }
  });
  const configPath = join(context.dataDir, "config", "cli-config.json");
  const migrationStatePath = join(dirname(configPath), "release-migration.json");
  const agentDataDir = join(context.dataDir, "agent-state");
  const sentinelPath = join(agentDataDir, "runtime", "sentinel.json");
  const binDir = join(context.fixtureDir, "bin");
  const homeDir = join(context.fixtureDir, "home");

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  Object.assign(env, {
    PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(homeDir, "AppData", "Local"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    LCA_REPO_ROOT: fixture.root,
    LCA_CONFIG_PATH: configPath,
    LCA_BIN_DIR: binDir,
    AGENT_DATA_DIR: agentDataDir,
    NODE: process.execPath
  });
  delete env.LCA_MIGRATION_RECOVERY;
  delete env.LCA_SKIP_MIGRATION_RECOVERY;

  try {
    await Promise.all([
      mkdir(dirname(configPath), { recursive: true }),
      mkdir(dirname(sentinelPath), { recursive: true }),
      mkdir(binDir, { recursive: true }),
      mkdir(homeDir, { recursive: true })
    ]);
    await writeFile(sentinelPath, JSON.stringify({ generation: "current", retained: true }), "utf8");

    const previousCommit = await runGitFixture(fixture.root, ["rev-parse", "HEAD"]);
    await writeFile(join(fixture.root, "README.md"), "current fixture\n", "utf8");
    await runGitFixture(fixture.root, ["add", "README.md"]);
    await runGitFixture(fixture.root, ["commit", "-m", "current fixture"]);
    const currentCommit = await runGitFixture(fixture.root, ["rev-parse", "HEAD"]);
    assert.notEqual(previousCommit, currentCommit);

    await runGitFixture(fixture.root, ["switch", "--detach", previousCommit]);
    const updateState = createMigrationTransactionState({
      operation: "update",
      transactionId: "isolated-update-recovery",
      sourceCommit: previousCommit,
      targetCommit: currentCommit,
      runningBefore: false,
      backup: null
    });
    updateState.stage = "checkout_update_intent";
    await writeFile(migrationStatePath, `${JSON.stringify(updateState, null, 2)}\n`, "utf8");

    const updateRecovery = await runMigrationCli(["update"], { cwd: fixture.root, env });
    assert.match(updateRecovery.stdout, /Recovering interrupted update: abort_update\./);
    const recoveredUpdate = JSON.parse(await readFile(migrationStatePath, "utf8"));
    assert.equal(recoveredUpdate.stage, "rolled_back_after_failed_upgrade");
    assert.equal(await runGitFixture(fixture.root, ["rev-parse", "HEAD"]), previousCommit);
    assert.deepEqual(JSON.parse(await readFile(sentinelPath, "utf8")), {
      generation: "current",
      retained: true
    });

    await runGitFixture(fixture.root, ["switch", "--detach", currentCommit]);
    assert.deepEqual(classifyMigrationRecovery(updateState, {
      head: await runGitFixture(fixture.root, ["rev-parse", "HEAD"])
    }), {
      status: "recoverable",
      action: "resume_update",
      operation: "update"
    });

    const rollbackState = createMigrationTransactionState({
      operation: "rollback",
      transactionId: "isolated-rollback-recovery",
      sourceCommit: currentCommit,
      targetCommit: previousCommit,
      runningBefore: false,
      safetyBackup: null
    });
    rollbackState.stage = "checkout_rollback_intent";
    await writeFile(migrationStatePath, `${JSON.stringify(rollbackState, null, 2)}\n`, "utf8");

    const rollbackRecovery = await runMigrationCli(["rollback"], { cwd: fixture.root, env });
    assert.match(rollbackRecovery.stdout, /Recovering interrupted rollback: abort_rollback\./);
    const recoveredRollback = JSON.parse(await readFile(migrationStatePath, "utf8"));
    assert.equal(recoveredRollback.stage, "rollback_aborted");
    assert.equal(recoveredRollback.runtime_data_preserved_on_rollback, true);
    assert.equal(await runGitFixture(fixture.root, ["rev-parse", "HEAD"]), currentCommit);
    assert.deepEqual(JSON.parse(await readFile(sentinelPath, "utf8")), {
      generation: "current",
      retained: true
    });

    await runGitFixture(fixture.root, ["switch", "--detach", previousCommit]);
    assert.deepEqual(classifyMigrationRecovery(rollbackState, {
      head: await runGitFixture(fixture.root, ["rev-parse", "HEAD"])
    }), {
      status: "recoverable",
      action: "resume_rollback",
      operation: "rollback"
    });
  } finally {
    await assertRepositoryIntact(REAL_REPOSITORY_ROOT, realRepositoryBefore);
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

async function waitUntilNotAlive(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await inspectProcess(pid)).alive) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !(await inspectProcess(pid)).alive;
}

test("requires Node.js 22.13.0 or newer with actionable OS guidance", () => {
  assert.equal(MIN_NODE_VERSION, "22.13.0");
  assert.equal(compareNodeVersions("22.12.9", MIN_NODE_VERSION), -1);
  assert.equal(compareNodeVersions("v22.13.0", MIN_NODE_VERSION), 0);
  assert.equal(compareNodeVersions("23.0.0", MIN_NODE_VERSION), 1);
  assert.equal(compareNodeVersions("not-a-version", MIN_NODE_VERSION), null);
  assert.equal(assertSupportedNodeVersion("22.13.0"), true);
  assert.throws(
    () => assertSupportedNodeVersion("22.12.0", "darwin"),
    /Node\.js >=22\.13\.0.*brew install node@22/
  );
  assert.match(nodeInstallGuidance("win32"), /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(nodeInstallGuidance("linux", { wsl: true }), /nvm install 22/);
});

test("managed process identity rejects PID reuse and executable drift", () => {
  const observed = {
    alive: true,
    pid: 4242,
    startToken: "991122",
    executable: "/usr/local/bin/node",
    command: "/usr/local/bin/node server.mjs"
  };
  const record = createProcessRecord({
    role: "server",
    pid: 4242,
    instanceNonce: "instance-a",
    expectedExecutable: "node",
    commandMarker: "server.mjs",
    observed,
    spawnedAt: "2026-07-16T00:00:00.000Z"
  });
  assert.equal(processIdentityMatches(record, observed, {
    role: "server",
    instanceNonce: "instance-a",
    executable: "node",
    commandMarker: "server.mjs"
  }), true);
  assert.equal(processIdentityMatches(record, { ...observed, startToken: "different-start" }), false);
  const groupedRecord = { ...record, processGroupId: 777 };
  assert.equal(processIdentityMatches(groupedRecord, { ...observed, processGroupId: 778 }), false);
  assert.equal(processIdentityMatches(record, { ...observed, executable: "/usr/bin/python3", command: "python3 server.mjs" }), false);
  assert.equal(processIdentityMatches(record, observed, { role: "server", instanceNonce: "instance-b" }), false);

  const tunnelRecord = createProcessRecord({
    role: "tunnel",
    pid: 4343,
    instanceNonce: "instance-a",
    expectedExecutable: "/trusted/bin/tunnel-client",
    commandMarker: "tunnel-client",
    observed: {
      alive: true,
      pid: 4343,
      startToken: "778899",
      executable: "/trusted/bin/tunnel-client",
      command: "/trusted/bin/tunnel-client run"
    }
  });
  assert.equal(processIdentityMatches(tunnelRecord, {
    alive: true,
    pid: 4343,
    startToken: "778899",
    executable: "/untrusted/bin/tunnel-client",
    command: "/untrusted/bin/tunnel-client run"
  }), false);
});

test("verified detached supervisor shutdown terminates its whole process group", {
  skip: process.platform === "win32"
}, async () => {
  const marker = "lca-process-group-fixture";
  const source = [
    'const { spawn } = require("node:child_process");',
    `const marker = ${JSON.stringify(marker)};`,
    "const ownerPid = process.ppid;",
    'const child = spawn(process.execPath, ["-e", `const marker = ${JSON.stringify(marker)}; setInterval(() => {}, 1000);`], { stdio: "ignore" });',
    'const stopIfOwnerExited = setInterval(() => { if (process.ppid !== ownerPid) { try { child.kill("SIGTERM"); } catch {} process.exit(0); } }, 100);',
    "stopIfOwnerExited.unref();",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const leader = spawn(process.execPath, ["-e", source], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  leader.stdout.setEncoding("utf8");
  let descendantPid = 0;
  try {
    descendantPid = Number(await new Promise((resolvePid, rejectPid) => {
      let stdout = "";
      const timer = setTimeout(() => rejectPid(new Error("process-group fixture did not report its child PID")), 3_000);
      leader.stdout.on("data", (chunk) => {
        stdout += chunk;
        const line = stdout.split(/\r?\n/, 1)[0].trim();
        if (!/^\d+$/.test(line)) return;
        clearTimeout(timer);
        resolvePid(line);
      });
      leader.once("error", (error) => {
        clearTimeout(timer);
        rejectPid(error);
      });
    }));
    assert.ok(descendantPid > 0);

    const observed = await inspectProcess(leader.pid);
    assert.equal(observed.alive, true);
    assert.equal(observed.processGroupId, leader.pid);
    const record = createProcessRecord({
      role: "supervisor",
      pid: leader.pid,
      instanceNonce: "process-group-test",
      expectedExecutable: process.execPath,
      commandMarker: marker,
      observed
    });
    const result = await terminateProcessRecord(record, {
      role: "supervisor",
      instanceNonce: "process-group-test",
      executable: process.execPath,
      commandMarker: marker
    });
    assert.equal(result.stopped, true, result.reason);
    assert.equal(result.scope, "process-group");
    assert.equal(await waitUntilNotAlive(leader.pid), true);
    assert.equal(await waitUntilNotAlive(descendantPid), true);
  } finally {
    // Exact-PID cleanup only; this runs solely when the tested shutdown path
    // failed before it could stop one of the processes it created.
    for (const pid of [descendantPid, leader.pid]) {
      if (!pid || !(await inspectProcess(pid)).alive) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
});

test("supervisor restart backoff is bounded", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 99].map(supervisorBackoffMs),
    [250, 500, 1_000, 2_000, 4_000, 4_000, 4_000]
  );
});

test("normalizes default CLI port to 8789", () => {
  assert.equal(normalize({}).port, "8789");
});

test("maps tunnel-client release assets for supported platforms", () => {
  assert.equal(tunnelAssetName("v0.0.10", "darwin", "arm64"), "tunnel-client-v0.0.10-darwin-arm64.zip");
  assert.equal(tunnelAssetName("v0.0.10", "linux", "x64"), "tunnel-client-v0.0.10-linux-amd64.zip");
  assert.equal(tunnelAssetName("v0.0.10", "windows", "amd64"), "tunnel-client-v0.0.10-windows-amd64.zip");
  assert.equal(
    tunnelAssetUrl("v0.0.10", "windows", "arm64"),
    "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-windows-arm64.zip"
  );
});

test("normalizes supported CPU architectures", () => {
  assert.equal(normalizeTunnelArch("x64"), "amd64");
  assert.equal(normalizeTunnelArch("amd64"), "amd64");
  assert.equal(normalizeTunnelArch("aarch64"), "arm64");
  assert.equal(normalizeTunnelArch("arm64"), "arm64");
  assert.throws(() => normalizeTunnelArch("ia32"), /Unsupported CPU architecture/);
});

test("parses and merges dotenv without dropping unrelated values", () => {
  const existing = "KEEP=1\nCONTROL_PLANE_TUNNEL_ID=tunnel_old\n";
  const merged = mergeDotEnvText(existing, {
    CONTROL_PLANE_TUNNEL_ID: "tunnel_new",
    CONTROL_PLANE_API_KEY: "sk-proj-new"
  });
  assert.deepEqual(parseDotEnv(merged), {
    KEEP: "1",
    CONTROL_PLANE_TUNNEL_ID: "tunnel_new",
    CONTROL_PLANE_API_KEY: "sk-proj-new"
  });
});

test("empty dotenv merge starts with the requested key", () => {
  const merged = mergeDotEnvText("", { CONTROL_PLANE_TUNNEL_ID: "tunnel_new" });
  assert.equal(merged, "CONTROL_PLANE_TUNNEL_ID=tunnel_new\n");
});

test("setup defaults to full mode and full policy unless flags override", () => {
  assert.deepEqual(setupSecurityDefaults({}), { mode: "full", policy: "full" });
  assert.deepEqual(setupSecurityDefaults({ mode: "safe", policy: "balanced" }), { mode: "safe", policy: "balanced" });
});

test("setup requires one-time consent before elevating an existing safe config", () => {
  const declined = applySetupSecurityConsent({ mode: "safe", policy: "balanced" }, {}, false);
  assert.equal(declined.mode, "safe");
  assert.equal(declined.policy, "balanced");
  assert.equal(declined.fullAccessConsentVersion, undefined);

  const accepted = applySetupSecurityConsent({ mode: "safe", policy: "balanced" }, {}, true);
  assert.equal(accepted.mode, "full");
  assert.equal(accepted.policy, "full");
  assert.equal(accepted.fullAccessConsentVersion, 1);

  const explicit = applySetupSecurityConsent(
    { mode: "safe", policy: "balanced" },
    { mode: "full", policy: "full" }
  );
  assert.equal(explicit.mode, "full");
  assert.equal(explicit.policy, "full");
  assert.equal(explicit.fullAccessConsentSource, "explicit-cli");
});

test("selects ripgrep install command by platform", () => {
  assert.deepEqual(ripgrepInstallCommand({ id: "darwin" }, ["brew"]), {
    label: "Homebrew",
    command: "brew",
    args: ["install", "ripgrep"]
  });
  assert.deepEqual(ripgrepInstallCommand({ id: "win32" }, ["winget"]), {
    label: "winget",
    command: "winget",
    args: ["install", "--id", "BurntSushi.ripgrep.MSVC", "-e"]
  });
  const linux = ripgrepInstallCommand({ id: "linux" }, ["apt-get"]);
  assert.equal(linux.label, "apt-get");
  assert.match(`${linux.command} ${linux.args.join(" ")}`, /apt-get .*install -y ripgrep|apt-get install -y ripgrep/);
  assert.equal(ripgrepInstallCommand({ id: "linux" }, []), null);
});
