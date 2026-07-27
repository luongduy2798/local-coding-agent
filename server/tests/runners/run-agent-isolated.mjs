// Local Coding Agent isolated agent tool test wrapper
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const RUNNERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PACKAGE_DIR = path.resolve(RUNNERS_DIR, "../..");
const repositoryRoot = path.resolve(SERVER_PACKAGE_DIR, "..");
const context = await createIsolatedTestRoot({
  prefix: "lca-agent-",
  protectedPaths: [repositoryRoot]
});
const runtime = await startTestServer({
  serverPath: path.join(SERVER_PACKAGE_DIR, "server.mjs"),
  workspace: context.fixtureDir,
  dataDir: context.dataDir,
  runId: context.runId,
  mode: "safe",
  policy: "full"
});

let succeeded = false;
try {
  await runNode(path.join(SERVER_PACKAGE_DIR, "tests", "integration", "agent.test.mjs"), {
    TEST_ENDPOINT: `http://127.0.0.1:${runtime.port}/mcp`
  });
  succeeded = true;
} finally {
  await stopTestProcess(runtime.child);
  if (succeeded) {
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
  } else {
    console.log(`Agent test fixture retained for inspection: ${context.testRoot}`);
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
