// Local Coding Agent isolated security test wrapper
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRepositoryIntact,
  createIsolatedTestRoot,
  safeRemove,
  snapshotRepositoryState
} from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const RUNNERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PACKAGE_DIR = path.resolve(RUNNERS_DIR, "../..");
const repositoryRoot = path.resolve(SERVER_PACKAGE_DIR, "..");
const before = await snapshotRepositoryState(repositoryRoot);
const context = await createIsolatedTestRoot({
  prefix: "lca-security-",
  protectedPaths: [repositoryRoot]
});

let failed = false;
try {
  await runPhase({
    name: "runtime security",
    workspace: path.join(context.fixtureDir, "runtime"),
    dataDir: path.join(context.dataDir, "runtime"),
    script: path.join(SERVER_PACKAGE_DIR, "tests", "security", "runtime.test.mjs")
  });
  await runPhase({
    name: "security baseline",
    workspace: path.join(context.fixtureDir, "baseline"),
    dataDir: path.join(context.dataDir, "baseline"),
    script: path.join(SERVER_PACKAGE_DIR, "tests", "security", "baseline.test.mjs")
  });
} catch (error) {
  failed = true;
  console.error(error?.stack || error?.message || error);
} finally {
  await assertRepositoryIntact(repositoryRoot, before);
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
  await safeRemove(context.dataDir, context, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

async function runPhase({ name, workspace, dataDir, script }) {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(dataDir, { recursive: true })
  ]);
  const runtime = await startTestServer({
    serverPath: path.join(SERVER_PACKAGE_DIR, "server.mjs"),
    workspace,
    dataDir,
    runId: context.runId,
    mode: "safe",
    policy: "full"
  });
  console.log(`\n[security] ${name}`);
  try {
    await runNode(script, {
      TEST_ENDPOINT: `http://127.0.0.1:${runtime.port}/mcp`,
      AUDIT_LOG: path.join(dataDir, "runtime", "audit.log"),
      LCA_TEST_ROOT: context.testRoot,
      LCA_TEST_FIXTURE: workspace,
      LCA_TEST_DATA_DIR: dataDir,
      LCA_TEST_RUN_ID: context.runId
    });
  } finally {
    await stopTestProcess(runtime.child);
  }
}

function runNode(script, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: SERVER_PACKAGE_DIR,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} failed with code=${code} signal=${signal || "none"}`));
    });
  });
}
