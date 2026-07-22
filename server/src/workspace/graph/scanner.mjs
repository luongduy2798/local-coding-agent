// Local Coding Agent workspace scanner, fingerprints and lexical facts.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const LANGUAGE_BY_EXTENSION = new Map([
  [".js", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"],
  [".jsx", "javascript"], [".ts", "typescript"], [".tsx", "typescript"],
  [".py", "python"], [".go", "go"], [".rs", "rust"], [".java", "java"],
  [".kt", "kotlin"], [".kts", "kotlin"], [".cs", "csharp"], [".dart", "dart"],
  [".sh", "shell"], [".bash", "shell"], [".zsh", "shell"], [".fish", "shell"],
  [".json", "json"], [".jsonc", "json"], [".yaml", "yaml"], [".yml", "yaml"],
  [".toml", "toml"], [".xml", "xml"], [".html", "html"], [".css", "css"],
  [".scss", "css"], [".md", "markdown"], [".mdx", "markdown"], [".sql", "sql"],
  [".vue", "vue"], [".svelte", "svelte"], [".php", "php"], [".rb", "ruby"],
  [".swift", "swift"], [".c", "c"], [".h", "c"], [".cc", "cpp"],
  [".cpp", "cpp"], [".cxx", "cpp"], [".hpp", "cpp"]
]);
const TYPE_KINDS = new Set(["class", "interface", "type", "record", "struct", "enum", "trait"]);
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof",
  "sizeof", "new", "class", "def", "fn", "func", "match", "when", "with",
  "super", "this", "assert", "import", "export"
]);
const FILE_FINGERPRINT_HEX_LENGTH = 32;
const EMPTY_FACTS = Object.freeze([]);
const RECORD_PROTOTYPES = new Map();
const MAX_RECORD_PROTOTYPES = 64;

export function coverageSatisfies(available, requested) {
  if (!available) return false;
  const need = normalizeCoverage(requested);
  return Number(available.max_files || 0) >= need.max_files &&
    Number(available.max_depth || 0) >= need.max_depth &&
    Number(available.max_file_bytes || 0) >= need.max_file_bytes;
}

export function extractLexicalFacts(content, filePath, language = detectLanguage(filePath, content)) {
  const lines = String(content || "").split(/\r?\n/);
  const symbols = [];
  const imports = [];
  const calls = [];
  const symbolKeys = new Set();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const pattern of symbolPatterns(language)) {
      const match = line.match(pattern.regex);
      const name = match?.[pattern.nameGroup || 1];
      if (!name) continue;
      const kind = typeof pattern.kind === "function" ? pattern.kind(match) : pattern.kind;
      const key = `${index}:${kind}:${name}`;
      if (symbolKeys.has(key)) continue;
      symbolKeys.add(key);
      symbols.push({
        name,
        kind,
        line: index + 1,
        column: Math.max(1, line.indexOf(name) + 1)
      });
    }

    for (const imported of parseImports(line, language)) {
      imports.push({
        module: imported.module,
        names: imported.names,
        line: index + 1,
        column: Math.max(1, imported.column + 1),
        raw: line.trim().slice(0, 300)
      });
    }

    const declared = new Set(symbols.filter((symbol) => symbol.line === index + 1).map((symbol) => symbol.name));
    const callRegex = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
    let callMatch;
    while ((callMatch = callRegex.exec(line))) {
      const expression = callMatch[1];
      const name = expression.split(".").pop();
      if (CALL_KEYWORDS.has(name) || declared.has(name)) continue;
      calls.push({
        name,
        expression,
        line: index + 1,
        column: callMatch.index + 1
      });
    }
  }

  for (const symbol of extractStructuralSymbols(lines, language)) {
    const key = `${symbol.line - 1}:${symbol.kind}:${symbol.name}`;
    if (symbolKeys.has(key)) continue;
    symbolKeys.add(key);
    symbols.push(symbol);
  }

  return { symbols, imports, calls };
}

export function detectLanguage(filePath, content = "") {
  const extension = path.extname(filePath).toLowerCase();
  if (LANGUAGE_BY_EXTENSION.has(extension)) return LANGUAGE_BY_EXTENSION.get(extension);
  const firstLine = String(content).split(/\r?\n/, 1)[0] || "";
  if (/^#!.*\bpython/.test(firstLine)) return "python";
  if (/^#!.*\b(node|deno|bun)\b/.test(firstLine)) return "javascript";
  if (/^#!.*\b(bash|sh|zsh|fish)\b/.test(firstLine)) return "shell";
  return "text";
}

export function recordLineSnippet(record, lineNumber, maxLength = 300) {
  const content = String(record?.content || "");
  const targetLine = Math.max(1, Math.trunc(Number(lineNumber) || 1));
  let start = 0;
  for (let line = 1; line < targetLine; line++) {
    const newline = content.indexOf("\n", start);
    if (newline < 0) return "";
    start = newline + 1;
  }
  const newline = content.indexOf("\n", start);
  const end = newline < 0 ? content.length : newline;
  return content.slice(start, end).replace(/\r$/, "").trim().slice(0, maxLength);
}

export function countLinesThrough(content, offset) {
  let line = 1;
  let cursor = content.indexOf("\n");
  while (cursor >= 0 && cursor < offset) {
    line++;
    cursor = content.indexOf("\n", cursor + 1);
  }
  return line;
}

export function appendRecordTextMatches(record, {
  workspaceId,
  normalizedNeedle,
  caseSensitive,
  limit,
  matches
}) {
  if (!record.content) return;
  const source = record.content;
  const haystack = caseSensitive ? source : source.toLowerCase();
  let cursor = haystack.indexOf(normalizedNeedle);
  while (cursor >= 0) {
    const lineStart = haystack.lastIndexOf("\n", cursor - 1) + 1;
    const lineEnd = haystack.indexOf("\n", cursor);
    const rawLine = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).replace(/\r$/, "");
    const line = countLinesThrough(source, cursor);
    matches.push({
      location: {
        workspace_id: workspaceId,
        path: record.path,
        line,
        column: cursor - lineStart + 1
      },
      snippet: rawLine.trim().slice(0, 500),
      language: record.language
    });
    if (matches.length >= limit) return;
    cursor = haystack.indexOf(normalizedNeedle, cursor + Math.max(1, normalizedNeedle.length));
  }
}

export function buildRecord(scanned) {
  const language = detectLanguage(scanned.path, scanned.content || "");
  const facts = scanned.content
    ? extractLexicalFacts(scanned.content, scanned.path, language)
    : { symbols: [], imports: [], calls: [] };
  return compactRecord(scanned, {
    contentLimit: scanned.content_limit,
    contentComplete: scanned.content_complete === true,
    binary: scanned.binary === true,
    language,
    symbols: facts.symbols,
    imports: facts.imports,
    calls: facts.calls
  });
}

export function compactRecord(record, {
  contentLimit,
  contentComplete,
  binary,
  language,
  symbols,
  imports,
  calls
}) {
  const analysisEngine = ["json", "yaml", "toml", "shell"].includes(language)
    ? "structural_lexical"
    : "lexical";
  // Build a fresh object with one stable own-property order. Deleting fields
  // from parsed/scanned objects before changing their prototype pushes large
  // indexes toward V8 dictionary mode and costs more memory than it saves.
  const compact = Object.create(recordPrototype(contentLimit, analysisEngine));
  compact.path = record.path;
  compact.size = record.size;
  compact.mtime_ms = record.mtime_ms;
  compact.ctime_ms = record.ctime_ms;
  compact.fingerprint = record.fingerprint;
  compact.content = record.content;
  compact.language = language;
  if (!contentComplete) defineRecordOverride(compact, "content_complete", false);
  if (binary) defineRecordOverride(compact, "binary", true);
  if (symbols.length) defineRecordOverride(compact, "symbols", symbols);
  if (imports.length) defineRecordOverride(compact, "imports", imports);
  if (calls.length) defineRecordOverride(compact, "calls", calls);
  return compact;
}

export function recordPrototype(contentLimit, analysisEngine) {
  const key = `${contentLimit}\0${analysisEngine}`;
  let prototype = RECORD_PROTOTYPES.get(key);
  if (prototype) return prototype;
  prototype = Object.freeze({
    content_limit: contentLimit,
    content_complete: true,
    binary: false,
    analysis_engine: analysisEngine,
    symbols: EMPTY_FACTS,
    imports: EMPTY_FACTS,
    calls: EMPTY_FACTS
  });
  if (RECORD_PROTOTYPES.size >= MAX_RECORD_PROTOTYPES) {
    RECORD_PROTOTYPES.delete(RECORD_PROTOTYPES.keys().next().value);
  }
  RECORD_PROTOTYPES.set(key, prototype);
  return prototype;
}

export function defineRecordOverride(record, key, value) {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}

export function extractStructuralSymbols(lines, language) {
  const symbols = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let match = null;
    let kind = "property";
    if (language === "json") {
      match = line.match(/^\s*["']([^"']+)["']\s*:/);
    } else if (language === "yaml") {
      match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:/);
    } else if (language === "toml") {
      const section = line.match(/^\s*\[+([^\]]+)]/);
      if (section) {
        match = section;
        kind = "section";
      } else {
        match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
      }
    } else if (language === "shell") {
      match = line.match(/^\s*(?:export\s+|readonly\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      kind = "variable";
    }
    const name = match?.[1];
    if (!name) continue;
    symbols.push({
      name,
      kind,
      line: index + 1,
      column: Math.max(1, line.indexOf(name) + 1)
    });
  }
  return symbols;
}

export async function scanWorkspace(rootDir, coverage, { skipDirs, previous, concurrency }) {
  const candidates = [];
  let visitedFiles = 0;
  let visitedDirectories = 0;
  let skippedSymlinks = 0;
  let skippedDirectories = 0;
  let unreadableFiles = 0;
  let unreadableDirectories = 0;
  let contentTruncatedFiles = 0;
  let binaryFiles = 0;
  let truncatedByFileLimit = false;
  let truncatedByDepth = false;

  async function visit(directory, depth) {
    visitedDirectories++;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      unreadableDirectories++;
      return;
    }
    entries = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (candidates.length >= coverage.max_files) {
        truncatedByFileLimit = true;
        return;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks++;
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          skippedDirectories++;
          continue;
        }
        if (depth >= coverage.max_depth) {
          truncatedByDepth = true;
          continue;
        }
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visitedFiles++;
      const relative = normalizeRelativePath(path.relative(rootDir, absolute));
      candidates.push({ absolute, relative });
    }
  }

  await visit(rootDir, 0);
  const scratchBuffers = new Array(Math.min(candidates.length, Math.max(1, concurrency)));
  const scratchBytes = Math.min(coverage.max_file_bytes, 64 * 1024);
  const records = await mapWithConcurrency(candidates, concurrency, async ({ absolute, relative }, _index, workerIndex) => {
    let file;
    try {
      scratchBuffers[workerIndex] ||= Buffer.allocUnsafe(scratchBytes);
      file = await fingerprintFile(
        absolute,
        coverage.max_file_bytes,
        previous?.get(relative),
        true,
        scratchBuffers[workerIndex]
      );
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error?.code)) throw error;
      unreadableFiles++;
      return null;
    }
    if (!file.content_complete && !file.binary) contentTruncatedFiles++;
    if (file.binary) binaryFiles++;
    return { path: relative, ...file };
  }).then((items) => items.filter(Boolean));
  return {
    records,
    visitedFiles,
    visitedDirectories,
    skippedSymlinks,
    skippedDirectories,
    unreadableFiles,
    unreadableDirectories,
    contentTruncatedFiles,
    binaryFiles,
    truncatedByFileLimit,
    truncatedByDepth
  };
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, concurrency)) },
    async (_, workerIndex) => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        output[index] = await mapper(items[index], index, workerIndex);
      }
    }
  );
  await Promise.all(workers);
  return output;
}

export async function fingerprintFile(filePath, contentLimit, prior = null, retry = true, scratchBuffer = null) {
  const before = await stat(filePath);
  if (
    prior &&
    prior.size === before.size &&
    prior.mtime_ms === before.mtimeMs &&
    prior.ctime_ms === before.ctimeMs &&
    prior.content_limit >= contentLimit
  ) {
    return {
      size: before.size,
      mtime_ms: before.mtimeMs,
      ctime_ms: before.ctimeMs,
      fingerprint: prior.fingerprint,
      content: prior.content,
      content_limit: prior.content_limit,
      content_complete: prior.content_complete,
      binary: prior.binary
    };
  }
  const hash = createHash("sha256");
  let buffer;
  if (before.size <= contentLimit) {
    if (scratchBuffer && before.size <= scratchBuffer.length) {
      let handle;
      let offset = 0;
      try {
        handle = await open(filePath, "r");
        while (offset < before.size) {
          const { bytesRead } = await handle.read(
            scratchBuffer,
            offset,
            before.size - offset,
            offset
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
      } finally {
        await handle?.close().catch(() => {});
      }
      buffer = scratchBuffer.subarray(0, offset);
    } else {
      buffer = await readFile(filePath);
    }
    hash.update(buffer);
  } else {
    const chunks = [];
    let captured = 0;
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk);
      if (captured < contentLimit) {
        const remaining = contentLimit - captured;
        const selected = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(selected);
        captured += selected.length;
      }
    }
    buffer = Buffer.concat(chunks);
  }
  const after = await stat(filePath);
  if (
    retry &&
    (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
  ) {
    return fingerprintFile(filePath, contentLimit, null, false, scratchBuffer);
  }
  if (buffer.length > contentLimit) buffer = buffer.subarray(0, contentLimit);
  const binary = looksBinary(buffer);
  return {
    size: after.size,
    mtime_ms: after.mtimeMs,
    ctime_ms: after.ctimeMs,
    // A 128-bit prefix keeps collision risk negligible for local repository
    // change detection while halving the dominant per-record hash string.
    // Persisted legacy indexes with the previous 256-bit value remain readable.
    fingerprint: hash.digest("hex").slice(0, FILE_FINGERPRINT_HEX_LENGTH),
    content: binary ? null : buffer.toString("utf8"),
    content_limit: contentLimit,
    content_complete: after.size <= contentLimit,
    binary
  };
}

export function looksBinary(buffer) {
  if (!buffer.length) return false;
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  let control = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return control / sample.length > 0.15;
}

export function symbolPatterns(language) {
  const commonTypes = [
    { regex: /^\s*(?:export\s+)?(?:abstract\s+|sealed\s+|partial\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { regex: /^\s*(?:export\s+)?(?:type|typealias)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
    { regex: /^\s*(?:export\s+)?enum\s+(?:class\s+)?([A-Za-z_$][\w$]*)/, kind: "enum" },
    { regex: /^\s*(?:public\s+|private\s+|internal\s+)?record\s+([A-Za-z_$][\w$]*)/, kind: "record" },
    { regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_$][\w$]*)/, kind: "struct" },
    { regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z_$][\w$]*)/, kind: "trait" }
  ];
  if (language === "python") {
    return [
      { regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
      { regex: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" }
    ];
  }
  if (language === "go") {
    return [
      { regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "function" },
      { regex: /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/, kind: (match) => match[2] }
    ];
  }
  if (language === "rust") {
    return [
      { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/, kind: "function" },
      ...commonTypes
    ];
  }
  if (["java", "kotlin", "csharp", "dart", "swift", "cpp", "c"].includes(language)) {
    return [
      ...commonTypes,
      {
        regex: /^\s*(?:(?:public|private|protected|internal|static|final|virtual|override|async|suspend|fun)\s+)+[\w<>\[\],?.:*&\s]+\s+([A-Za-z_]\w*)\s*\(/,
        kind: "method"
      }
    ];
  }
  if (language === "shell") {
    return [
      { regex: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?/, kind: "function" }
    ];
  }
  return [
    { regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, kind: "function" },
    { regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function" },
    ...commonTypes
  ];
}

export function parseImports(line, language) {
  const output = [];
  const add = (module, names = [], column = 0) => {
    if (module) output.push({ module, names: names.filter(Boolean), column });
  };
  let match;
  if ((match = line.match(/^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']/))) {
    add(match[2], importedNames(match[1]), line.indexOf(match[2]));
  } else if ((match = line.match(/^\s*import\s+["']([^"']+)["']/))) {
    add(match[1], [], line.indexOf(match[1]));
  } else if ((match = line.match(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/))) {
    add(match[1], [], line.indexOf(match[1]));
  } else if (language === "python" && (match = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/))) {
    add(match[1], importedNames(match[2]), line.indexOf(match[1]));
  } else if (language === "python" && (match = line.match(/^\s*import\s+([\w.]+)/))) {
    add(match[1], [], line.indexOf(match[1]));
  } else if (language === "rust" && (match = line.match(/^\s*use\s+([^;]+);/))) {
    add(match[1], [], line.indexOf(match[1]));
  } else if (["java", "kotlin", "csharp"].includes(language) && (match = line.match(/^\s*(?:import|using)\s+([^;]+);?/))) {
    add(match[1], [], line.indexOf(match[1]));
  } else if (language === "dart" && (match = line.match(/^\s*import\s+["']([^"']+)["']/))) {
    add(match[1], [], line.indexOf(match[1]));
  } else if (language === "go" && (match = line.match(/^\s*(?:import\s+)?["']([^"']+)["']/))) {
    add(match[1], [], line.indexOf(match[1]));
  }
  return output;
}

export function importedNames(source) {
  return String(source)
    .replace(/[{}*]/g, "")
    .split(",")
    .map((value) => value.trim().split(/\s+as\s+/i)[0])
    .filter((value) => /^[A-Za-z_$][\w$]*$/.test(value));
}

export function normalizeCoverage(input = {}) {
  const maxFiles = input.maxFiles ?? input.max_files ?? 10_000;
  const maxDepth = input.maxDepth ?? input.max_depth ?? 16;
  const maxFileBytes = input.maxFileBytes ?? input.max_file_bytes ?? 512 * 1024;
  return {
    max_files: boundedInteger(maxFiles, 10_000, 1, 250_000),
    max_depth: boundedInteger(maxDepth, 16, 0, 64),
    max_file_bytes: boundedInteger(maxFileBytes, 512 * 1024, 64, 8 * 1024 * 1024)
  };
}

export function mergeCoverage(current, requested) {
  if (!current) return requested;
  return {
    max_files: Math.max(current.max_files || 0, requested.max_files),
    max_depth: Math.max(current.max_depth || 0, requested.max_depth),
    max_file_bytes: Math.max(current.max_file_bytes || 0, requested.max_file_bytes)
  };
}

export function fingerprintRecords(records) {
  const hash = createHash("sha256");
  for (const record of records.values()) {
    hash.update(record.path);
    hash.update("\0");
    hash.update(record.fingerprint);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function fingerprintRecordsCooperative(records) {
  if (typeof records.fingerprintCooperative === "function") {
    return records.fingerprintCooperative();
  }
  const hash = createHash("sha256");
  let count = 0;
  for (const record of records.values()) {
    hash.update(record.path);
    hash.update("\0");
    hash.update(record.fingerprint);
    hash.update("\0");
    count++;
    if (count % 1_024 === 0) await yieldToEventLoop();
  }
  return hash.digest("hex");
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function fingerprintCoverage(coverage) {
  return createHash("sha256")
    .update(`${coverage.max_files}:${coverage.max_depth}:${coverage.max_file_bytes}`)
    .digest("hex");
}

export function stableId(value) {
  return `ws_${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

export function normalizeRelativePath(value) {
  const normalized = String(value || "").split(path.sep).join("/").replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    if (normalized === "." || !normalized) return "";
    throw new Error(`Invalid workspace-relative path: ${value}`);
  }
  return normalized;
}

export function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function emptyChanges() {
  return { added: [], changed: [], removed: [], unchanged: [], parsed_files: 0, reused_files: 0 };
}

export function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export function cloneChanges(changes) {
  return {
    added: [...changes.added],
    changed: [...changes.changed],
    removed: [...changes.removed],
    unchanged: [...changes.unchanged],
    parsed_files: changes.parsed_files,
    reused_files: changes.reused_files
  };
}

export { TYPE_KINDS };
