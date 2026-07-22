// Local Coding Agent pinned semantic artifacts
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STRUCTURAL_WORKER_SOURCE = fileURLToPath(
  new URL("./structural-worker.mjs", import.meta.url)
);

export const STRUCTURAL_SEMANTIC_ARTIFACT = Object.freeze({
  schema_version: 1,
  id: "builtin-structural-ast-v1",
  version: "1",
  file: "structural-worker.mjs",
  sha256: "c974eac3d3beb5cfce702718bee2eb87fe8b49fa40d30b7fbee14eb343cc19a0"
});

const MATERIALIZATION_QUEUES = new Map();

/**
 * Materialize the release-pinned parser worker inside the LCA data directory.
 * The bundled source and every cached copy are verified before execution. A
 * regular corrupt copy is replaced; a symlink is rejected instead of followed.
 */
export function prepareStructuralSemanticArtifact({ dataDir } = {}) {
  if (!dataDir) {
    return prepareBundledArtifact();
  }

  const key = path.resolve(String(dataDir));
  const previous = MATERIALIZATION_QUEUES.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => materializeArtifact(key));
  MATERIALIZATION_QUEUES.set(key, current);
  return current.finally(() => {
    if (MATERIALIZATION_QUEUES.get(key) === current) MATERIALIZATION_QUEUES.delete(key);
  });
}

async function prepareBundledArtifact() {
  const source = await verifiedBundledSource();
  return Object.freeze({
    ...STRUCTURAL_SEMANTIC_ARTIFACT,
    origin: "bundled",
    path: STRUCTURAL_WORKER_SOURCE,
    workerUrl: pathToFileURL(STRUCTURAL_WORKER_SOURCE),
    bytes: source.byteLength
  });
}

async function materializeArtifact(requestedRoot) {
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(requestedRoot);
  const artifactDirectory = path.join(
    canonicalRoot,
    "semantic-artifacts",
    STRUCTURAL_SEMANTIC_ARTIFACT.id
  );
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const canonicalArtifactDirectory = await realpath(artifactDirectory);
  if (!isInside(canonicalRoot, canonicalArtifactDirectory)) {
    throw artifactError(
      "SEMANTIC_ARTIFACT_ROOT_ESCAPE",
      "Semantic artifact directory resolves outside the configured LCA data directory."
    );
  }

  const source = await verifiedBundledSource();
  const target = path.join(canonicalArtifactDirectory, STRUCTURAL_SEMANTIC_ARTIFACT.file);
  const existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw artifactError(
      "SEMANTIC_ARTIFACT_SYMLINK_REJECTED",
      "Pinned semantic artifact must not be a symbolic link."
    );
  }
  if (existing?.isFile()) {
    const cached = await readFile(target);
    if (sha256(cached) === STRUCTURAL_SEMANTIC_ARTIFACT.sha256) {
      await writeManifest(canonicalArtifactDirectory);
      return artifactResult(target, cached.byteLength);
    }
  } else if (existing) {
    throw artifactError(
      "SEMANTIC_ARTIFACT_PATH_INVALID",
      "Pinned semantic artifact path is not a regular file."
    );
  }

  const temporary = path.join(
    canonicalArtifactDirectory,
    `.${STRUCTURAL_SEMANTIC_ARTIFACT.file}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
    if (sha256(await readFile(temporary)) !== STRUCTURAL_SEMANTIC_ARTIFACT.sha256) {
      throw artifactError(
        "SEMANTIC_ARTIFACT_WRITE_CORRUPT",
        "Pinned semantic artifact failed verification after materialization."
      );
    }
    if (existing) await rm(target, { force: true });
    await renameVerified(temporary, target, STRUCTURAL_SEMANTIC_ARTIFACT.sha256);
    await chmod(target, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  await writeManifest(canonicalArtifactDirectory);
  return artifactResult(target, source.byteLength);
}

async function verifiedBundledSource() {
  const source = await readFile(STRUCTURAL_WORKER_SOURCE);
  if (sha256(source) !== STRUCTURAL_SEMANTIC_ARTIFACT.sha256) {
    throw artifactError(
      "SEMANTIC_ARTIFACT_BUNDLE_MISMATCH",
      "Bundled semantic artifact does not match its release-pinned checksum."
    );
  }
  return source;
}

async function writeManifest(directory) {
  const target = path.join(directory, "manifest.json");
  const body = `${JSON.stringify(STRUCTURAL_SEMANTIC_ARTIFACT, null, 2)}\n`;
  const existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw artifactError(
      "SEMANTIC_ARTIFACT_MANIFEST_SYMLINK_REJECTED",
      "Semantic artifact manifest must not be a symbolic link."
    );
  }
  if (existing?.isFile() && await readFile(target, "utf8") === body) return;
  if (existing && !existing.isFile()) {
    throw artifactError(
      "SEMANTIC_ARTIFACT_MANIFEST_PATH_INVALID",
      "Semantic artifact manifest path is not a regular file."
    );
  }
  const temporary = path.join(directory, `.manifest.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
    if (existing) await rm(target, { force: true });
    await renameTextVerified(temporary, target, body);
    await chmod(target, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function renameVerified(temporary, target, checksum) {
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    const concurrent = await readFile(target).catch(() => null);
    if (!concurrent || sha256(concurrent) !== checksum) throw error;
  }
}

async function renameTextVerified(temporary, target, expected) {
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    if (await readFile(target, "utf8").catch(() => null) !== expected) throw error;
  }
}

function artifactResult(target, bytes) {
  return Object.freeze({
    ...STRUCTURAL_SEMANTIC_ARTIFACT,
    origin: "data_dir",
    path: target,
    workerUrl: pathToFileURL(target),
    bytes
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function artifactError(code, message) {
  const error = new Error(message);
  error.name = "SemanticArtifactError";
  error.code = code;
  return error;
}
