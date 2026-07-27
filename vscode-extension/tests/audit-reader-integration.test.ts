import assert from "node:assert/strict";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createIsolatedTestRoot, safeRemove } from "../../server/tests/helpers/test-guard.mjs";
import { AuditReader } from "../src/activity/audit-reader.js";

export default run();

async function run(): Promise<void> {
  const context = await createIsolatedTestRoot({
    prefix: "lca-extension-audit-",
    protectedPaths: [path.resolve("..")],
  });
  const auditPath = path.join(context.dataDir, "runtime", "audit.log");
  const reader = new AuditReader();
  try {
    await mkdir(path.dirname(auditPath), { recursive: true });
    const started = {
      ts: "2026-07-22T02:00:00.000Z",
      kind: "tool",
      phase: "started",
      invocation_id: "invocation-partial",
      runtime_id: "runtime-partial",
      tool: "code_query",
      task_id: "task_partial12345678",
      workspace_ids: ["ws_partial12345678"],
    };
    const startedLine = JSON.stringify(started);
    const split = Math.floor(startedLine.length / 2);
    await writeFile(auditPath, startedLine.slice(0, split), "utf8");
    await reader.configure(auditPath, true);
    assert.equal(reader.current.activities.length, 0, "a partial JSONL record must not be projected");

    await appendFile(auditPath, `${startedLine.slice(split)}\n`, "utf8");
    await reader.refresh();
    assert.equal(reader.current.activities.length, 1);
    assert.equal(reader.current.activities[0].status, "started");

    await rename(auditPath, `${auditPath}.1`);
    await writeFile(auditPath, `${startedLine}\n${JSON.stringify({
      ...started,
      ts: "2026-07-22T02:00:01.000Z",
      phase: "finished",
      duration_ms: 1000,
      ok: true,
      args: { secret: "must-not-escape" },
      output: "must-not-escape",
    })}\n`, "utf8");
    await reader.refresh();
    assert.equal(reader.current.activities.length, 1, "rotation replay must deduplicate invocation phases");
    assert.equal(reader.current.activities[0].status, "finished");
    assert.equal(reader.current.activities[0].durationMs, 1000);
    assert.equal(JSON.stringify(reader.current).includes("must-not-escape"), false);
    console.log("[PASS] Audit reader handles partial lines, rotation, deduplication and secret exclusion");
  } finally {
    reader.dispose();
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
}
