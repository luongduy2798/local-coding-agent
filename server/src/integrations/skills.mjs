// Local Coding Agent workspace skill discovery
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

let ROOTS;
let SKILLS_DIRS;
let REPOSITORY_DIR;
let comparePath;
let dedupe;

export function configureSkillDiscovery({ roots, skillDirectories, repositoryDir, comparePaths, dedupeValues }) {
  ROOTS = roots;
  SKILLS_DIRS = skillDirectories;
  REPOSITORY_DIR = repositoryDir;
  comparePath = comparePaths;
  dedupe = dedupeValues;
}

export function sanitizeSkillName(name) {
  const s = String(name || "").trim();
  if (!s || s === "." || s === "..") return "";
  if (/[\\/]/.test(s) || !/^[\w.-]+$/.test(s)) return "";
  return s;
}

export function skillDirs(workspaceRoot) {
  return dedupe([
    path.join(workspaceRoot, ".claude", "skills"),
    path.join(workspaceRoot, ".agent", "skills"),
    ...(process.env.AGENT_SKILLS_DIR ? [path.resolve(process.env.AGENT_SKILLS_DIR)] : []),
    path.join(REPOSITORY_DIR, "skills")
  ]);
}

export function isWorkspaceSkillsDir(candidate, workspaceRoot) {
  const normalized = comparePath(path.resolve(candidate));
  return [
    path.join(workspaceRoot, ".claude", "skills"),
    path.join(workspaceRoot, ".agent", "skills")
  ].some((allowed) => comparePath(path.resolve(allowed)) === normalized);
}

export async function discoverSkills(skillDirs = SKILLS_DIRS) {
  const found = [];
  const seen = new Set();
  for (const base of skillDirs) {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // dir doesn't exist
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      let skillFile = null;
      try {
        const files = await readdir(dir);
        const hit = files.find((f) => f.toLowerCase() === "skill.md");
        if (hit) skillFile = path.join(dir, hit);
      } catch {
        continue;
      }
      if (!skillFile) continue;
      let meta;
      try {
        meta = parseSkillMeta(await readFile(skillFile, "utf8"), e.name);
      } catch {
        meta = { name: e.name, description: "" };
      }
      const key = meta.name.toLowerCase();
      if (seen.has(key)) continue; // first source wins
      seen.add(key);
      found.push({ name: meta.name, description: meta.description, dir, skillFile });
    }
  }
  return found;
}

export function parseSkillMeta(text, fallbackName) {
  text = text.replace(/^﻿/, ""); // strip UTF-8 BOM (some Windows editors add it)
  let name = fallbackName;
  let description = "";
  const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
  if (fm) {
    const block = fm[1];
    const n = block.match(/^\s*name\s*:\s*(.+?)\s*$/im);
    const d = block.match(/^\s*description\s*:\s*(.+?)\s*$/im);
    if (n) name = n[1].replace(/^["']|["']$/g, "").trim();
    if (d) description = d[1].replace(/^["']|["']$/g, "").trim();
  }
  if (!description) {
    const body = fm ? text.slice(fm[0].length) : text;
    const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (firstLine) description = firstLine.slice(0, 200);
  }
  return { name, description };
}
