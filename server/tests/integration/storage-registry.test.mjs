// Local Coding Agent runtime storage and workspace registry integration tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  mkdir,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  createIsolatedTestRoot,
  safeRemove
} from "../helpers/test-guard.mjs";
import {
  isNodeVersionSupported,
  openWorkspaceDatabase,
  probeSqliteCapability,
  SqliteWorkerDatabase
} from "../../src/storage/database.mjs";
import {
  WorkspaceRegistry,
  WorkspaceRegistryError
} from "../../src/workspace/registry.mjs";

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof WorkspaceRegistryError, true, error?.stack || String(error));
    assert.equal(error.code, code, error?.stack || String(error));
    return true;
  });
}

assert.equal(isNodeVersionSupported("22.12.99"), false);
assert.equal(isNodeVersionSupported("22.13.0"), true);
assert.equal(isNodeVersionSupported("23.0.0"), true);

const capability = await probeSqliteCapability({ refresh: true });
assert.equal(capability.ok, true, JSON.stringify(capability));

const context = await createIsolatedTestRoot({
  prefix: "lca-runtime-storage-",
  protectedPaths: [path.resolve("..")]
});
const workspaceA = path.join(context.fixtureDir, "workspace-a");
const workspaceAOffline = path.join(context.fixtureDir, "workspace-a-offline");
const workspaceB = path.join(context.fixtureDir, "workspace-b");
const outside = path.join(context.fixtureDir, "outside");
const nestedA = path.join(workspaceA, "nested");
const aliasA = path.join(context.fixtureDir, "workspace-a-alias");
const workspaceC = path.join(context.fixtureDir, "workspace-c");
const aliasC = path.join(context.fixtureDir, "workspace-c-alias");
let workspaceARenamed = false;
let registry;

try {
  await Promise.all([
    mkdir(nestedA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
    mkdir(workspaceC, { recursive: true }),
    mkdir(outside, { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(workspaceA, "source.txt"), "alpha\n", "utf8"),
    writeFile(path.join(workspaceB, "source.txt"), "bravo\n", "utf8"),
    writeFile(path.join(workspaceB, "extra.txt"), "extra\n", "utf8"),
    writeFile(path.join(outside, "secret.txt"), "outside\n", "utf8")
  ]);
  await symlink(workspaceA, aliasA, process.platform === "win32" ? "junction" : "dir");
  await symlink(workspaceC, aliasC, process.platform === "win32" ? "junction" : "dir");
  await symlink(outside, path.join(workspaceB, "escape"), process.platform === "win32" ? "junction" : "dir");

  const lifecycleDb = await openWorkspaceDatabase({
    databasePath: path.join(context.dataDir, "runtime-lifecycle.sqlite3")
  });
  const pendingQueries = Array.from(
    { length: 20 },
    (_, index) => lifecycleDb.get("SELECT ? AS value", [index])
  );
  const lifecycleClose = Promise.all([lifecycleDb.close(), lifecycleDb.close()]);
  const pendingResults = await Promise.all(pendingQueries);
  await lifecycleClose;
  assert.deepEqual(pendingResults.map((row) => Number(row.value)), Array.from({ length: 20 }, (_, index) => index));
  await assert.rejects(lifecycleDb.health(), (error) => error?.code === "SQLITE_DATABASE_CLOSED");

  const busyPath = path.join(context.dataDir, "runtime-busy.sqlite3");
  const busySchema = {
    version: 1,
    migrations: [{
      version: 1,
      sql: "CREATE TABLE busy_probe(id TEXT PRIMARY KEY, value TEXT NOT NULL);"
    }]
  };
  const busyOwner = await SqliteWorkerDatabase.open({
    databasePath: busyPath,
    busyTimeoutMs: 5_000,
    schema: busySchema
  });
  const busyContender = await SqliteWorkerDatabase.open({
    databasePath: busyPath,
    busyTimeoutMs: 5_000,
    schema: busySchema
  });
  await busyOwner.exec("BEGIN IMMEDIATE");
  const busyStarted = performance.now();
  const blockedWrite = busyContender.run(
    "INSERT INTO busy_probe(id, value) VALUES (?, ?)",
    ["waited", "preserved"]
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await busyOwner.exec("COMMIT");
  await blockedWrite;
  const busyElapsed = performance.now() - busyStarted;
  assert.ok(busyElapsed >= 75 && busyElapsed < 5_000, `busy_timeout wait was ${busyElapsed}ms`);
  assert.equal(
    (await busyOwner.get("SELECT value FROM busy_probe WHERE id = ?", ["waited"]))?.value,
    "preserved"
  );
  await busyContender.close();
  await busyOwner.close();

  const migrationPath = path.join(context.dataDir, "runtime-workspace-migration.sqlite3");
  const schemaV1 = await SqliteWorkerDatabase.open({
    databasePath: migrationPath,
    schema: {
      version: 1,
      migrations: [{
        version: 1,
        sql: "CREATE TABLE legacy_marker(id TEXT PRIMARY KEY, value TEXT NOT NULL);"
      }]
    }
  });
  await schemaV1.run(
    "INSERT INTO legacy_marker(id, value) VALUES (?, ?)",
    ["before-v2", "preserved"]
  );
  await schemaV1.close();
  const migratedWorkspace = await openWorkspaceDatabase({ databasePath: migrationPath });
  assert.equal((await migratedWorkspace.health()).schemaVersion, 2);
  assert.equal(
    (await migratedWorkspace.get("SELECT value FROM legacy_marker WHERE id = ?", ["before-v2"]))?.value,
    "preserved"
  );
  assert.equal(
    (await migratedWorkspace.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'"
    ))?.name,
    "notes"
  );
  await migratedWorkspace.close();

  registry = await WorkspaceRegistry.open({
    dataDir: path.join(context.dataDir, "runtime"),
    maxOpenWorkspaces: 1
  });

  const registryHealth = await registry.health();
  assert.equal(registryHealth.schemaVersion, 5);
  assert.equal(registryHealth.journalMode.toLowerCase(), "wal");
  assert.equal(registryHealth.foreignKeys, 1);
  assert.equal(registryHealth.busyTimeout, 5_000);

  const transactionCreatedAt = new Date().toISOString();
  const preparingTransaction = await registry.upsertTransactionState({
    id: "tx_registry_probe",
    status: "preparing",
    task_id: "task_registry_probe",
    workspace_ids: ["ws_probe_b", "ws_probe_a", "ws_probe_a"],
    manifest_version: 1,
    manifest_file: "tx_registry_probe.json",
    created_at: transactionCreatedAt,
    updated_at: transactionCreatedAt
  });
  assert.deepEqual(preparingTransaction.workspace_ids, ["ws_probe_a", "ws_probe_b"]);
  assert.deepEqual(
    (await registry.listTransactionStates({ incompleteOnly: true })).map((item) => item.id),
    ["tx_registry_probe"]
  );
  const transactionCompletedAt = new Date().toISOString();
  const completedTransaction = await registry.upsertTransactionState({
    ...preparingTransaction,
    status: "complete",
    updated_at: transactionCompletedAt,
    completed_at: transactionCompletedAt
  });
  assert.equal(completedTransaction.status, "complete");
  assert.deepEqual(await registry.listTransactionStates({ incompleteOnly: true }), []);

  await expectCode(
    registry.registerWorkspace(context.dataDir),
    "WORKSPACE_CONTROL_PLANE_OVERLAP"
  );
  await expectCode(
    registry.registerWorkspace(path.join(context.dataDir, "runtime", "workspaces")),
    "WORKSPACE_CONTROL_PLANE_OVERLAP"
  );

  const registeredA = await registry.registerWorkspace(workspaceA, {
    metadata: { label: "A" }
  });
  const registeredB = await registry.registerWorkspace(workspaceB, {
    metadata: { label: "B" }
  });
  const registeredC = await registry.registerWorkspace(aliasC, {
    metadata: { label: "C through trusted alias" }
  });
  assert.equal(registeredA.created, true);
  assert.equal(registeredB.created, true);
  assert.match(registeredA.workspace.id, /^ws_[a-f0-9]{32}$/);
  assert.equal(registeredA.workspace.metadata.git.is_repository, false);
  assert.equal(registeredA.workspace.metadata.git.identity, null);
  assert.notEqual(registeredA.workspace.id, registeredB.workspace.id);
  assert.equal(registeredC.workspace.availability, "available");

  const aliasRegistration = await registry.registerWorkspace(aliasA);
  assert.equal(aliasRegistration.created, false);
  assert.equal(aliasRegistration.workspace.id, registeredA.workspace.id);

  await expectCode(
    registry.registerWorkspace(nestedA),
    "WORKSPACE_ROOT_OVERLAP"
  );
  await expectCode(
    registry.registerWorkspace(context.fixtureDir),
    "WORKSPACE_ROOT_OVERLAP"
  );

  const listed = await registry.listWorkspaces();
  assert.deepEqual(
    new Set(listed.map((item) => item.id)),
    new Set([registeredA.workspace.id, registeredB.workspace.id, registeredC.workspace.id])
  );

  const selectedA = await registry.selectWorkspace(registeredA.workspace.id);
  assert.equal(selectedA.workspace.id, registeredA.workspace.id);
  assert.equal(await registry.getSelectedWorkspace({ scope: "not-selected" }), null);

  await rename(workspaceA, workspaceAOffline);
  workspaceARenamed = true;
  await expectCode(
    registry.getSelectedWorkspace(),
    "WORKSPACE_UNAVAILABLE"
  );
  await expectCode(
    registry.selectWorkspace(registeredA.workspace.id),
    "WORKSPACE_UNAVAILABLE"
  );
  await rename(workspaceAOffline, workspaceA);
  workspaceARenamed = false;
  const restoredSelection = await registry.getSelectedWorkspace();
  assert.equal(restoredSelection.workspace.id, registeredA.workspace.id);

  await unlink(aliasC);
  await symlink(outside, aliasC, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    (await registry.getWorkspace(registeredC.workspace.id)).availability,
    "unavailable",
    "a registered root whose symlink identity changes must fail closed"
  );

  const workspaceDbB = await registry.openWorkspace(registeredB.workspace.id);
  const workspaceHealth = await workspaceDbB.health();
  assert.equal(workspaceHealth.schemaVersion, 2);
  assert.equal(workspaceHealth.journalMode.toLowerCase(), "wal");
  assert.equal(workspaceHealth.foreignKeys, 1);
  assert.equal(workspaceHealth.busyTimeout, 5_000);

  await expectCode(
    workspaceDbB.openTask({
      title: "Reject symlink escape",
      attachments: [{ path: "escape/secret.txt", access: "read" }]
    }),
    "ATTACHMENT_OUTSIDE_WORKSPACE"
  );
  await expectCode(
    workspaceDbB.openTask({
      title: "Reject traversal",
      attachments: [{ path: "../outside/secret.txt", access: "read" }]
    }),
    "ATTACHMENT_OUTSIDE_WORKSPACE"
  );

  const opened = await workspaceDbB.openTask({
    title: "Storage task",
    ownerSessionId: "session-a",
    attachments: [
      { path: "source.txt", access: "read" },
      { path: "generated/new.txt", access: "write" }
    ]
  });
  assert.equal(opened.status, "open");
  assert.equal(opened.token, 1);
  assert.equal(opened.workspaceId, registeredB.workspace.id);
  assert.equal(opened.attachments.length, 2);
  assert.match(opened.attachments.find((item) => item.path === "source.txt").version, /^[a-f0-9]{64}$/);
  assert.equal(opened.attachments.find((item) => item.path === "generated/new.txt").exists, false);
  assert.deepEqual(await workspaceDbB.verifyTaskAttachments(opened.id), {
    ok: true,
    taskId: opened.id,
    conflicts: []
  });

  const savedNote = await workspaceDbB.saveNote({
    taskId: opened.id,
    title: "Scoped finding",
    body: "Only this task and workspace may read this note."
  });
  assert.equal(savedNote.task_id, opened.id);
  assert.equal(savedNote.workspace_id, registeredB.workspace.id);
  assert.deepEqual(await workspaceDbB.listNotes({ taskId: opened.id }), [savedNote]);

  const otherTask = await workspaceDbB.openTask({ title: "Other note scope" });
  assert.deepEqual(await workspaceDbB.listNotes({ taskId: otherTask.id }), []);

  const attached = await workspaceDbB.addAttachments(opened.id, opened.token, [
    { path: "extra.txt", access: "write" }
  ]);
  assert.equal(attached.token, 1);
  assert.equal(attached.attachments.length, 3);

  const rotated = await workspaceDbB.rotateTaskToken(opened.id, attached.token, {
    ownerSessionId: "session-b"
  });
  assert.equal(rotated.token, 2);
  assert.equal(rotated.ownerSessionId, "session-b");
  await expectCode(
    workspaceDbB.addAttachments(opened.id, 1, [{ path: "extra.txt", access: "read" }]),
    "TASK_TOKEN_STALE"
  );
  await expectCode(
    workspaceDbB.addAttachments(opened.id, 1, []),
    "TASK_TOKEN_STALE"
  );

  const competing = await Promise.allSettled([
    workspaceDbB.rotateTaskToken(opened.id, rotated.token),
    workspaceDbB.rotateTaskToken(opened.id, rotated.token)
  ]);
  assert.equal(competing.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(competing.filter(
    (item) => item.status === "rejected" && item.reason?.code === "TASK_TOKEN_STALE"
  ).length, 1);
  const winningToken = competing.find((item) => item.status === "fulfilled").value.token;
  assert.equal(winningToken, 3);

  const frozen = await workspaceDbB.freezeTask(opened.id, winningToken, {
    verifyAttachments: true
  });
  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.token, 4);
  await expectCode(
    workspaceDbB.addAttachments(frozen.id, frozen.token, [
      { path: "extra.txt", access: "read" }
    ]),
    "TASK_STATE_INVALID"
  );

  const closed = await workspaceDbB.closeTask(frozen.id, frozen.token);
  assert.equal(closed.status, "closed");
  assert.equal(closed.token, 5);
  await expectCode(
    workspaceDbB.rotateTaskToken(closed.id, closed.token),
    "TASK_STATE_INVALID"
  );

  const staleTask = await workspaceDbB.openTask({
    title: "Attachment freshness",
    attachments: [{ path: "source.txt", access: "write" }]
  });
  await writeFile(path.join(workspaceB, "source.txt"), "bravo changed\n", "utf8");
  await expectCode(
    workspaceDbB.freezeTask(staleTask.id, staleTask.token, {
      verifyAttachments: true
    }),
    "TASK_ATTACHMENTS_STALE"
  );
  const refreshedTask = await workspaceDbB.addAttachments(staleTask.id, staleTask.token, [
    { path: "source.txt", access: "write" }
  ]);
  const freshFreeze = await workspaceDbB.freezeTask(refreshedTask.id, refreshedTask.token, {
    verifyAttachments: true
  });
  assert.equal(freshFreeze.status, "frozen");

  const workspaceDbA = await registry.openWorkspace(registeredA.workspace.id);
  assert.deepEqual(await workspaceDbA.listTasks(), []);
  assert.deepEqual(await workspaceDbA.listNotes({ taskId: opened.id }), []);

  // maxOpenWorkspaces=1 evicts B's worker. A retained B handle must reopen safely.
  const reopenedTask = await workspaceDbB.getTask(opened.id);
  assert.equal(reopenedTask.status, "closed");
  assert.equal(reopenedTask.workspaceId, registeredB.workspace.id);

  // Concurrent LRU pressure may temporarily overlap workers, but must not close
  // a handle while one of its queries is still in flight.
  const lruStress = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    if (index % 2 === 0) return workspaceDbA.listTasks();
    return workspaceDbB.getTask(opened.id);
  }));
  assert.equal(lruStress.length, 20);

  // Clean close refreshes verified SQLite backups. If the main registry and a
  // workspace database are later corrupted, startup quarantines both damaged
  // files and restores the last clean snapshots instead of silently creating
  // empty task state or leaving the runtime permanently unavailable.
  const runtimeDataDir = path.join(context.dataDir, "runtime");
  const registryPath = path.join(runtimeDataDir, "registry.sqlite");
  const workspaceStatePath = path.join(
    runtimeDataDir,
    "workspaces",
    registeredB.workspace.id,
    "state.sqlite"
  );
  await registry.close();
  registry = null;
  await Promise.all([
    writeFile(registryPath, "corrupt registry database", "utf8"),
    writeFile(workspaceStatePath, "corrupt workspace database", "utf8")
  ]);
  registry = await WorkspaceRegistry.open({
    dataDir: runtimeDataDir,
    maxOpenWorkspaces: 1
  });
  assert.ok((await registry.listWorkspaces()).some((workspace) =>
    workspace.id === registeredB.workspace.id
  ));
  assert.equal(
    (await registry.getTransactionState("tx_registry_probe"))?.status,
    "complete",
    "the clean registry backup must preserve transaction coordinator state"
  );
  const recoveredWorkspace = await registry.openWorkspace(registeredB.workspace.id);
  assert.equal((await recoveredWorkspace.getTask(opened.id)).status, "closed");
  assert.deepEqual(await recoveredWorkspace.listNotes({ taskId: opened.id }), [savedNote]);
  const registryRecoveryEntries = await readdir(path.join(runtimeDataDir, "recovery"));
  const workspaceRecoveryEntries = await readdir(path.join(path.dirname(workspaceStatePath), "recovery"));
  assert.ok(registryRecoveryEntries.some((entry) => entry.startsWith("registry.sqlite-")));
  assert.ok(workspaceRecoveryEntries.some((entry) => entry.startsWith("state.sqlite-")));

  console.log("[PASS] Runtime worker SQLite storage, workspace registry, task fencing, and attachments");
} finally {
  if (workspaceARenamed) {
    await rename(workspaceAOffline, workspaceA).catch(() => {});
  }
  await registry?.close().catch(() => {});
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  await safeRemove(context.dataDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
