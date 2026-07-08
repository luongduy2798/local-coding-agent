import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LicenseService } from "../core/license-service.mjs";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });

function token(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(payload, "base64url"), keys.privateKey).toString("base64url");
  return `${payload}.${signature}`;
}

function claims(overrides = {}) {
  return {
    product: "local-agent-studio",
    licenseId: "lic_test",
    customerId: "customer_test",
    edition: "pro",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    features: ["agent"],
    ...overrides
  };
}

test("preview builds run without a commercial key", () => {
  const service = new LicenseService({ storageDir: tmpdir(), manifest: { releaseStage: "preview" } });
  assert.equal(service.status().allowed, true);
  assert.equal(service.status().mode, "experimental");
});

test("stable builds fail closed and accept only admin-signed licenses", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-studio-license-"));
  const now = () => Date.parse("2026-06-01T00:00:00.000Z");
  try {
    const missingKey = new LicenseService({ storageDir: dir, manifest: { releaseStage: "stable" }, now });
    assert.equal(missingKey.status().allowed, false);

    const service = new LicenseService({ storageDir: dir, manifest: { releaseStage: "stable" }, publicKeyPem, now });
    assert.equal(service.status().allowed, false);
    assert.equal(service.activate(token(claims())).allowed, true);
    assert.equal(service.status().claims.customerId, "customer_test");
    assert.throws(() => service.activate(`${Buffer.from("{}").toString("base64url")}.invalid`), /signature/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired licenses are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-studio-expired-"));
  try {
    const service = new LicenseService({
      storageDir: dir,
      manifest: { releaseStage: "stable" },
      publicKeyPem,
      now: () => Date.parse("2028-01-01T00:00:00.000Z")
    });
    assert.throws(() => service.activate(token(claims())), /expired/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid license dates are rejected instead of bypassing expiry checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-studio-invalid-date-"));
  try {
    const service = new LicenseService({
      storageDir: dir,
      manifest: { releaseStage: "stable" },
      publicKeyPem,
      now: () => Date.parse("2026-06-01T00:00:00.000Z")
    });
    assert.throws(() => service.activate(token(claims({ expiresAt: "not-a-date" }))), /expiresAt is invalid/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop runtime license is verified in memory and removes legacy plaintext storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-studio-runtime-license-"));
  const now = () => Date.parse("2026-06-01T00:00:00.000Z");
  try {
    const service = new LicenseService({ storageDir: dir, manifest: { releaseStage: "stable" }, publicKeyPem, now });
    service.activate(token(claims()));
    assert.equal(existsSync(join(dir, "license.json")), true);
    const runtime = service.activateRuntime(token(claims({ licenseId: "lic_runtime" })));
    assert.equal(runtime.source, "os-safe-storage");
    assert.equal(existsSync(join(dir, "license.json")), false);
    assert.equal(service.status().source, "os-safe-storage");
    assert.equal(service.status().claims.licenseId, "lic_runtime");
    service.clearRuntime({ removeLegacy: true });
    assert.equal(service.status().allowed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
