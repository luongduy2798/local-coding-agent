// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  PATCH_MANIFEST_VERSION,
  PatchTransactionError
} from "./patch-contract.mjs";
import {
  acquireLease,
  atomicJsonWrite,
  boundedInteger,
  comparePath,
  createMissingParents,
  inspectParentState,
  isoNow,
  normalizeRelative,
  operationResult,
  pathExists,
  readJson,
  registerOccupiedPath,
  removeCreatedParents,
  renewLease,
  resolveInside,
  serializableSnapshot,
  sha256,
  snapshotPath,
  validateRecoveryManifest,
  validateTransactionId
} from "./patch-filesystem.mjs";

export { PatchTransactionError } from "./patch-contract.mjs";

export class PatchTransactionCoordinator {
  constructor({
    dataDir,
    resolveWorkspace,
    authorizeWorkspace = null,
    stateStore = null,
    leaseMs = DEFAULT_LEASE_MS,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    faultInjector = null
  } = {}) {
    if (!dataDir) throw new TypeError("dataDir is required");
    if (typeof resolveWorkspace !== "function") throw new TypeError("resolveWorkspace is required");
    if (authorizeWorkspace !== null && typeof authorizeWorkspace !== "function") {
      throw new TypeError("authorizeWorkspace must be a function");
    }
    if (
      stateStore !== null &&
      (
        typeof stateStore !== "object" ||
        typeof stateStore.upsert !== "function" ||
        typeof stateStore.listIncomplete !== "function"
      )
    ) {
      throw new TypeError("stateStore must provide upsert and listIncomplete functions");
    }
    this.dataDir = path.resolve(dataDir);
    this.transactionDir = path.join(this.dataDir, "transactions");
    this.lockDir = path.join(this.dataDir, "locks");
    this.resolveWorkspace = resolveWorkspace;
    this.authorizeWorkspace = authorizeWorkspace;
    this.stateStore = stateStore;
    this.leaseMs = boundedInteger(leaseMs, DEFAULT_LEASE_MS, 5_000, 5 * 60_000);
    this.lockTimeoutMs = boundedInteger(lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 100, 60_000);
    this.faultInjector = typeof faultInjector === "function" ? faultInjector : null;
    this.blockedWorkspaces = new Set();
    this.globalRecoveryBlock = null;
  }

  async init() {
    await Promise.all([
      mkdir(this.transactionDir, { recursive: true }),
      mkdir(this.lockDir, { recursive: true })
    ]);
    return this.recover();
  }

  status() {
    return {
      blocked_workspaces: [...this.blockedWorkspaces].sort(),
      recovery_block: this.globalRecoveryBlock,
      in_doubt: this.blockedWorkspaces.size > 0 || Boolean(this.globalRecoveryBlock)
    };
  }

  async preview({
    operations,
    taskId = null,
    taskToken = null,
    sessionId = null,
    transactionId = null
  } = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new PatchTransactionError("INVALID_PATCH", "operations must be a non-empty array");
    }
    const id = transactionId
      ? validateTransactionId(transactionId)
      : `preview_${randomUUID().replaceAll("-", "")}`;
    const prepared = await this.prepareOperations(id, operations, {
      taskId,
      taskToken,
      sessionId
    });
    await this.revalidatePreparedOperations(prepared);
    return {
      ok: true,
      status: "validated",
      transaction_id: null,
      task_id: taskId,
      workspaces: [...new Set(prepared.map((item) => item.workspace_id))].sort(),
      results: prepared.map((item) => ({
        workspace_id: item.workspace_id,
        op: item.op,
        path: item.path,
        ...(item.rename_to ? { rename_to: item.rename_to } : {}),
        before: {
          exists: item.before.exists,
          type: item.before.type,
          version: item.before.version
        },
        after: {
          exists: item.op !== "delete",
          type: item.op === "mkdir"
            ? "directory"
            : item.op === "delete" ? "missing" : item.before.type === "directory" ? "directory" : "file",
          version: item.op === "delete" ? "missing" : item.next_version || item.before.version
        },
        ok: true
      }))
    };
  }

  async apply({
    operations,
    taskId = null,
    taskToken = null,
    sessionId = null,
    transactionId = null
  } = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new PatchTransactionError("INVALID_PATCH", "operations must be a non-empty array");
    }
    if (this.globalRecoveryBlock) {
      throw new PatchTransactionError(
        "TRANSACTION_COORDINATOR_IN_DOUBT",
        "Mutation is blocked because transaction recovery metadata is unreadable.",
        this.globalRecoveryBlock
      );
    }
    const id = transactionId ? validateTransactionId(transactionId) : randomUUID();
    const prepared = await this.prepareOperations(id, operations, {
      taskId,
      taskToken,
      sessionId
    });
    const workspaceIds = [...new Set(prepared.map((item) => item.workspace_id))].sort();
    const blocked = workspaceIds.filter((workspaceId) => this.blockedWorkspaces.has(workspaceId));
    if (blocked.length) {
      throw new PatchTransactionError(
        "TRANSACTION_IN_DOUBT",
        "Mutation is blocked until an in-doubt transaction is recovered.",
        { workspace_ids: blocked }
      );
    }
    const locks = await this.acquireLocks(workspaceIds, id);
    await this.revalidatePreparedOperations(prepared);
    const manifest = {
      manifest_version: PATCH_MANIFEST_VERSION,
      id,
      task_id: taskId,
      task_token_hash: taskToken ? sha256(Buffer.from(String(taskToken))) : null,
      status: "preparing",
      created_at: isoNow(),
      updated_at: isoNow(),
      workspace_ids: workspaceIds,
      fencing_tokens: Object.fromEntries(
        locks.map((lock) => [lock.workspaceId, lock.fencingToken])
      ),
      operations: prepared
    };
    const manifestPath = this.manifestPath(id);
    try {
      await this.persistManifest(manifestPath, manifest);
      await this.inject("after_manifest", manifest);
      await this.stage(manifest, manifestPath);
      await this.revalidatePreparedOperations(manifest.operations);
      manifest.status = "committing";
      await this.persistManifest(manifestPath, manifest);
      await this.inject("before_commit", manifest);
      for (let index = 0; index < manifest.operations.length; index++) {
        await Promise.all(locks.map((lock) => lock.assertOwned()));
        await this.assertOperationPrecondition(manifest.operations[index]);
        await this.commitOperation(manifest.operations[index]);
        manifest.operations[index].committed = true;
        manifest.updated_at = isoNow();
        await this.persistManifest(manifestPath, manifest);
        await this.inject("after_commit_operation", { manifest, index });
      }
      manifest.status = "committed";
      manifest.committed_at = isoNow();
      manifest.updated_at = manifest.committed_at;
      await this.persistManifest(manifestPath, manifest);
      await this.inject("after_commit", manifest);
      await this.cleanupArtifacts(manifest);
      manifest.status = "complete";
      manifest.completed_at = isoNow();
      manifest.updated_at = manifest.completed_at;
      await this.persistManifest(manifestPath, manifest);
      return this.successResult(manifest, { taskId, workspaceIds });
    } catch (error) {
      manifest.error = String(error?.message || error);
      const allCommitted =
        manifest.status === "committed" ||
        manifest.status === "complete" ||
        manifest.operations.every((operation) => operation.committed === true);
      if (allCommitted) {
        manifest.status = "committed";
        manifest.updated_at = isoNow();
        try {
          // Never remove rollback artifacts until the all-after decision is
          // durably visible. Recovery may otherwise read "committing" and
          // attempt an impossible rollback after backups were deleted.
          await this.persistManifest(manifestPath, manifest);
        } catch (commitPersistenceError) {
          for (const workspaceId of workspaceIds) this.blockedWorkspaces.add(workspaceId);
          throw new PatchTransactionError(
            "TRANSACTION_IN_DOUBT",
            "Patch reached all-after state but commit intent could not be persisted.",
            {
              transaction_id: id,
              cause: manifest.error,
              persistence_error: String(commitPersistenceError?.message || commitPersistenceError)
            }
          );
        }
        try {
          await this.cleanupArtifacts(manifest);
          manifest.status = "complete";
          manifest.completed_at = isoNow();
          manifest.updated_at = manifest.completed_at;
          manifest.recovered_after_commit_error = true;
          await this.persistManifest(manifestPath, manifest);
          return this.successResult(manifest, {
            taskId,
            workspaceIds,
            warning: "Transaction committed fully; a post-commit error was recovered."
          });
        } catch (recoveryError) {
          for (const workspaceId of workspaceIds) this.blockedWorkspaces.add(workspaceId);
          throw new PatchTransactionError(
            "TRANSACTION_IN_DOUBT",
            "Patch committed fully but post-commit cleanup could not be verified.",
            {
              transaction_id: id,
              cause: manifest.error,
              recovery_error: String(recoveryError?.message || recoveryError)
            }
          );
        }
      }
      manifest.status = "in_doubt";
      manifest.updated_at = isoNow();
      await this.persistManifest(manifestPath, manifest).catch(() => {});
      let recoveryError = null;
      try {
        await this.rollback(manifest, manifestPath);
      } catch (rollbackError) {
        recoveryError = rollbackError;
      }
      if (recoveryError) {
        for (const workspaceId of workspaceIds) this.blockedWorkspaces.add(workspaceId);
        throw new PatchTransactionError("TRANSACTION_IN_DOUBT", "Patch failed and automatic recovery was incomplete", {
          transaction_id: id,
          cause: manifest.error,
          recovery_error: String(recoveryError?.message || recoveryError)
        });
      }
      throw new PatchTransactionError("PATCH_ABORTED", "Patch failed; all committed filesystem changes were rolled back", {
        transaction_id: id,
        cause: manifest.error
      });
    } finally {
      await Promise.allSettled(locks.map((lock) => lock.release()));
    }
  }

  async revalidatePreparedOperations(operations) {
    for (const item of operations) await this.assertOperationPrecondition(item);
  }

  async assertOperationPrecondition(item) {
    // Re-canonicalize immediately before every commit step. This catches a
    // parent symlink/junction that was swapped after preflight instead of
    // trusting the lexical target captured earlier.
    await resolveInside(item.workspace_root, item.path);
    const current = await snapshotPath(item.target);
    if (current.version !== item.before.version) {
      throw new PatchTransactionError("STALE_FILE", `Path changed during transaction preflight: ${item.path}`, {
        workspace_id: item.workspace_id,
        path: item.path,
        expected_version: item.before.version,
        actual_version: current.version
      });
    }
    if (item.op === "rename") {
      await resolveInside(item.workspace_root, item.rename_to);
      const destination = await snapshotPath(item.destination);
      if (destination.exists) {
        throw new PatchTransactionError("TARGET_EXISTS", `Rename destination changed during transaction preflight: ${item.rename_to}`, {
          workspace_id: item.workspace_id,
          path: item.rename_to,
          actual_version: destination.version
        });
      }
    }
  }

  async successResult(manifest, { taskId, workspaceIds, warning } = {}) {
    return {
      ok: true,
      transaction_id: manifest.id,
      status: manifest.status,
      task_id: taskId,
      workspaces: workspaceIds,
      ...(warning ? { warning } : {}),
      results: await Promise.all(manifest.operations.map((item) => operationResult(item)))
    };
  }

  async recover() {
    const files = await readdir(this.transactionDir).catch(() => []);
    const recovered = [];
    const failed = [];
    this.globalRecoveryBlock = null;
    let indexedIncomplete = [];
    if (this.stateStore) {
      try {
        indexedIncomplete = await this.stateStore.listIncomplete();
        if (!Array.isArray(indexedIncomplete)) {
          throw new TypeError("transaction state store returned a non-array result");
        }
      } catch (error) {
        this.globalRecoveryBlock = {
          code: "TRANSACTION_STATE_STORE_UNAVAILABLE",
          guidance: "Restore registry.sqlite availability, then restart LCA to rerun transaction recovery."
        };
        return {
          recovered,
          failed: [{ error: `transaction state store unavailable: ${error?.message || error}` }]
        };
      }
    }
    const manifestFiles = new Set(files.filter((name) => name.endsWith(".json")));
    for (const record of indexedIncomplete) {
      const expectedFile = `${record?.id || ""}.json`;
      if (record?.manifest_file !== expectedFile || !manifestFiles.has(expectedFile)) {
        const workspaceIds = Array.isArray(record?.workspace_ids)
          ? record.workspace_ids.filter(Boolean)
          : [];
        for (const workspaceId of workspaceIds) this.blockedWorkspaces.add(workspaceId);
        this.globalRecoveryBlock ||= {
          code: "TRANSACTION_MANIFEST_MISSING",
          transaction_id: record?.id || null,
          guidance: "Restore the missing transaction manifest, then restart LCA to rerun recovery."
        };
        failed.push({
          id: record?.id || null,
          error: "transaction registry entry has no matching durable manifest"
        });
      }
    }
    for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
      const manifestPath = path.join(this.transactionDir, file);
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        validateRecoveryManifest(manifest, file);
      } catch (error) {
        failed.push({ file, error: `invalid manifest: ${error?.message || error}` });
        this.globalRecoveryBlock ||= {
          code: "TRANSACTION_MANIFEST_INVALID",
          file,
          guidance: "Restore or quarantine the damaged transaction manifest, then restart LCA to rerun recovery."
        };
        continue;
      }
      if (manifest.status === "complete" || manifest.status === "rolled_back") {
        try {
          await this.persistState(manifestPath, manifest);
        } catch (error) {
          this.globalRecoveryBlock ||= {
            code: "TRANSACTION_STATE_STORE_UNAVAILABLE",
            guidance: "Restore registry.sqlite availability, then restart LCA to rerun transaction recovery."
          };
          failed.push({ id: manifest.id, error: String(error?.message || error) });
        }
        continue;
      }
      let locks = [];
      try {
        locks = await this.acquireLocks(manifest.workspace_ids || [], `recovery-${manifest.id}`);
        if (manifest.status === "committed") {
          await this.cleanupArtifacts(manifest);
          manifest.status = "complete";
          manifest.completed_at = isoNow();
        } else {
          await this.rollback(manifest, manifestPath);
        }
        manifest.updated_at = isoNow();
        await this.persistManifest(manifestPath, manifest);
        for (const workspaceId of manifest.workspace_ids || []) {
          this.blockedWorkspaces.delete(workspaceId);
        }
        recovered.push(manifest.id);
      } catch (error) {
        const workspaceIds = Array.isArray(manifest.workspace_ids)
          ? manifest.workspace_ids.filter(Boolean)
          : [];
        for (const workspaceId of workspaceIds) {
          this.blockedWorkspaces.add(workspaceId);
        }
        if (!workspaceIds.length) {
          this.globalRecoveryBlock ||= {
            code: "TRANSACTION_RECOVERY_SCOPE_UNKNOWN",
            file,
            guidance: "Repair the transaction manifest before allowing new mutations."
          };
        }
        failed.push({ id: manifest.id, error: String(error?.message || error) });
      } finally {
        await Promise.allSettled(locks.map((lock) => lock.release()));
      }
    }
    return { recovered, failed };
  }

  async prepareOperations(
    transactionId,
    operations,
    { taskId = null, taskToken = null, sessionId = null } = {}
  ) {
    const prepared = [];
    const occupied = [];
    const authorized = new Set();
    for (let index = 0; index < operations.length; index++) {
      const input = operations[index] || {};
      const workspaceId = String(input.workspace_id || "").trim();
      if (!workspaceId) throw new PatchTransactionError("WORKSPACE_REQUIRED", `operations[${index}].workspace_id is required`);
      if (this.authorizeWorkspace && !authorized.has(workspaceId)) {
        await this.authorizeWorkspace({
          workspaceId,
          taskId,
          taskToken,
          sessionId,
          operationIndex: index
        });
        authorized.add(workspaceId);
      }
      const workspace = await this.resolveWorkspace(workspaceId);
      if (!workspace?.root) throw new PatchTransactionError("WORKSPACE_UNAVAILABLE", `Workspace is unavailable: ${workspaceId}`);
      const root = await realpath(path.resolve(workspace.root)).catch(() => null);
      if (!root) throw new PatchTransactionError("WORKSPACE_UNAVAILABLE", `Workspace root is unavailable: ${workspaceId}`);
      const operation = String(input.op || "");
      if (!["create", "update", "delete", "rename", "mkdir"].includes(operation)) {
        throw new PatchTransactionError("INVALID_PATCH", `Unsupported operation: ${operation}`);
      }
      const target = await resolveInside(root, input.path);
      const targetKey = comparePath(target);
      registerOccupiedPath(occupied, targetKey, input.path);
      const before = await snapshotPath(target);
      if (input.expected_version && input.expected_version !== before.version) {
        throw new PatchTransactionError("STALE_FILE", `Version mismatch for ${input.path}`, {
          workspace_id: workspaceId,
          path: normalizeRelative(input.path),
          expected_version: input.expected_version,
          actual_version: before.version
        });
      }
      const item = {
        index,
        workspace_id: workspaceId,
        workspace_root: root,
        op: operation,
        path: normalizeRelative(input.path),
        target,
        before: serializableSnapshot(before),
        expected_version: input.expected_version || null,
        stage_path: null,
        backup_path: null,
        destination: null,
        rename_to: null,
        missing_parents: [],
        created_parents: [],
        committed: false
      };
      if (operation === "create" || operation === "mkdir") {
        if (before.exists) throw new PatchTransactionError("TARGET_EXISTS", `Create target already exists: ${input.path}`);
        const parentState = await inspectParentState(root, target);
        item.missing_parents = parentState.missingParents;
        item.stage_path = path.join(parentState.existingParent, `.lca-tx-${transactionId}-${index}.stage`);
        if (operation === "create") {
          item.next_content = String(input.content ?? "");
          item.next_version = sha256(Buffer.from(item.next_content));
        }
      } else if (operation === "update") {
        if (!before.exists || before.type !== "file" || before.content === null) {
          throw new PatchTransactionError("NOT_EDITABLE", `Update target is not an editable file: ${input.path}`);
        }
        let content = before.content.toString("utf8");
        for (const edit of Array.isArray(input.edits) ? input.edits : []) {
          const oldText = String(edit?.old_text ?? "");
          if (!oldText || !content.includes(oldText)) {
            throw new PatchTransactionError("PATCH_CONFLICT", `old_text not found in ${input.path}`);
          }
          content = edit?.replace_all
            ? content.split(oldText).join(String(edit?.new_text ?? ""))
            : content.replace(oldText, String(edit?.new_text ?? ""));
        }
        if (typeof input.content === "string") content = input.content;
        item.next_content = content;
        item.next_version = sha256(Buffer.from(item.next_content));
        item.mode = before.mode;
      } else if (operation === "delete") {
        if (!before.exists) throw new PatchTransactionError("NOT_FOUND", `Delete target does not exist: ${input.path}`);
        if (before.type === "directory" && input.recursive !== true) {
          throw new PatchTransactionError("RECURSIVE_REQUIRED", `Directory delete requires recursive=true: ${input.path}`);
        }
      } else if (operation === "rename") {
        if (!before.exists) throw new PatchTransactionError("NOT_FOUND", `Rename source does not exist: ${input.path}`);
        if (!input.rename_to) throw new PatchTransactionError("INVALID_PATCH", "rename_to is required");
        const destination = await resolveInside(root, input.rename_to);
        const destinationKey = comparePath(destination);
        registerOccupiedPath(occupied, destinationKey, input.rename_to);
        const destinationBefore = await snapshotPath(destination);
        if (destinationBefore.exists) {
          throw new PatchTransactionError("TARGET_EXISTS", `Rename destination already exists: ${input.rename_to}`);
        }
        item.destination = destination;
        item.rename_to = normalizeRelative(input.rename_to);
        const parentState = await inspectParentState(root, destination);
        item.missing_parents = parentState.missingParents;
      }
      const suffix = `${transactionId}-${index}`;
      if (operation === "update") {
        item.stage_path = path.join(path.dirname(target), `.lca-tx-${suffix}.stage`);
      }
      item.backup_path = ["update", "delete"].includes(operation)
        ? path.join(path.dirname(target), `.lca-tx-${suffix}.backup`)
        : null;
      prepared.push(item);
    }
    return prepared;
  }

  async stage(manifest, manifestPath) {
    for (const item of manifest.operations) {
      if (!item.stage_path) continue;
      await this.assertArtifactPath(item, item.stage_path);
      await mkdir(path.dirname(item.stage_path), { recursive: true });
      if (item.op === "mkdir") {
        await mkdir(item.stage_path);
      } else {
        await writeFile(item.stage_path, item.next_content, { encoding: "utf8", flag: "wx" });
        if (item.mode) await chmod(item.stage_path, item.mode);
      }
      // Content is durable in the same-filesystem stage file. Keeping another
      // plaintext copy in the transaction manifest both wastes space and can
      // leak source/secrets into coordinator metadata.
      delete item.next_content;
      item.staged = true;
      manifest.updated_at = isoNow();
      await this.persistManifest(manifestPath, manifest);
      await this.inject("after_stage_operation", { manifest, index: item.index });
    }
    manifest.status = "staged";
    manifest.updated_at = isoNow();
    await this.persistManifest(manifestPath, manifest);
  }

  async commitOperation(item) {
    if (item.op === "create" || item.op === "mkdir") {
      await createMissingParents(item);
      await rename(item.stage_path, item.target);
      if (item.op === "mkdir") {
        item.next_version = (await snapshotPath(item.target)).version;
      }
      return;
    }
    if (item.op === "update") {
      await rename(item.target, item.backup_path);
      try {
        await rename(item.stage_path, item.target);
      } catch (error) {
        await rename(item.backup_path, item.target).catch(() => {});
        throw error;
      }
      return;
    }
    if (item.op === "delete") {
      await rename(item.target, item.backup_path);
      return;
    }
    if (item.op === "rename") {
      await createMissingParents(item);
      await rename(item.target, item.destination);
    }
  }

  async rollback(manifest, manifestPath) {
    await this.assertRollbackPossible(manifest);
    for (const item of [...manifest.operations].reverse()) {
      if (item.op === "create") {
        const current = await snapshotPath(item.target);
        if (current.exists && current.version === item.next_version) {
          await rm(item.target, { recursive: true, force: true });
        }
        await removeCreatedParents(item);
      } else if (item.op === "mkdir") {
        if (await pathExists(item.target)) await rmdir(item.target);
        await removeCreatedParents(item);
      } else if (item.op === "update") {
        if (await pathExists(item.backup_path)) {
          if (await pathExists(item.target)) await rm(item.target, { recursive: true, force: true });
          await rename(item.backup_path, item.target);
        }
      } else if (item.op === "delete") {
        if (await pathExists(item.backup_path) && !await pathExists(item.target)) {
          await rename(item.backup_path, item.target);
        }
      } else if (item.op === "rename") {
        if (await pathExists(item.destination) && !await pathExists(item.target)) {
          await rename(item.destination, item.target);
        }
        await removeCreatedParents(item);
      }
      if (item.stage_path && await pathExists(item.stage_path)) {
        await this.assertArtifactPath(item, item.stage_path);
        await rm(item.stage_path, { recursive: true, force: true });
      }
      item.committed = false;
    }
    manifest.status = "rolled_back";
    manifest.rolled_back_at = isoNow();
    manifest.updated_at = manifest.rolled_back_at;
    await this.persistManifest(manifestPath, manifest);
  }

  async assertRollbackPossible(manifest) {
    for (const item of manifest.operations) {
      await resolveInside(item.workspace_root, item.path);
      if (item.destination) await resolveInside(item.workspace_root, item.rename_to);
      if (item.stage_path) await this.assertArtifactPath(item, item.stage_path);
      if (item.backup_path) await this.assertArtifactPath(item, item.backup_path);
      const current = await snapshotPath(item.target);
      const backupExists = item.backup_path ? await pathExists(item.backup_path) : false;
      if (item.op === "create") {
        const stageExists = item.stage_path ? await pathExists(item.stage_path) : false;
        if (!item.committed && stageExists) continue;
        if (current.exists && current.version !== item.next_version) {
          throw new PatchTransactionError(
            "ROLLBACK_CONFLICT",
            `Create target changed outside the transaction: ${item.path}`,
            { workspace_id: item.workspace_id, path: item.path, actual_version: current.version }
          );
        }
        continue;
      }
      if (item.op === "mkdir") {
        const stageExists = item.stage_path ? await pathExists(item.stage_path) : false;
        if (!item.committed && stageExists && !current.exists) continue;
        if (current.exists) {
          if (current.type !== "directory") {
            throw new PatchTransactionError(
              "ROLLBACK_CONFLICT",
              `Created directory was replaced outside the transaction: ${item.path}`,
              { workspace_id: item.workspace_id, path: item.path, actual_version: current.version }
            );
          }
          const entries = await readdir(item.target);
          if (entries.length) {
            throw new PatchTransactionError(
              "ROLLBACK_CONFLICT",
              `Created directory is no longer empty: ${item.path}`,
              { workspace_id: item.workspace_id, path: item.path, entries: entries.slice(0, 20) }
            );
          }
        }
        continue;
      }
      if (item.op === "update") {
        if (!item.committed && !backupExists) continue;
        if (!backupExists && current.version !== item.before.version) {
          throw new PatchTransactionError(
            "ROLLBACK_ARTIFACT_MISSING",
            `Update backup is missing for ${item.path}`,
            { workspace_id: item.workspace_id, path: item.path, actual_version: current.version }
          );
        }
        continue;
      }
      if (item.op === "delete") {
        if (!item.committed && !backupExists) continue;
        if (!backupExists && current.version !== item.before.version) {
          throw new PatchTransactionError(
            "ROLLBACK_ARTIFACT_MISSING",
            `Delete backup is missing for ${item.path}`,
            { workspace_id: item.workspace_id, path: item.path, actual_version: current.version }
          );
        }
        continue;
      }
      const destination = await snapshotPath(item.destination);
      if (!item.committed && current.exists && !destination.exists) continue;
      const sourceIsBefore = current.version === item.before.version;
      const destinationIsBefore = destination.version === item.before.version;
      if (
        !(sourceIsBefore && !destination.exists) &&
        !(!current.exists && destinationIsBefore)
      ) {
        throw new PatchTransactionError(
          "ROLLBACK_CONFLICT",
          `Rename state cannot be safely restored for ${item.path}`,
          {
            workspace_id: item.workspace_id,
            path: item.path,
            rename_to: item.rename_to,
            source_version: current.version,
            destination_version: destination.version
          }
        );
      }
    }
  }

  async cleanupArtifacts(manifest) {
    for (const item of manifest.operations) {
      for (const artifact of [item.stage_path, item.backup_path]) {
        if (artifact && await pathExists(artifact)) {
          await this.assertArtifactPath(item, artifact);
          await rm(artifact, { recursive: true, force: true });
        }
      }
      delete item.next_content;
    }
  }

  async assertArtifactPath(item, artifact) {
    const relative = path.relative(item.workspace_root, artifact);
    const resolved = await resolveInside(item.workspace_root, relative);
    if (comparePath(resolved) !== comparePath(artifact)) {
      throw new PatchTransactionError(
        "TRANSACTION_ARTIFACT_OUTSIDE_WORKSPACE",
        "Transaction artifact no longer resolves to its prepared path.",
        {
          workspace_id: item.workspace_id,
          path: item.path
        }
      );
    }
  }

  async acquireLocks(workspaceIds, owner) {
    const acquired = [];
    try {
      for (const workspaceId of [...new Set(workspaceIds)].sort()) {
        acquired.push(await acquireLease({
          lockDir: this.lockDir,
          workspaceId,
          owner,
          leaseMs: this.leaseMs,
          timeoutMs: this.lockTimeoutMs
        }));
      }
      return acquired;
    } catch (error) {
      await Promise.allSettled(acquired.map((lock) => lock.release()));
      throw error;
    }
  }

  async persistManifest(manifestPath, manifest) {
    await atomicJsonWrite(manifestPath, manifest, {
      replacer(key, value) {
        return key === "next_content" ? undefined : value;
      }
    });
    await this.persistState(manifestPath, manifest);
  }

  async persistState(manifestPath, manifest) {
    if (!this.stateStore) return;
    await this.stateStore.upsert({
      id: manifest.id,
      status: manifest.status,
      task_id: manifest.task_id || null,
      workspace_ids: [...new Set(manifest.workspace_ids || [])].sort(),
      manifest_version: manifest.manifest_version,
      manifest_file: path.basename(manifestPath),
      created_at: manifest.created_at,
      updated_at: manifest.updated_at,
      completed_at: manifest.completed_at || manifest.rolled_back_at || null,
      error_code: manifest.error_code || null
    });
  }

  manifestPath(id) {
    return path.join(this.transactionDir, `${id}.json`);
  }

  async inject(point, context) {
    if (this.faultInjector) await this.faultInjector(point, context);
  }
}
