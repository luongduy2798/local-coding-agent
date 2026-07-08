import { verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class LicenseService {
  constructor({ storageDir, manifest, publicKeyPem = "", now = () => Date.now() }) {
    this.file = join(storageDir, "license.json");
    this.manifest = manifest;
    this.publicKeyPem = publicKeyPem;
    this.now = now;
    this.preview = manifest.releaseStage !== "stable";
    this.runtimeToken = "";
  }

  status() {
    if (this.preview) {
      return {
        allowed: true,
        mode: "experimental",
        edition: "preview",
        reason: "Preview builds do not require a commercial license."
      };
    }
    if (!this.publicKeyPem) {
      return { allowed: false, mode: "enforced", edition: null, reason: "License verification key is not configured." };
    }
    if (!this.runtimeToken && !existsSync(this.file)) {
      return { allowed: false, mode: "enforced", edition: null, reason: "No license has been activated." };
    }
    try {
      const token = this.runtimeToken || JSON.parse(readFileSync(this.file, "utf8")).token;
      const claims = this.verifyToken(token);
      return {
        allowed: true,
        mode: "enforced",
        edition: claims.edition,
        source: this.runtimeToken ? "os-safe-storage" : "legacy-file",
        claims: publicClaims(claims),
        reason: "License is valid."
      };
    } catch (error) {
      return { allowed: false, mode: "enforced", edition: null, reason: error?.message || String(error) };
    }
  }

  activate(token, { persist = true } = {}) {
    if (!this.publicKeyPem) throw new Error("License verification key is not configured.");
    const claims = this.verifyToken(token);
    if (persist) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ token, activatedAt: new Date(this.now()).toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
      try { chmodSync(this.file, 0o600); } catch {}
    } else {
      this.runtimeToken = String(token);
    }
    return {
      allowed: true,
      mode: this.preview ? "experimental" : "enforced",
      edition: claims.edition,
      source: persist ? "legacy-file" : "os-safe-storage",
      claims: publicClaims(claims)
    };
  }

  activateRuntime(token, { removeLegacy = true } = {}) {
    const result = this.activate(token, { persist: false });
    if (removeLegacy && existsSync(this.file)) {
      try { unlinkSync(this.file); } catch {}
    }
    return result;
  }

  clearRuntime({ removeLegacy = false } = {}) {
    this.runtimeToken = "";
    if (removeLegacy && existsSync(this.file)) {
      try { unlinkSync(this.file); } catch {}
    }
    return { ok: true };
  }

  verifyToken(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) throw new Error("Invalid license token format.");
    const payloadBytes = Buffer.from(parts[0], "base64url");
    const signature = Buffer.from(parts[1], "base64url");
    if (!verify(null, payloadBytes, this.publicKeyPem, signature)) throw new Error("License signature is invalid.");
    let claims;
    try { claims = JSON.parse(payloadBytes.toString("utf8")); } catch { throw new Error("License payload is invalid."); }
    if (claims.product !== "local-agent-studio") throw new Error("License is for a different product.");
    if (!claims.licenseId || !claims.customerId || !claims.edition) throw new Error("License claims are incomplete.");
    const now = this.now();
    const notBefore = parseOptionalDate(claims.notBefore, "notBefore");
    const expiresAt = parseOptionalDate(claims.expiresAt, "expiresAt");
    if (notBefore && notBefore > now) throw new Error("License is not active yet.");
    if (expiresAt && expiresAt <= now) throw new Error("License has expired.");
    return claims;
  }
}

function parseOptionalDate(value, name) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`License ${name} is invalid.`);
  return parsed;
}

export function loadLicensePublicKey(appDir) {
  if (process.env.LCA_LICENSE_PUBLIC_KEY_PEM) return process.env.LCA_LICENSE_PUBLIC_KEY_PEM;
  const file = join(appDir, "license-public-key.pem");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function publicClaims(claims) {
  return {
    licenseId: claims.licenseId,
    customerId: claims.customerId,
    edition: claims.edition,
    issuedAt: claims.issuedAt || null,
    expiresAt: claims.expiresAt || null,
    features: Array.isArray(claims.features) ? claims.features : []
  };
}
