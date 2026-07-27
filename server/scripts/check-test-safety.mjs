// Local Coding Agent test safety source scanner
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PACKAGE_DIR = path.resolve(SCRIPTS_DIR, "..");
const REPOSITORY_ROOT = path.resolve(SERVER_PACKAGE_DIR, "..");
const candidates = [
  ...(await findMatching(path.join(SERVER_PACKAGE_DIR, "tests"), (name) => name.endsWith(".mjs"))),
  ...(await findMatching(path.join(REPOSITORY_ROOT, "evals"), (name) => name.endsWith(".mjs"))),
  ...(await findMatching(path.join(REPOSITORY_ROOT, "scripts"), (name) => name.endsWith(".test.mjs"))),
  ...(await findMatching(path.join(REPOSITORY_ROOT, ".github", "workflows"), (name) => /\.ya?ml$/.test(name)))
];

const rules = [
  {
    id: "direct-recursive-remove",
    regex: /\b(?:rm|rmSync|fs\.rm|fs\.rmSync)\s*\([\s\S]{0,400}?recursive\s*:\s*true/g,
    message: "Direct recursive filesystem removal is forbidden. Use safeRemove() from server/tests/helpers/test-guard.mjs."
  },
  {
    id: "shell-recursive-remove",
    regex: /\brm\s+-[^\n]*[rR][^\n]*\b|Remove-Item[^\n]*(?:-Recurse|-r\b)/gi,
    message: "Shell recursive cleanup is forbidden. Use safeRemove()."
  },
  {
    id: "destructive-git",
    regex: /git\s+(?:clean|reset\s+--hard|checkout\s+--\s+\.|restore\s+\.)/gi,
    message: "Destructive Git cleanup is forbidden in tests."
  },
  {
    id: "process-name-kill",
    regex: /\b(?:pkill|killall)\b/gi,
    message: "Tests may stop only the exact child process they spawned."
  },
  {
    id: "runtime-port",
    regex: /(?:127\.0\.0\.1:8789|PORT\s*[:=]\s*["']?8789)/g,
    message: "Tests must use a dynamically allocated port, never runtime port 8789."
  },
  {
    id: "runtime-data",
    regex: /(?:server[\\/]data[\\/]|path\.resolve\([^\n]*["']data["'][^\n]*["']audit\.log["'])/g,
    message: "Tests must use a dedicated AGENT_DATA_DIR under the isolated test root."
  },
  {
    id: "cwd-as-workspace",
    regex: /AGENT_WORKSPACE\s*:\s*process\.cwd\(\)/g,
    message: "process.cwd() must not be used as a disposable workspace."
  }
];

const violations = [];
for (const filePath of [...new Set(candidates)]) {
  const relative = path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join("/");
  if (relative === "server/tests/helpers/test-guard.mjs") continue;
  const text = await readFile(filePath, "utf8");
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(text))) {
      const line = text.slice(0, match.index).split("\n").length;
      violations.push({ relative, line, rule: rule.id, message: rule.message });
      if (match[0].length === 0) rule.regex.lastIndex++;
    }
  }
}

if (violations.length) {
  console.error("Unsafe test patterns found:\n");
  for (const item of violations) {
    console.error(`${item.relative}:${item.line} [${item.rule}]`);
    console.error(`  ${item.message}\n`);
  }
  process.exit(1);
}

console.log(`Test safety scan passed (${new Set(candidates).size} files scanned).`);

async function findMatching(directory, predicate) {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await findMatching(fullPath, predicate));
    else if (predicate(entry.name)) output.push(fullPath);
  }
  return output;
}
