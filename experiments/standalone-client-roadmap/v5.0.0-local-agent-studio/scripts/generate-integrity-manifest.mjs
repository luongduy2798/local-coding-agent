#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createIntegrityEnvelope } from "../core/integrity-service.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(ROOT, "version-manifest.json"), "utf8"));
const privateKeyPem = loadPrivateKey();
if (manifest.releaseStage === "stable" && !privateKeyPem) {
  throw new Error("Stable builds require LCA_RELEASE_SIGNING_PRIVATE_KEY_FILE. The private key must never be committed or bundled.");
}

const files = [
  "package.json",
  "package-lock.json",
  "server.mjs",
  "standalone-app.mjs",
  "version-manifest.json",
  ...await filesUnder(join(ROOT, "core"))
];
const envelope = createIntegrityEnvelope({ appDir: ROOT, version: manifest.version, files, privateKeyPem });
const output = join(ROOT, "integrity-manifest.json");
writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
console.log(`${privateKeyPem ? "Signed" : "Unsigned Preview"} integrity manifest: ${output}`);
console.log(`Files: ${files.length}`);

function loadPrivateKey() {
  const file = process.env.LCA_RELEASE_SIGNING_PRIVATE_KEY_FILE;
  if (!file) return "";
  if (!existsSync(file)) throw new Error(`Release signing private key file not found: ${file}`);
  return readFileSync(file, "utf8");
}

async function filesUnder(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(full));
    else if (entry.isFile()) output.push(relative(ROOT, full).replaceAll("\\", "/"));
  }
  return output;
}
