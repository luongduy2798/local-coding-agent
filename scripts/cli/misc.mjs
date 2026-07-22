// Local Coding Agent CLI utility commands.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  KEY_URLS,
  MIGRATION_RECOVERY_ENV,
  REPO_ROOT,
  SCRIPT_DIR,
  SKIP_MIGRATION_RECOVERY_ENV
} from "./config.mjs";
import { runChecked } from "./processes.mjs";
import { installCliCommand, openUrl } from "./setup.mjs";

async function keysCommand() {
  for (const url of KEY_URLS) {
    if (!openUrl(url)) console.log(url);
  }
}

async function cliCommand() {
  await installCliCommand();
}

function parseSkillMeta(text, fallbackName) {
  const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
  let name = fallbackName;
  let description = "";
  if (fm) {
    const block = fm[1];
    name = (block.match(/^\s*name\s*:\s*(.+?)\s*$/im)?.[1] || fallbackName).replace(/^["']|["']$/g, "").trim();
    description = (block.match(/^\s*description\s*:\s*(.+?)\s*$/im)?.[1] || "").replace(/^["']|["']$/g, "").trim();
  }
  return { name, description };
}

function listRepoSkills() {
  const skillsDir = join(REPO_ROOT, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(file)) return { folder: entry.name, name: entry.name, description: "(missing SKILL.md)" };
      const meta = parseSkillMeta(readFileSync(file, "utf8"), entry.name);
      return { folder: entry.name, ...meta };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function skillsCommand(rest) {
  const [sub = "list"] = rest;
  if (sub === "list") {
    for (const skill of listRepoSkills()) {
      console.log(`${skill.name} - ${skill.description}`);
    }
    return;
  }
  if (sub === "validate") {
    await runChecked("skills", process.execPath, [join(SCRIPT_DIR, "validate-skills.mjs")], { cwd: REPO_ROOT });
    return;
  }
  throw new Error("Usage: skills list|validate");
}

async function handoffAfterMigrationRecovery(argv) {
  const cliScript = join(REPO_ROOT, "scripts", "local-coding-agent.mjs");
  if (!existsSync(cliScript)) {
    throw new Error(`Recovered checkout is missing its CLI entrypoint: ${cliScript}`);
  }
  const env = { ...process.env, [SKIP_MIGRATION_RECOVERY_ENV]: "1" };
  delete env[MIGRATION_RECOVERY_ENV];
  return runChecked("resume", process.execPath, [cliScript, ...argv], {
    cwd: REPO_ROOT,
    env
  });
}


export {
  cliCommand,
  handoffAfterMigrationRecovery,
  keysCommand,
  skillsCommand
};

