// Local Coding Agent runtime isolated scale-fixture builder
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateMonorepo } from "./scale-fixture.mjs";

const markerName = ".lca-test-marker";

try {
  const spec = parseSpec(process.env.LCA_BENCH_FIXTURE_SPEC);
  const root = await validateFixtureTarget(spec);
  const result = await generateMonorepo(root, {
    fileCount: boundedInteger(spec.file_count, 100, 250_000),
    packageCount: boundedInteger(spec.package_count, 2, 64),
    concurrency: boundedInteger(spec.concurrency, 1, 256)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}

function parseSpec(raw) {
  let value;
  try {
    value = JSON.parse(String(raw || ""));
  } catch {
    throw new Error("Scale fixture builder requires a valid LCA_BENCH_FIXTURE_SPEC.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scale fixture builder spec must be an object.");
  }
  return value;
}

async function validateFixtureTarget(spec) {
  const runId = String(spec.run_id || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Scale fixture run ID is invalid.");
  const requestedTestRoot = path.resolve(String(spec.test_root || ""));
  const requestedRoot = path.resolve(String(spec.root || ""));
  const [testRootInfo, rootInfo] = await Promise.all([
    lstat(requestedTestRoot),
    lstat(requestedRoot)
  ]);
  if (!testRootInfo.isDirectory() || testRootInfo.isSymbolicLink()) {
    throw new Error("Scale fixture test root must be a real directory.");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Scale fixture target must be a real directory.");
  }
  const [testRoot, root, tempRoot] = await Promise.all([
    realpath(requestedTestRoot),
    realpath(requestedRoot),
    realpath(os.tmpdir())
  ]);
  if (!isWithin(tempRoot, testRoot)) throw new Error("Scale fixture test root must be below the OS temp directory.");
  if (!isWithin(path.join(testRoot, "fixture"), root) || root === path.join(testRoot, "fixture")) {
    throw new Error("Scale fixture target must be a child of the guarded fixture directory.");
  }
  const marker = (await readFile(path.join(testRoot, markerName), "utf8")).trim();
  if (marker !== runId) throw new Error("Scale fixture marker does not match this run.");
  return root;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Scale fixture numeric option is invalid.");
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}
