// Local Coding Agent rotating audit durability tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createAuditLog } from "../../src/shared/audit.mjs";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";

const context = await createIsolatedTestRoot({
  prefix: "lca-audit-rotation-",
  protectedPaths: [path.resolve("..")]
});
const auditDir = path.join(context.dataDir, "audit");
const auditPath = path.join(auditDir, "audit.log");

try {
  await mkdir(auditDir, { recursive: true });
  let tick = 0;
  const log = createAuditLog({
    auditPath,
    enabled: true,
    rotateBytes: 420,
    rotateFiles: 3,
    now: () => `2026-07-22T01:00:${String(tick++).padStart(2, "0")}.000Z`
  });
  await log.init();
  for (let sequence = 0; sequence < 40; sequence++) {
    log.audit({
      ts: `2026-07-22T01:00:${String(sequence).padStart(2, "0")}.000Z`,
      kind: "tool",
      phase: sequence % 2 ? "finished" : "started",
      invocation_id: `invocation-${Math.floor(sequence / 2)}`,
      runtime_id: "runtime-rotation",
      tool: "read_file",
      sequence
    });
  }
  await log.close();

  const names = (await readdir(auditDir)).filter((name) => name.startsWith("audit.log"));
  assert.ok(names.includes("audit.log"));
  assert.ok(names.some((name) => /^audit\.log\.\d+$/.test(name)), "audit must rotate");
  assert.ok(names.length <= 4, `unexpected retained audit files: ${names.join(", ")}`);
  const rows = [];
  for (const name of names) {
    const text = await readFile(path.join(auditDir, name), "utf8");
    for (const line of text.split("\n").filter(Boolean)) rows.push(JSON.parse(line));
  }
  assert.ok(rows.some((row) => row.sequence === 39), "the newest event must survive rotation");
  assert.ok(rows.every((row) => row.args === undefined && row.output === undefined));
  assert.equal(log.status().path, auditPath);
  assert.equal(log.status().enabled, true);
  console.log("[PASS] Audit rotation retains valid metadata-only JSONL records");
} finally {
  await safeRemove(context.dataDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
