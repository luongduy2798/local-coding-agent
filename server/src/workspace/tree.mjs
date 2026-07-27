// Local Coding Agent bounded workspace tree builders
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir } from "node:fs/promises";
import path from "node:path";

let SKIP_DIRS;
let listRepoFilesFast;

export function configureWorkspaceTree({ skipDirectories, listFilesFast }) {
  SKIP_DIRS = skipDirectories;
  listRepoFilesFast = listFilesFast;
}

export const MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "tsconfig.json",
  "pubspec.yaml",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "requirements.txt",
  "pyproject.toml",
  "gemfile",
  "composer.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "readme.md",
  ".env.example"
]);

export async function buildTree(start, maxDepth, maxEntries) {
  const tree = [];
  const dirs = [];
  const files = [];
  async function walk(current, depth) {
    if (tree.length >= maxEntries || depth > maxDepth) return;
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    // directories first, then files, alphabetical — predictable for the model
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const item of items) {
      if (tree.length >= maxEntries) return;
      if (SKIP_DIRS.has(item.name)) continue;
      const abs = path.join(current, item.name);
      tree.push(item.isDirectory() ? abs + path.sep : abs);
      if (item.isDirectory()) {
        dirs.push(abs);
        await walk(abs, depth + 1);
      } else {
        files.push(abs);
      }
    }
  }
  await walk(start, 1);
  return { tree, dirs, files };
}

export async function buildTreeFast(start, maxDepth, maxEntries) {
  const listed = await listRepoFilesFast(start, Math.max(maxEntries * 4, 4000));
  if (listed.engine === "scan") return { ...(await buildTree(start, maxDepth, maxEntries)), engine: "scan" };
  const tree = [];
  const dirs = new Set();
  const files = [];
  const seen = new Set();
  const addEntry = (entry) => {
    if (tree.length >= maxEntries || seen.has(entry)) return;
    seen.add(entry);
    tree.push(entry);
  };
  for (const abs of listed.files) {
    const rel = path.relative(start, abs).split(path.sep).join("/");
    const parts = rel.split("/").filter(Boolean);
    for (let i = 1; i < parts.length && i <= maxDepth; i++) {
      const dirAbs = path.resolve(start, ...parts.slice(0, i));
      dirs.add(dirAbs);
      addEntry(`${dirAbs}${path.sep}`);
    }
    if (parts.length <= maxDepth) {
      files.push(abs);
      addEntry(abs);
    }
    if (tree.length >= maxEntries) break;
  }
  return { tree, dirs: [...dirs], files, engine: listed.engine };
}
