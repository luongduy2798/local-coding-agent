// Local Coding Agent workspace lifecycle CLI integration tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createIsolatedTestRoot,
  safeRemove
} from "../server/tests/helpers/test-guard.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const cliPath = path.join(scriptDir, "local-coding-agent.mjs");
const context = await createIsolatedTestRoot({
  prefix: "lca-workspace-cli-",
  protectedPaths: [repositoryRoot]
});
const roots = {
  a: path.join(context.fixtureDir, "workspace-a"),
  b: path.join(context.fixtureDir, "workspace-b")
};
const configPath = path.join(context.dataDir, "config", "cli-config.json");

try {
  await Promise.all(Object.values(roots).map(async (root) => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "source.txt"), `${path.basename(root)}\n`, "utf8");
  }));
  await mkdir(path.dirname(configPath), { recursive: true });
  const port = await availablePort();
  await writeFile(configPath, `${JSON.stringify({
    node: process.execPath,
    workspace: roots.b,
    mode: "full",
    policy: "full",
    port: String(port),
    noTunnel: true
  }, null, 2)}\n`, "utf8");

  const env = {
    ...process.env,
    AGENT_DATA_DIR: context.dataDir,
    LCA_CONFIG_PATH: configPath,
    LCA_REPO_ROOT: repositoryRoot,
    LCA_SKIP_MIGRATION_RECOVERY: "1",
    LCA_TEST_RUN_ID: context.runId
  };
  const run = async (...args) => {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: roots.b,
      env,
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    return stdout.trim();
  };
  const runJson = async (...args) => JSON.parse(await run(...args, "--json"));

  const selectedA = await runJson("workspace", "use", roots.a);
  const workspaceAId = selectedA.workspace.id;
  assert.equal(selectedA.default_workspace_id, workspaceAId);
  const selectedB = await runJson("workspace", "use", roots.b);
  assert.notEqual(selectedB.workspace.id, workspaceAId);
  const selectedBById = await runJson("workspace", "use", selectedB.workspace.id);
  assert.equal(selectedBById.workspace.id, selectedB.workspace.id);
  assert.equal(selectedBById.default_workspace_id, selectedB.workspace.id);

  await expectCliFailure(
    () => run("workspace", "archive", roots.b, "--json"),
    /another startup workspace|default workspace/i
  );

  const archived = await runJson("workspace", "archive", workspaceAId);
  assert.equal(archived.workspace.id, workspaceAId);
  assert.equal(archived.workspace.registrationState, "archived");
  const statusWhileArchived = await runJson("status");
  assert.equal(statusWhileArchived.runtime_id, null);
  assert.equal(statusWhileArchived.configured_workspace, roots.b);
  assert.equal(statusWhileArchived.audit.path, path.join(context.dataDir, "runtime", "audit.log"));
  assert.ok(statusWhileArchived.workspaces.some((workspace) =>
    workspace.id === workspaceAId && workspace.registrationState === "archived"
  ));
  assert.deepEqual(statusWhileArchived.active_tasks, []);

  await expectCliFailure(
    () => run("workspace", "use", roots.a, "--json"),
    /archived.*restore/i
  );

  const restored = await runJson("workspace", "restore", workspaceAId);
  assert.equal(restored.workspace.id, workspaceAId);
  assert.equal(restored.workspace.registrationState, "active");
  const runtimeBlocker = await listenOnPort(port);
  try {
    const livePreview = await runJson("workspace", "remove", workspaceAId, "--preview");
    assert.equal(livePreview.summary.workspace_id, workspaceAId);
    await expectCliFailure(
      () => run("workspace", "archive", workspaceAId, "--json"),
      /requires port .* to be free|requires the supervisor/i
    );
    await expectCliFailure(
      () => run(
        "workspace",
        "remove",
        workspaceAId,
        "--force",
        "--confirm-label",
        "workspace-a",
        "--json"
      ),
      /requires port .* to be free|requires the supervisor/i
    );
  } finally {
    await closeServer(runtimeBlocker);
  }
  await runJson("workspace", "archive", workspaceAId);

  const preview = await runJson("workspace", "remove", workspaceAId, "--preview");
  assert.equal(preview.action, "remove_preview");
  assert.equal(preview.summary.workspace_id, workspaceAId);
  assert.equal(preview.summary.label, "workspace-a");
  assert.equal(preview.summary.task_count, 0);
  for (const field of ["data_bytes", "journal_bytes", "blob_bytes", "index_bytes"]) {
    assert.ok(Number.isInteger(preview.summary[field]) && preview.summary[field] >= 0, field);
  }

  await expectCliFailure(
    () => run(
      "workspace",
      "remove",
      workspaceAId,
      "--force",
      "--confirm-label",
      "wrong-label",
      "--json"
    ),
    /confirm-label.*workspace-a/i
  );
  const removed = await runJson(
    "workspace",
    "remove",
    workspaceAId,
    "--force",
    "--confirm-label",
    "workspace-a"
  );
  assert.equal(removed.removed, true);
  assert.equal(removed.workspace_id, workspaceAId);
  assert.equal(await readFile(path.join(roots.a, "source.txt"), "utf8"), "workspace-a\n");

  const reregistered = await runJson("workspace", "use", roots.a);
  assert.notEqual(reregistered.workspace.id, workspaceAId);
  const listed = await runJson("workspace", "list");
  assert.equal(listed.default_workspace_id, reregistered.workspace.id);
  assert.equal(listed.workspaces.some((workspace) => workspace.id === workspaceAId), false);
  assert.equal(listed.workspaces.length, 2);

  console.log("[PASS] CLI archive/restore/permanent remove JSON contract");
} finally {
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  await safeRemove(context.dataDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function expectCliFailure(action, pattern) {
  await assert.rejects(action, (error) => {
    const output = `${error?.stderr || ""}\n${error?.stdout || ""}`;
    assert.match(output, pattern);
    return true;
  });
}

async function availablePort() {
  const server = await listenOnPort(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await closeServer(server);
  assert.ok(port > 0);
  return port;
}

async function listenOnPort(port) {
  const server = createServer();
  await new Promise((resolveReady, rejectReady) => {
    server.once("error", rejectReady);
    server.listen(port, "127.0.0.1", resolveReady);
  });
  return server;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  server.closeAllConnections?.();
  await new Promise((resolveClosed) => setImmediate(resolveClosed));
}
