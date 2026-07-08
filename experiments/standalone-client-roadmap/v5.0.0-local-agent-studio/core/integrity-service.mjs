import { createHash, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export class IntegrityService {
  constructor({ appDir, manifest, publicKeyPem = "", envelopeFile = "integrity-manifest.json" }) {
    this.appDir = resolve(appDir);
    this.manifest = manifest;
    this.publicKeyPem = publicKeyPem;
    this.envelopePath = resolve(this.appDir, envelopeFile);
    this.preview = manifest.releaseStage !== "stable";
  }

  status() {
    if (!existsSync(this.envelopePath)) {
      return this.preview
        ? { allowed: true, verified: false, mode: "preview", reason: "Preview build has no signed integrity manifest." }
        : { allowed: false, verified: false, mode: "enforced", reason: "Signed integrity manifest is missing." };
    }
    try {
      const envelope = JSON.parse(readFileSync(this.envelopePath, "utf8"));
      const payloadBytes = Buffer.from(String(envelope.payload || ""), "base64url");
      const payload = JSON.parse(payloadBytes.toString("utf8"));
      if (payload.product !== "local-agent-studio") throw new Error("Integrity manifest is for a different product.");
      if (payload.version !== this.manifest.version) throw new Error("Integrity manifest version does not match this build.");
      verifyFiles(this.appDir, payload.files);

      if (!envelope.signature || !this.publicKeyPem) {
        if (!this.preview) throw new Error("Stable builds require a release-signed integrity manifest.");
        return { allowed: true, verified: false, mode: "preview", reason: "File hashes match, but the Preview manifest is unsigned.", payload };
      }
      const signature = Buffer.from(envelope.signature, "base64url");
      if (!verify(null, payloadBytes, this.publicKeyPem, signature)) throw new Error("Integrity manifest signature is invalid.");
      return { allowed: true, verified: true, mode: this.preview ? "preview" : "enforced", reason: "Release signature and file hashes are valid.", payload };
    } catch (error) {
      return { allowed: false, verified: false, mode: this.preview ? "preview" : "enforced", reason: error?.message || String(error) };
    }
  }
}

export function createIntegrityEnvelope({ appDir, version, files, privateKeyPem = "" }) {
  const payload = {
    schemaVersion: 1,
    product: "local-agent-studio",
    version,
    createdAt: new Date().toISOString(),
    files: files.map((path) => ({ path: normalizeRelativePath(path), sha256: hashFile(resolveSafe(appDir, path)) }))
      .sort((a, b) => a.path.localeCompare(b.path))
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  return {
    payload: payloadBytes.toString("base64url"),
    signature: privateKeyPem ? sign(null, payloadBytes, privateKeyPem).toString("base64url") : null
  };
}

export function loadReleasePublicKey(appDir) {
  if (process.env.LCA_RELEASE_PUBLIC_KEY_PEM) return process.env.LCA_RELEASE_PUBLIC_KEY_PEM;
  const file = resolve(appDir, "release-public-key.pem");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function verifyFiles(appDir, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Integrity manifest has no files.");
  for (const item of files) {
    if (!item || typeof item.path !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256 || "")) {
      throw new Error("Integrity manifest contains an invalid file entry.");
    }
    const file = resolveSafe(appDir, item.path);
    if (!existsSync(file)) throw new Error(`Integrity file is missing: ${item.path}`);
    if (hashFile(file) !== item.sha256.toLowerCase()) throw new Error(`Integrity mismatch: ${item.path}`);
  }
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function resolveSafe(root, path) {
  if (isAbsolute(path)) throw new Error(`Integrity path must be relative: ${path}`);
  const full = resolve(root, path);
  const rel = relative(resolve(root), full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    if (!rel) return full;
    throw new Error(`Integrity path escapes the application: ${path}`);
  }
  return full;
}

function normalizeRelativePath(path) {
  const normalized = String(path).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || normalized.startsWith("/")) {
    throw new Error(`Invalid integrity path: ${path}`);
  }
  return normalized;
}
