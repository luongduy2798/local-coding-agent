// Local Coding Agent architecture guard.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_DIR = path.resolve(SERVER_DIR, "..");
const SOURCE_DIR = path.join(SERVER_DIR, "src");
const CLI_ENTRY = path.join(REPOSITORY_DIR, "scripts", "local-coding-agent.mjs");
const CLI_DIR = path.join(REPOSITORY_DIR, "scripts", "cli");
const ROOT_LINE_LIMIT = 300;
const MODULE_LINE_LIMIT = 1_000;

const failures = [];
const productionFiles = [
  ...(await collectModules(SOURCE_DIR)),
  ...(await collectModules(CLI_DIR, { optional: true }))
];

await assertLineLimit(path.join(SOURCE_DIR, "server.mjs"), ROOT_LINE_LIMIT, "server bootstrap");
await assertLineLimit(CLI_ENTRY, ROOT_LINE_LIMIT, "CLI entrypoint");
for (const file of productionFiles) await assertLineLimit(file, MODULE_LINE_LIMIT, "production module");

for (const directory of [SOURCE_DIR, CLI_DIR]) {
  for (const entry of await collectDirectories(directory, { optional: true })) {
    if (/^v\d+$/i.test(path.basename(entry))) {
      failures.push(`Versioned source directory is forbidden: ${relative(entry)}`);
    }
  }
}

for (const file of productionFiles) {
  const source = await readFile(file, "utf8");
  if (/\bV\d+_[A-Z0-9_]+\b/.test(source)) {
    failures.push(`Version-prefixed runtime state is forbidden: ${relative(file)}`);
  }
}

const cycles = await importCycles([...productionFiles, CLI_ENTRY]);
for (const cycle of cycles) failures.push(`Import cycle: ${cycle.map(relative).join(" -> ")}`);

if (failures.length) {
  console.error(`Architecture gate failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Architecture gate passed (${productionFiles.length} modules, zero exceptions).`);

async function assertLineLimit(file, limit, label) {
  const source = await readFile(file, "utf8");
  const lines = source.length === 0 ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  if (lines > limit) failures.push(`${label} exceeds ${limit} lines: ${relative(file)} (${lines})`);
}

async function collectModules(directory, { optional = false } = {}) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectModules(absolute));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(absolute);
  }
  return files.sort();
}

async function collectDirectories(directory, { optional = false } = {}) {
  const directories = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error?.code === "ENOENT") return directories;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(directory, entry.name);
    directories.push(absolute, ...await collectDirectories(absolute));
  }
  return directories;
}

async function importCycles(files) {
  const fileSet = new Set(files.map((file) => path.resolve(file)));
  const graph = new Map();
  for (const file of fileSet) {
    const source = await readFile(file, "utf8");
    const dependencies = [];
    const matcher = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
    for (const match of source.matchAll(matcher)) {
      if (!match[1].startsWith(".")) continue;
      const resolved = resolveModule(file, match[1]);
      if (resolved && fileSet.has(resolved)) dependencies.push(resolved);
    }
    graph.set(file, [...new Set(dependencies)]);
  }
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const found = new Map();
  function visit(file) {
    if (active.has(file)) {
      const start = stack.indexOf(file);
      const cycle = [...stack.slice(start), file];
      const key = canonicalCycleKey(cycle);
      found.set(key, cycle);
      return;
    }
    if (visited.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
    stack.pop();
    active.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return [...found.values()];
}

function resolveModule(importer, specifier) {
  const absolute = path.resolve(path.dirname(importer), specifier);
  if (path.extname(absolute)) return absolute;
  return `${absolute}.mjs`;
}

function canonicalCycleKey(cycle) {
  const nodes = cycle.slice(0, -1);
  const variants = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)].join("|"));
  return variants.sort()[0];
}

function relative(file) {
  return path.relative(REPOSITORY_DIR, file).split(path.sep).join("/");
}
