// Local Coding Agent workspace registration lifecycle persistence.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceRegistryError } from "./registry-contract.mjs";

export async function inspectWorkspaceLifecycle(database, workspaceId) {
  const [selections, taskRows, transactionRows] = await Promise.all([
    database.all(
      "SELECT scope, selected_at FROM workspace_selections WHERE workspace_id = ? ORDER BY scope",
      [workspaceId]
    ),
    database.all(
      `
        SELECT
          t.id AS task_id,
          t.title,
          t.status,
          t.updated_at,
          (SELECT COUNT(*) FROM task_router_workspaces all_ws WHERE all_ws.task_id = t.id) AS workspace_count
        FROM task_router_tasks t
        JOIN task_router_workspaces target ON target.task_id = t.id
        WHERE target.workspace_id = ?
        ORDER BY t.created_at, t.id
      `,
      [workspaceId]
    ),
    database.all(
      `
        SELECT * FROM patch_transactions
        WHERE workspace_ids_json LIKE ?
        ORDER BY updated_at, id
      `,
      [`%${workspaceId}%`]
    )
  ]);
  const tasks = taskRows.map((row) => ({
    task_id: row.task_id,
    title: row.title,
    status: row.status,
    updated_at: row.updated_at,
    workspace_count: Number(row.workspace_count || 0)
  }));
  const transactions = transactionRows.filter((row) => {
    try {
      return JSON.parse(row.workspace_ids_json || "[]").includes(workspaceId);
    } catch {
      return true;
    }
  }).map((row) => ({
    id: row.id,
    status: row.status,
    task_id: row.task_id || null,
    manifest_file: row.manifest_file
  }));
  return {
    selections,
    tasks,
    transactions,
    open_tasks: tasks.filter((task) => task.status === "open"),
    multi_workspace_tasks: tasks.filter((task) => task.workspace_count > 1),
    incomplete_transactions: transactions.filter(
      (transaction) => !["complete", "rolled_back"].includes(transaction.status)
    )
  };
}

export async function archiveWorkspaceRecord(database, workspaceId, timestamp) {
  const inspection = await inspectWorkspaceLifecycle(database, workspaceId);
  if (inspection.selections.some((selection) => selection.scope === "default")) {
    throw new WorkspaceRegistryError(
      "WORKSPACE_DEFAULT",
      "Select another default workspace before archiving this workspace.",
      { workspaceId }
    );
  }
  if (inspection.open_tasks.length) {
    throw new WorkspaceRegistryError(
      "WORKSPACE_TASK_OPEN",
      "Close every open task before archiving this workspace.",
      { workspaceId, task_ids: inspection.open_tasks.map((task) => task.task_id) }
    );
  }
  if (inspection.incomplete_transactions.length) {
    throw new WorkspaceRegistryError(
      "WORKSPACE_TRANSACTION_INCOMPLETE",
      "Recover incomplete patch transactions before archiving this workspace.",
      { workspaceId, transaction_ids: inspection.incomplete_transactions.map((item) => item.id) }
    );
  }
  const results = await database.batch([
    {
      mode: "run",
      sql: "DELETE FROM workspace_selections WHERE workspace_id = ?",
      params: [workspaceId]
    },
    {
      mode: "get",
      sql: `
        UPDATE workspaces
        SET registration_state = 'archived', archived_at = ?, updated_at = ?
        WHERE id = ? AND registration_state = 'active'
        RETURNING *
      `,
      params: [timestamp, timestamp, workspaceId]
    }
  ]);
  return { row: results[1], inspection };
}

export async function restoreWorkspaceRecord(database, workspaceId, timestamp) {
  return database.get(
    `
      UPDATE workspaces
      SET registration_state = 'active', archived_at = NULL,
          availability = 'available', updated_at = ?
      WHERE id = ? AND registration_state = 'archived'
      RETURNING *
    `,
    [timestamp, workspaceId]
  );
}

export async function deleteWorkspaceRecords(database, workspaceId, inspection) {
  const taskIds = inspection.tasks.map((task) => task.task_id);
  const transactionIds = inspection.transactions.map((transaction) => transaction.id);
  const steps = [
    ...transactionIds.map((transactionId) => ({
      mode: "run",
      sql: "DELETE FROM patch_transactions WHERE id = ?",
      params: [transactionId]
    })),
    ...taskIds.map((taskId) => ({
      mode: "run",
      sql: "DELETE FROM task_router_tasks WHERE id = ?",
      params: [taskId]
    })),
    {
      mode: "run",
      sql: "DELETE FROM workspace_selections WHERE workspace_id = ?",
      params: [workspaceId]
    },
    {
      mode: "run",
      sql: "DELETE FROM workspaces WHERE id = ?",
      params: [workspaceId]
    }
  ];
  return database.batch(steps);
}
