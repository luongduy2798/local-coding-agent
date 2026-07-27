// Local Coding Agent archived workspace review route tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createChangeJournal } from "../../src/change-journal.mjs";
import { WorkspaceRegistry } from "../../src/workspace/registry.mjs";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const context = await createIsolatedTestRoot({
  prefix: "lca-archived-review-",
  protectedPaths: [path.resolve("..")]
});
const runtimeDir = path.join(context.dataDir, "runtime");
const workspaceA = path.join(context.fixtureDir, "workspace-a");
const workspaceB = path.join(context.fixtureDir, "workspace-b");
let registry;
let runtime;

try {
  await Promise.all([workspaceA, workspaceB].map((root) => mkdir(root, { recursive: true })));
  registry = await WorkspaceRegistry.open({ dataDir: runtimeDir, maxOpenWorkspaces: 1 });
  const registeredA = (await registry.registerWorkspace(workspaceA, {
    metadata: { label: "Archived A", trusted: true, source: "test" }
  })).workspace;
  const registeredB = (await registry.registerWorkspace(workspaceB, {
    metadata: { label: "Active B", trusted: true, source: "test" }
  })).workspace;
  await registry.selectWorkspace(registeredB.id, { scope: "default" });

  const journal = createChangeJournal({
    root: workspaceA,
    workspaceId: registeredA.id,
    dataDir: path.join(runtimeDir, "workspaces", registeredA.id, "changes"),
    validatePath(input = ".") {
      const target = path.resolve(workspaceA, String(input));
      assert.ok(target === workspaceA || target.startsWith(`${workspaceA}${path.sep}`));
      return target;
    }
  });
  await journal.init();
  const mutation = await journal.runMutation({
    source: "apply_patch",
    paths: ["preserved.txt"],
    taskTitle: "Preserved archived history",
    mutate: async () => {
      await writeFile(path.join(workspaceA, "preserved.txt"), "archived history\n", "utf8");
      return { ok: true };
    }
  });
  assert.ok(mutation.change?.id);
  await registry.archiveWorkspace(registeredA.id);
  await registry.close();
  registry = null;

  runtime = await startTestServer({
    workspace: workspaceB,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "full",
    policy: "full",
    env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
  });
  const headers = { "x-lca-instance-nonce": context.runId };

  const archivedResponse = await fetch(
    `http://127.0.0.1:${runtime.port}/changes?workspace_id=${encodeURIComponent(registeredA.id)}`,
    { headers }
  );
  assert.equal(archivedResponse.status, 200);
  const archivedHistory = await archivedResponse.json();
  assert.equal(archivedHistory.workspace_id, registeredA.id);
  assert.equal(archivedHistory.registration_state, "archived");
  assert.equal(archivedHistory.changes.length, 1);
  const reviewChange = archivedHistory.changes[0];
  assert.equal(reviewChange.id, mutation.change.taskId);

  const diffResponse = await fetch(
    `http://127.0.0.1:${runtime.port}/changes/${encodeURIComponent(reviewChange.id)}/diff` +
      `?workspace_id=${encodeURIComponent(registeredA.id)}`,
    { headers }
  );
  assert.equal(diffResponse.status, 200);
  assert.match(JSON.stringify(await diffResponse.json()), /preserved\.txt/);

  const mutationResponse = await fetch(
    `http://127.0.0.1:${runtime.port}/changes/${encodeURIComponent(reviewChange.id)}/undo` +
      `?workspace_id=${encodeURIComponent(registeredA.id)}&task_id=${encodeURIComponent(reviewChange.id)}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}"
    }
  );
  assert.equal(mutationResponse.status, 409);
  assert.equal((await mutationResponse.json()).code, "WORKSPACE_ARCHIVED");

  const aggregateResponse = await fetch(
    `http://127.0.0.1:${runtime.port}/changes?workspace_id=all`,
    { headers }
  );
  assert.equal(aggregateResponse.status, 200);
  const aggregate = await aggregateResponse.json();
  assert.equal(aggregate.workspaces.some((workspace) => workspace.workspace_id === registeredA.id), false);
  assert.equal(aggregate.workspaces.some((workspace) => workspace.workspace_id === registeredB.id), true);

  const detailsResponse = await fetch(`http://127.0.0.1:${runtime.port}/healthz/details`, { headers });
  assert.equal(detailsResponse.status, 200);
  const details = await detailsResponse.json();
  assert.ok(details.workspaces.some((workspace) =>
    workspace.workspace_id === registeredA.id && workspace.registration_state === "archived"
  ));

  console.log("[PASS] Archived history remains readable while mutation and aggregate routing exclude it");
} finally {
  await registry?.close().catch(() => {});
  if (runtime) await stopTestProcess(runtime.child);
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  await safeRemove(context.dataDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
