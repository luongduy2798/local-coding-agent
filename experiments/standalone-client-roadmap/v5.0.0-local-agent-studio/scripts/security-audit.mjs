#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_EXTENSIONS = new Set([".cjs", ".cs", ".js", ".json", ".mjs", ".ps1", ".ts", ".tsx"]);
const SKIP = new Set(["bin", "dist", "node_modules", "obj", "publish", "test"]);
const FORBIDDEN_PATTERNS = [
  { name: "dynamic eval", pattern: /\beval\s*\(/ },
  { name: "Function constructor", pattern: /\bnew\s+Function\s*\(/ },
  { name: "encoded PowerShell", pattern: /powershell(?:\.exe)?[^\n]{0,120}-(?:enc|encodedcommand)\b/i },
  { name: "PowerShell expression execution", pattern: /\bInvoke-Expression\b|\biex\s*\(/i },
  { name: "download and pipe to shell", pattern: /(?:curl|wget)[^\n|]{0,200}\|\s*(?:bash|sh|powershell)/i },
  { name: "persistence registry key", pattern: /reg(?:\.exe)?\s+add[^\n]+\\CurrentVersion\\Run/i },
  { name: "scheduled task persistence", pattern: /schtasks(?:\.exe)?\s+\/create/i },
  { name: "base64 executable decoding", pattern: /FromBase64String|certutil(?:\.exe)?\s+-decode/i },
  { name: "embedded private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
];

const files = await walk(ROOT);
const findings = [];
const hashes = [];

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const bytes = await readFile(file);
  hashes.push({ path: rel, sha256: createHash("sha256").update(bytes).digest("hex") });
  if (!SOURCE_EXTENSIONS.has(extname(file).toLowerCase()) || rel === "package-lock.json" || rel === "scripts/security-audit.mjs") continue;
  const text = bytes.toString("utf8");
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(text)) findings.push({ path: rel, rule: rule.name });
  }
}

const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
for (const name of Object.keys(packageJson.scripts || {})) {
  if (/^(?:pre|post)(?:install|pack|publish)|prepare$/i.test(name)) {
    findings.push({ path: "package.json", rule: `unexpected lifecycle script: ${name}` });
  }
}

const report = {
  ok: findings.length === 0,
  scannedFiles: files.length,
  sourceHashes: hashes.sort((a, b) => a.path.localeCompare(b.path)),
  findings
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

async function walk(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(full));
    else if (entry.isFile() && (await stat(full)).size <= 5_000_000) output.push(full);
  }
  return output;
}
