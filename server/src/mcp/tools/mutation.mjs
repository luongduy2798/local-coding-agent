// Local Coding Agent MCP mutation tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PatchTransactionError } from "../../mutation/patch-transaction.mjs";
import { TaskRouterError } from "../../workspace/task-router.mjs";

let PRIMARY_ROOT;
let ROOTS;
let TEST_RUNTIME_DIAGNOSTICS;
let comparePath;
let currentMcpSessionId;
let currentTask;
let dedupe;
let getChangeJournal;
let getWorkspaceRuntime;
let jsonResult;
let markUnmanagedChange;
let patchCoordinator;
let primaryWorkspaceId;
let reg;
let resolvePath;
let resolveWorkspacePath;
let selectWorkspace;
let storageError;
let taskRouter;
let toRel;
let toWorkspaceRel;

export function registerMutationTools(mcp, dependencies) {
  ({
    PRIMARY_ROOT,
    ROOTS,
    TEST_RUNTIME_DIAGNOSTICS,
    comparePath,
    currentMcpSessionId,
    currentTask,
    dedupe,
    getChangeJournal,
    getWorkspaceRuntime,
    jsonResult,
    markUnmanagedChange,
    patchCoordinator,
    primaryWorkspaceId,
    reg,
    resolvePath,
    resolveWorkspacePath,
    selectWorkspace,
    storageError,
    taskRouter,
    toRel,
    toWorkspaceRel
  } = dependencies);
  return registerFsWriteTools(mcp);
}

function registerFsWriteTools(mcp) {


  reg(
    mcp,
    "apply_patch",
    {
      title: "Apply patch",
      description: "Preview, validate, or atomically apply a multi-file create/update/delete/rename/mkdir patch with stale-version checks and all-before/all-after recovery.",
      inputSchema: {
        action: z.enum(["apply", "preview", "validate"]).optional(),
        task_title: z.string().min(1).max(180).optional(),
        task_token: z.string().optional(),
        workspace_id: z.string().optional(),
        diff: z.string().optional(),
        operations: z
          .array(
            z.object({
              workspace_id: z.string().optional(),
              op: z.enum(["create", "update", "delete", "rename", "mkdir"]),
              path: z.string().min(1),
              expected_version: z.string().optional(),
              content: z.string().optional(),
              rename_to: z.string().optional(),
              recursive: z.boolean().optional(),
              edits: z
                .array(z.object({ old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }))
                .optional()
            })
          )
          .optional()
      }
    },
    async ({ action = "apply", task_title, task_token, workspace_id, diff, operations }) => {
      if (!patchCoordinator) {
        throw new PatchTransactionError(
          "PATCH_TRANSACTION_UNAVAILABLE",
          `Patch transaction engine is unavailable: ${storageError?.patch_transaction || storageError?.message || "unknown error"}`
        );
      }
      let normalizedOperations = operations;
      if (diff && diff.trim()) {
        const selected = await selectWorkspace({ workspaceId: workspace_id, taskToken: task_token });
        normalizedOperations = await unifiedDiffToOperations(diff, {
          workspace: selected.workspace
        });
      }
      if (!normalizedOperations || !normalizedOperations.length) {
        throw new Error("Provide either `diff` or a non-empty `operations` array.");
      }
      const context = await preparePatchTaskContext({
        operations: normalizedOperations,
        defaultWorkspaceId: workspace_id,
        taskToken: task_token,
        taskTitle: task_title,
        freeze: action === "apply"
      });
      if (action !== "apply") {
        const preview = await patchCoordinator.preview({
          operations: context.operations,
          taskId: context.task?.id || null,
          taskToken: context.taskToken,
          sessionId: currentMcpSessionId()
        });
        return jsonResult({
          ...preview,
          action,
          mode: diff && diff.trim() ? "diff" : "operations",
          operation_count: preview.results.length,
          task: context.task,
          ...(context.returnTaskToken ? { task_token: context.returnTaskToken } : {}),
          mutation_performed: false,
          workspace_set_frozen: context.task?.workspace_set_frozen === true
        });
      }
      const applied = await runPatchTransactionWithJournals({
        operations: context.operations,
        task: context.task,
        taskToken: context.taskToken,
        taskTitle: task_title
      });
      return jsonResult({
        ...applied.transaction,
        routing_task_id: applied.transaction.task_id,
        task_id: TEST_RUNTIME_DIAGNOSTICS && applied.changes.length === 1
          ? applied.changes[0].task_id
          : applied.transaction.task_id,
        journal_task_id: applied.changes.length === 1 ? applied.changes[0].task_id : null,
        mode: diff && diff.trim() ? "diff" : "operations",
        applied: applied.transaction.results.length,
        task: context.task,
        ...(context.returnTaskToken ? { task_token: context.returnTaskToken } : {}),
        changes: applied.changes,
        journal_errors: applied.journalErrors,
        journal_complete: applied.journalErrors.length === 0,
        change_id: applied.changes.length === 1 ? applied.changes[0].change_id : null,
        change_ids: Object.fromEntries(applied.changes.map((entry) => [entry.workspace_id, entry.change_id]))
      });
    }
  );



}

function collectUnifiedDiffPaths(diffText) {
  const affected = new Set();
  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim().replace(/^["']|["']$/g, "");
    if (!raw || raw === "/dev/null") continue;
    affected.add(resolvePath(raw.replace(/^[ab]\//, "")));
  }
  return [...affected];
}

export function findPreparedSnapshot(preparedBefore, filePath) {
  const wanted = comparePath(filePath);
  for (const snapshot of preparedBefore?.values?.() || []) {
    if (snapshot?.absolutePath && comparePath(snapshot.absolutePath) === wanted) return snapshot;
  }
  return null;
}

export async function preparePatchTaskContext({
  operations,
  defaultWorkspaceId,
  taskToken,
  taskTitle,
  freeze = true
}) {
  let task = await currentTask({ taskToken, required: false });
  let returnTaskToken = null;
  let defaultId = defaultWorkspaceId || task?.primary_workspace_id || null;
  if (!defaultId) {
    const selected = await selectWorkspace({ taskToken });
    defaultId = selected.workspace.id;
  }
  const normalized = operations.map((operation) => ({
    ...operation,
    workspace_id: operation.workspace_id || defaultId
  }));
  const workspaceIds = dedupe(normalized.map((operation) => operation.workspace_id));

  if (taskRouter) {
    if (!task) {
      if (workspaceIds.length !== 1) {
        throw new TaskRouterError(
          "TASK_CONTEXT_REQUIRED",
          "Open a task and explicitly attach every workspace before applying a cross-workspace patch.",
          { workspace_ids: workspaceIds }
        );
      }
      const selected = await selectWorkspace({ workspaceId: workspaceIds[0] });
      if (selected.workspace.availability !== "available" || selected.workspace.metadata?.trusted !== true) {
        throw new TaskRouterError(
          "WORKSPACE_NOT_TRUSTED",
          `Workspace must be available and explicitly trusted: ${workspaceIds[0]}`
        );
      }
      const opened = await taskRouter.openTask({
        title: taskTitle || "Apply patch",
        primaryWorkspaceId: workspaceIds[0],
        ownerSessionId: currentMcpSessionId()
      });
      returnTaskToken = opened.task_token;
      taskToken = opened.task_token;
      task = opened;
    }
    for (const workspaceId of workspaceIds) {
      if (!task.workspace_ids.includes(workspaceId)) {
        throw new TaskRouterError(
          "WORKSPACE_NOT_ATTACHED",
          `Workspace ${workspaceId} is not attached to task ${task.id}.`,
          { task_id: task.id, workspace_id: workspaceId, workspace_ids: task.workspace_ids }
        );
      }
      const runtime = await getWorkspaceRuntime(workspaceId);
      if (runtime.workspace.availability !== "available") {
        throw new TaskRouterError("WORKSPACE_UNAVAILABLE", `Workspace is unavailable: ${workspaceId}`);
      }
    }
    if (freeze) {
      task = await taskRouter.freezeWorkspaceSet({
        taskToken,
        sessionId: currentMcpSessionId()
      });
    }
  } else {
    if (workspaceIds.length !== 1 || workspaceIds[0] !== primaryWorkspaceId) {
      throw new TaskRouterError(
        "MULTI_WORKSPACE_UNAVAILABLE",
        `Multi-workspace task storage is unavailable: ${storageError?.message || "unknown error"}`
      );
    }
    task = {
      id: null,
      title: taskTitle || "Apply patch",
      status: "open",
      primary_workspace_id: primaryWorkspaceId,
      workspace_ids: [primaryWorkspaceId],
      workspace_set_frozen: true
    };
  }

  return {
    operations: normalized,
    task,
    taskToken,
    returnTaskToken
  };
}

export async function runPatchTransactionWithJournals({
  operations,
  task,
  taskToken,
  taskTitle
}) {
  const transactionId = randomUUID();
  const grouped = new Map();
  for (const operation of operations) {
    const runtime = await getWorkspaceRuntime(operation.workspace_id);
    let group = grouped.get(operation.workspace_id);
    if (!group) {
      group = {
        workspace: runtime.workspace,
        journal: await getChangeJournal(operation.workspace_id),
        paths: [],
        renameGroups: []
      };
      grouped.set(operation.workspace_id, group);
    }
    const source = await resolveWorkspacePath(operation.path, {
      workspaceId: operation.workspace_id,
      taskToken
    });
    group.paths.push(source.path);
    if (operation.op === "rename" && operation.rename_to) {
      const destination = await resolveWorkspacePath(operation.rename_to, {
        workspaceId: operation.workspace_id,
        taskToken
      });
      group.paths.push(destination.path);
      group.renameGroups.push({
        from: toWorkspaceRel(group.workspace, source.path),
        to: toWorkspaceRel(group.workspace, destination.path)
      });
    }
  }

  const groups = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  const changes = [];
  const journalErrors = [];
  const execute = async (index) => {
    if (index >= groups.length) {
      return patchCoordinator.apply({
        operations,
        taskId: task?.id || null,
        taskToken,
        sessionId: currentMcpSessionId(),
        transactionId
      });
    }
    const [workspaceId, group] = groups[index];
    const outcome = await group.journal.runMutation({
      source: "apply_patch",
      taskTitle: taskTitle || task?.title,
      routingTaskId: task?.id || null,
      transactionId,
      allowCommittedJournalFailure: true,
      paths: dedupe(group.paths),
      renameGroups: group.renameGroups,
      mutate: () => execute(index + 1)
    });
    if (outcome.change) {
      changes.push({
        workspace_id: workspaceId,
        change_id: outcome.change.id,
        task_id: outcome.task?.id || null,
        files: outcome.change.files?.length || 0
      });
    }
    if (outcome.journalError) {
      journalErrors.push({
        workspace_id: workspaceId,
        ...outcome.journalError
      });
      await markUnmanagedChange({
        workspaceId,
        taskId: task?.id || null,
        source: "apply_patch_journal_failure",
        details: outcome.journalError
      });
    }
    return outcome.result;
  };

  const transaction = await execute(0);
  changes.sort((left, right) => left.workspace_id.localeCompare(right.workspace_id));
  journalErrors.sort((left, right) => left.workspace_id.localeCompare(right.workspace_id));
  return { transaction, changes, journalErrors };
}

function parseUnifiedDiffChunks(diffText) {
  const lines = String(diffText || "").split(/\r?\n/);
  const chunks = [];
  let current = null;
  const stripPrefix = (value) => value.replace(/^["']|["']$/g, "").replace(/^[ab]\//, "").trim();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("--- ")) {
      const next = lines[index + 1] || "";
      current = {
        minus: stripPrefix(line.slice(4)),
        plus: next.startsWith("+++ ") ? stripPrefix(next.slice(4)) : "",
        hunks: [],
        hunk: null
      };
      chunks.push(current);
      if (next.startsWith("+++ ")) index++;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      current.hunk = { before: [], after: [] };
      current.hunks.push(current.hunk);
      continue;
    }
    if (!current.hunk) continue;
    const body = line.slice(1);
    if (line[0] === " ") {
      current.hunk.before.push(body);
      current.hunk.after.push(body);
    } else if (line[0] === "-") {
      current.hunk.before.push(body);
    } else if (line[0] === "+") {
      current.hunk.after.push(body);
    }
  }
  if (!chunks.length) throw new Error("No file sections found in diff (need ---/+++ headers).");
  return chunks;
}

async function unifiedDiffToOperations(diffText, { workspace }) {
  const operations = [];
  for (const chunk of parseUnifiedDiffChunks(diffText)) {
    const isCreate = chunk.minus === "/dev/null";
    const isDelete = chunk.plus === "/dev/null";
    const relativePath = isCreate ? chunk.plus : chunk.minus || chunk.plus;
    if (!relativePath || relativePath === "/dev/null") throw new Error("Unified diff contains an invalid file path.");
    if (isDelete) {
      operations.push({ workspace_id: workspace.id, op: "delete", path: relativePath });
      continue;
    }
    if (isCreate) {
      const body = chunk.hunks.flatMap((hunk) => hunk.after).join("\n");
      operations.push({
        workspace_id: workspace.id,
        op: "create",
        path: relativePath,
        content: body.endsWith("\n") ? body : `${body}\n`
      });
      continue;
    }
    const resolved = await resolveWorkspacePath(relativePath, { workspaceId: workspace.id });
    let content = await readFile(resolved.path, "utf8").catch((error) => {
      throw new Error(`File is not editable as text: ${relativePath} (${error?.message || error})`);
    });
    const expectedVersion = createHash("sha256").update(content).digest("hex");
    for (const hunk of chunk.hunks) {
      const before = hunk.before.join("\n");
      const after = hunk.after.join("\n");
      if (before === after) continue;
      if (before && content.includes(before)) {
        content = content.replace(before, after);
      } else if (!before) {
        content += `${content.endsWith("\n") ? "" : "\n"}${after}`;
      } else {
        throw new Error(`Patch prevalidation failed: hunk context not found in ${relativePath}`);
      }
    }
    operations.push({
      workspace_id: workspace.id,
      op: "update",
      path: relativePath,
      content,
      expected_version: expectedVersion
    });
  }
  return operations;
}

// Apply a unified diff by CONTENT matching (ignores the @@ line numbers, which
// models often get wrong). Each hunk's context+removed lines must appear in the
// file; they are replaced by its context+added lines.
async function applyUnifiedDiff(diffText, preparedBefore) {
  const results = [];
  const lines = diffText.split(/\r?\n/);
  const fileChunks = [];
  let current = null;

  const stripPrefix = (p) => p.replace(/^["']|["']$/g, "").replace(/^[ab]\//, "").trim();

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("--- ")) {
      const next = lines[i + 1] || "";
      const minus = stripPrefix(ln.slice(4));
      const plus = next.startsWith("+++ ") ? stripPrefix(next.slice(4)) : "";
      current = { minus, plus, hunks: [], hunk: null };
      fileChunks.push(current);
      if (next.startsWith("+++ ")) i++;
      continue;
    }
    if (!current) continue;
    if (ln.startsWith("@@")) {
      current.hunk = { before: [], after: [] };
      current.hunks.push(current.hunk);
      continue;
    }
    if (!current.hunk) continue;
    const tag = ln[0];
    const body = ln.slice(1);
    if (tag === " ") {
      current.hunk.before.push(body);
      current.hunk.after.push(body);
    } else if (tag === "-") {
      current.hunk.before.push(body);
    } else if (tag === "+") {
      current.hunk.after.push(body);
    } else if (ln === "\\ No newline at end of file") {
      // ignore
    }
  }

  for (const fc of fileChunks) {
    const isNew = fc.minus === "/dev/null";
    const isDelete = fc.plus === "/dev/null";
    const relPath = isNew ? fc.plus : fc.minus || fc.plus;
    try {
      const target = resolvePath(relPath);
      if (isDelete) {
        await rm(target, { force: true });
        results.push({ path: toRel(target), ok: true, action: "delete" });
        continue;
      }
      if (isNew) {
        const content = fc.hunks.flatMap((h) => h.after).join("\n");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content.endsWith("\n") ? content : content + "\n", "utf8");
        results.push({ path: toRel(target), ok: true, action: "create" });
        continue;
      }
      const snapshot = findPreparedSnapshot(preparedBefore, target);
      if (!snapshot?.exists || snapshot.type !== "file" || typeof snapshot.text !== "string") {
        throw new Error(`File is not editable as text: ${toRel(target)}`);
      }
      let content = snapshot.text;
      let applied = 0;
      for (const h of fc.hunks) {
        const before = h.before.join("\n");
        const after = h.after.join("\n");
        if (before === after) continue;
        if (before && content.includes(before)) {
          content = content.replace(before, after);
          applied++;
        } else if (!before) {
          content += (content.endsWith("\n") ? "" : "\n") + after;
          applied++;
        } else {
          throw new Error(`hunk context not found in ${toRel(target)}`);
        }
      }
      await writeFile(target, content, "utf8");
      results.push({ path: toRel(target), ok: true, action: "update", hunks: applied });
    } catch (err) {
      results.push({ path: relPath, ok: false, error: String(err?.message || err) });
      break;
    }
  }
  if (!fileChunks.length) throw new Error("No file sections found in diff (need ---/+++ headers).");
  return results;
}

function validatePatchOperations(operations, preparedBefore) {
  const seen = new Set();
  for (const op of operations) {
    const target = resolvePath(op.path);
    const targetKey = comparePath(target);
    if (seen.has(targetKey)) throw new Error(`Patch contains multiple operations for ${toRel(target)}.`);
    seen.add(targetKey);
    const snapshot = findPreparedSnapshot(preparedBefore, target);
    if (op.op === "create") {
      if (snapshot?.exists) throw new Error(`Create target already exists: ${toRel(target)}`);
      continue;
    }
    if (!snapshot?.exists) throw new Error(`Patch target does not exist: ${toRel(target)}`);
    if (op.op === "update") {
      if (snapshot.type !== "file" || typeof snapshot.text !== "string") {
        throw new Error(`File is not editable as text: ${toRel(target)}`);
      }
      let content = snapshot.text;
      for (const edit of op.edits || []) {
        if (!content.includes(edit.old_text)) throw new Error(`old_text not found in ${toRel(target)}`);
        content = edit.replace_all
          ? content.split(edit.old_text).join(edit.new_text)
          : content.replace(edit.old_text, edit.new_text);
      }
      continue;
    }
    if (op.op === "delete") {
      if (snapshot.type === "directory" && !op.recursive) {
        throw new Error(`Directory delete requires recursive=true: ${toRel(target)}`);
      }
      continue;
    }
    if (op.op === "rename") {
      if (!op.rename_to) throw new Error("rename requires rename_to");
      const destination = resolvePath(op.rename_to);
      const destinationKey = comparePath(destination);
      if (seen.has(destinationKey)) throw new Error(`Patch contains overlapping rename destination ${toRel(destination)}.`);
      seen.add(destinationKey);
      const destinationSnapshot = findPreparedSnapshot(preparedBefore, destination);
      if (destinationSnapshot?.exists) throw new Error(`Destination already exists: ${toRel(destination)}`);
    }
  }
}

async function applyOne(op, preparedBefore) {
  const target = resolvePath(op.path);
  if (op.op === "create") {
    const snapshot = findPreparedSnapshot(preparedBefore, target);
    if (snapshot?.exists) throw new Error(`Create target already exists: ${toRel(target)}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, op.content ?? "", "utf8");
    return { op: "create", path: toRel(target), ok: true, bytes: Buffer.byteLength(op.content ?? "") };
  }
  if (op.op === "update") {
    const snapshot = findPreparedSnapshot(preparedBefore, target);
    if (!snapshot?.exists || snapshot.type !== "file" || typeof snapshot.text !== "string") {
      throw new Error(`File is not editable as text: ${target}`);
    }
    let content = snapshot.text;
    let count = 0;
    for (const edit of op.edits || []) {
      if (!content.includes(edit.old_text)) throw new Error(`old_text not found in ${target}`);
      if (edit.replace_all) {
        count += content.split(edit.old_text).length - 1;
        content = content.split(edit.old_text).join(edit.new_text);
      } else {
        content = content.replace(edit.old_text, edit.new_text);
        count += 1;
      }
    }
    await writeFile(target, content, "utf8");
    return { op: "update", path: toRel(target), ok: true, replacements: count };
  }
  if (op.op === "delete") {
    if (target === PRIMARY_ROOT || ROOTS.includes(target)) throw new Error("Refusing to delete a configured root.");
    await rm(target, { recursive: Boolean(op.recursive), force: false });
    return { op: "delete", path: toRel(target), ok: true };
  }
  if (op.op === "rename") {
    if (!op.rename_to) throw new Error("rename requires rename_to");
    const dst = resolvePath(op.rename_to);
    if (existsSync(dst)) throw new Error(`Destination already exists: ${toRel(dst)}`);
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(target, dst);
    return { op: "rename", path: toRel(target), to: toRel(dst), ok: true };
  }
  throw new Error(`Unknown op: ${op.op}`);
}
