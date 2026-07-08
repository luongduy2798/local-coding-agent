import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIntegrityEnvelope, IntegrityService } from "../core/integrity-service.mjs";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });

test("stable integrity verifies a signed manifest and detects tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-studio-integrity-"));
  try {
    writeFileSync(join(dir, "app.mjs"), "export const version = 1;\n");
    const envelope = createIntegrityEnvelope({ appDir: dir, version: "v5.0.0", files: ["app.mjs"], privateKeyPem });
    writeFileSync(join(dir, "integrity-manifest.json"), JSON.stringify(envelope));
    const service = new IntegrityService({ appDir: dir, manifest: { version: "v5.0.0", releaseStage: "stable" }, publicKeyPem });
    assert.equal(service.status().verified, true);
    writeFileSync(join(dir, "app.mjs"), "export const version = 2;\n");
    assert.equal(service.status().allowed, false);
    assert.match(service.status().reason, /mismatch/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stable integrity fails closed while Preview can run unsigned", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-studio-integrity-mode-"));
  try {
    writeFileSync(join(dir, "app.mjs"), "ok\n");
    const unsigned = createIntegrityEnvelope({ appDir: dir, version: "v5.0.0", files: ["app.mjs"] });
    writeFileSync(join(dir, "integrity-manifest.json"), JSON.stringify(unsigned));
    const stable = new IntegrityService({ appDir: dir, manifest: { version: "v5.0.0", releaseStage: "stable" } });
    const preview = new IntegrityService({ appDir: dir, manifest: { version: "v5.0.0", releaseStage: "preview" } });
    assert.equal(stable.status().allowed, false);
    assert.equal(preview.status().allowed, true);
    assert.equal(preview.status().verified, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrity manifest rejects path traversal", () => {
  assert.throws(() => createIntegrityEnvelope({ appDir: tmpdir(), version: "v5.0.0", files: ["../outside"] }), /invalid|escape/i);
});
