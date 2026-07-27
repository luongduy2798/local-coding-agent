// Local Coding Agent built-in structural parser worker
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const PROTOCOL = "lca-structural-semantic-v1";
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".next", ".nuxt", ".cache",
  "node_modules", "vendor", "dist", "build", "coverage", "target", "__pycache__",
  ".venv", "venv", ".dart_tool", ".gradle"
]);
const LANGUAGE_BY_EXTENSION = new Map([
  [".js", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"], [".jsx", "javascript"],
  [".ts", "typescript"], [".tsx", "typescript"], [".mts", "typescript"], [".cts", "typescript"],
  [".py", "python"], [".go", "go"], [".rs", "rust"], [".java", "java"],
  [".kt", "kotlin"], [".kts", "kotlin"], [".cs", "csharp"], [".dart", "dart"]
]);
const DECLARATION_KEYWORDS = new Map([
  ["javascript", new Map([["function", "function"], ["class", "class"], ["interface", "interface"], ["type", "type"], ["enum", "enum"]])],
  ["typescript", new Map([["function", "function"], ["class", "class"], ["interface", "interface"], ["type", "type"], ["enum", "enum"], ["namespace", "namespace"]])],
  ["python", new Map([["def", "function"], ["class", "class"]])],
  ["go", new Map([["func", "function"], ["type", "type"]])],
  ["rust", new Map([["fn", "function"], ["struct", "struct"], ["trait", "trait"], ["enum", "enum"], ["type", "type"]])],
  ["java", new Map([["class", "class"], ["interface", "interface"], ["enum", "enum"], ["record", "record"]])],
  ["kotlin", new Map([["fun", "function"], ["class", "class"], ["interface", "interface"], ["typealias", "type"], ["object", "object"]])],
  ["csharp", new Map([["class", "class"], ["interface", "interface"], ["enum", "enum"], ["record", "record"], ["struct", "struct"]])],
  ["dart", new Map([["class", "class"], ["enum", "enum"], ["typedef", "type"], ["mixin", "mixin"], ["extension", "extension"]])]
]);
const TYPE_KINDS = new Set(["class", "interface", "type", "record", "struct", "enum", "trait", "mixin"]);
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "sizeof",
  "new", "class", "def", "fn", "func", "match", "when", "with", "super", "this",
  "assert", "import", "export"
]);

if (!parentPort || !workerData || workerData.protocol !== PROTOCOL) {
  throw new Error("Invalid structural semantic worker bootstrap.");
}

try {
  parentPort.postMessage({
    protocol: PROTOCOL,
    nonce: workerData.nonce,
    value: runQuery(workerData)
  });
} catch (error) {
  parentPort.postMessage({
    protocol: PROTOCOL,
    nonce: workerData.nonce,
    error: {
      code: String(error?.code || error?.name || "STRUCTURAL_WORKER_FAILED").slice(0, 120),
      message: String(error?.message || error || "Structural worker failed.").slice(0, 1_000)
    }
  });
}

function runQuery(options) {
  const requestedRoot = path.resolve(String(options.rootDir || ""));
  const rootDir = realpathSync(requestedRoot);
  if (!samePath(requestedRoot, rootDir) || !lstatSync(rootDir).isDirectory()) {
    throw workerError("STRUCTURAL_WORKSPACE_CHANGED", "Workspace root changed before structural query.");
  }
  const query = String(options.query || "").trim();
  if (!query) throw workerError("STRUCTURAL_QUERY_REQUIRED", "Structural query requires query text.");
  const languages = new Set(Array.isArray(options.languages) ? options.languages.map(String) : []);
  const files = [];
  const reasons = new Set();
  let visited = 0;
  let bytes = 0;
  walk(rootDir);

  const parsed = [];
  for (const file of files) {
    if (file.size > Number(options.maxFileBytes)) {
      reasons.add("structural_file_budget_exceeded");
      continue;
    }
    if (bytes + file.size > Number(options.maxSourceBytes)) {
      reasons.add("structural_source_budget_exceeded");
      continue;
    }
    let content;
    try {
      content = readNoFollowText(file.absolute);
    } catch {
      reasons.add("structural_source_unreadable");
      continue;
    }
    bytes += Buffer.byteLength(content);
    if (!containsIdentifier(content, query)) continue;
    parsed.push(parseDocument(content, file.relative, file.language));
  }
  if (options.graphComplete !== true) reasons.add("structural_graph_incomplete");
  if (options.contentComplete !== true) reasons.add("structural_graph_content_incomplete");

  let results = selectResults(parsed, query, String(options.mode), String(options.workspaceId || ""));
  const rawTotal = results.length;
  const maxResults = Math.max(1, Number(options.maxResults) || 10_000);
  if (results.length > maxResults) {
    results = results.slice(0, maxResults);
    reasons.add("structural_result_budget_exceeded");
  }
  const limit = Math.max(1, Number(options.limit) || 50);
  const truncated = results.length > limit || rawTotal > maxResults;
  if (truncated) reasons.add("structural_result_budget_exceeded");
  results = results.slice(0, limit);
  const complete = reasons.size === 0;
  return {
    engine: "builtin-structural-ast-v1",
    complete,
    confidence: complete ? 0.9 : 0.72,
    fallback_reason: reasons.size ? [...reasons].sort().join(";") : null,
    total: rawTotal,
    truncated,
    results
  };

  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      reasons.add("structural_directory_unreadable");
      return;
    }
    for (const entry of entries) {
      if (visited >= Number(options.maxFiles)) {
        reasons.add("structural_file_budget_exceeded");
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      visited++;
      const language = LANGUAGE_BY_EXTENSION.get(path.extname(entry.name).toLowerCase());
      if (!language || !languages.has(language)) continue;
      const relative = normalizeRelative(path.relative(rootDir, absolute));
      if (!relative) continue;
      let info;
      try {
        info = lstatSync(absolute);
      } catch {
        reasons.add("structural_source_unreadable");
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) continue;
      files.push({ absolute, relative, language, size: Number(info.size || 0) });
    }
  }
}

function parseDocument(content, filePath, language) {
  const tokens = tokenize(content, language);
  const declarations = parseDeclarations(tokens, content, language);
  const calls = [];
  const references = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;
    references.push(token);
    if (tokens[index + 1]?.value === "(" && !CALL_KEYWORDS.has(token.value)) {
      calls.push({ ...token, owner: nearestOwner(declarations, token.line) });
    }
  }
  return {
    path: filePath,
    language,
    content,
    declarations,
    references,
    calls,
    imports: parseImports(content, language)
  };
}

function tokenize(content, language) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const advance = () => {
    const character = content[index++];
    if (character === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return character;
  };
  while (index < content.length) {
    const character = content[index];
    const next = content[index + 1];
    if (/\s/.test(character)) {
      advance();
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < content.length && advance() !== "\n") {}
      continue;
    }
    if (character === "/" && next === "*") {
      advance();
      advance();
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) advance();
      if (index < content.length) {
        advance();
        advance();
      }
      continue;
    }
    if (character === "#" && ["python", "rust"].includes(language)) {
      while (index < content.length && advance() !== "\n") {}
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      const quote = advance();
      while (index < content.length) {
        const selected = advance();
        if (selected === "\\" && index < content.length) advance();
        else if (selected === quote) break;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const startLine = line;
      const startColumn = column;
      let value = "";
      while (index < content.length && /[A-Za-z0-9_$]/.test(content[index])) value += advance();
      tokens.push({ type: "identifier", value, line: startLine, column: startColumn });
      continue;
    }
    tokens.push({ type: "punctuation", value: advance(), line, column: Math.max(1, column - 1) });
  }
  return tokens;
}

function parseDeclarations(tokens, content, language) {
  const keywords = DECLARATION_KEYWORDS.get(language) || new Map();
  const declarations = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    const keyword = tokens[index];
    if (keyword.type !== "identifier" || !keywords.has(keyword.value)) continue;
    let nameIndex = index + 1;
    if (language === "go" && keyword.value === "func" && tokens[nameIndex]?.value === "(") {
      let depth = 0;
      while (nameIndex < tokens.length) {
        if (tokens[nameIndex].value === "(") depth++;
        if (tokens[nameIndex].value === ")" && --depth === 0) {
          nameIndex++;
          break;
        }
        nameIndex++;
      }
    }
    const name = tokens.slice(nameIndex).find((token) => token.type === "identifier");
    if (!name) continue;
    let kind = keywords.get(keyword.value);
    if (language === "go" && keyword.value === "type") {
      const afterName = tokens.slice(tokens.indexOf(name) + 1).find((token) => token.type === "identifier");
      if (afterName?.value === "struct" || afterName?.value === "interface") kind = afterName.value;
    }
    declarations.push({
      name: name.value,
      kind,
      line: name.line,
      column: name.column,
      signature: lineSnippet(content, name.line)
    });
  }
  for (const declaration of parseLineDeclarations(content, language)) {
    if (!declarations.some((existing) =>
      existing.name === declaration.name && existing.line === declaration.line
    )) declarations.push(declaration);
  }
  return declarations.sort((left, right) => left.line - right.line || left.column - right.column);
}

function parseLineDeclarations(content, language) {
  const output = [];
  const patterns = [];
  if (["javascript", "typescript"].includes(language)) {
    patterns.push({
      regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
      kind: "function"
    });
  }
  if (["java", "csharp", "dart"].includes(language)) {
    patterns.push({
      regex: /^\s*(?:(?:public|private|protected|internal|static|final|virtual|override|abstract|async|external|factory)\s+)*(?:[A-Za-z_$][\w$<>,?.\[\]]*\s+)+([A-Za-z_$][\w$]*)\s*\(/,
      kind: "function"
    });
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    for (const pattern of patterns) {
      const match = lines[index].match(pattern.regex);
      const name = match?.[1];
      if (!name || CALL_KEYWORDS.has(name)) continue;
      output.push({
        name,
        kind: pattern.kind,
        line: index + 1,
        column: Math.max(1, lines[index].indexOf(name) + 1),
        signature: lines[index].trim().slice(0, 500)
      });
    }
  }
  return output;
}

function selectResults(documents, query, mode, workspaceId) {
  const output = [];
  const add = (document, value, extra = {}) => output.push({
    ...extra,
    path: document.path,
    line: value.line,
    column: value.column,
    language: document.language,
    score: 0.92
  });
  for (const document of documents) {
    if (mode === "symbol" || mode === "definition" || mode === "type") {
      for (const declaration of document.declarations) {
        if (declaration.name !== query) continue;
        if (mode === "type" && !TYPE_KINDS.has(declaration.kind) && declaration.kind !== "function") continue;
        add(document, declaration, {
          kind: mode === "type" ? "type" : mode === "definition" ? "definition" : "symbol",
          name: declaration.name,
          symbol_kind: declaration.kind,
          signature: declaration.signature,
          snippet: declaration.signature
        });
      }
    } else if (mode === "references") {
      for (const reference of document.references) {
        if (reference.value === query) add(document, reference, { kind: "reference", name: query });
      }
    } else if (mode === "imports") {
      for (const imported of document.imports) {
        if (imported.module.includes(query) || imported.names.includes(query)) {
          add(document, imported, { kind: "import", module: imported.module, name: query });
        }
      }
    } else if (mode === "callers") {
      for (const call of document.calls) {
        if (call.value !== query || !call.owner) continue;
        add(document, call.owner, {
          kind: "caller",
          name: call.owner.name,
          calls: query,
          snippet: call.owner.signature
        });
      }
    } else if (mode === "callees") {
      const owner = document.declarations.find((declaration) => declaration.name === query && declaration.kind === "function");
      if (!owner) continue;
      const nextOwner = document.declarations
        .filter((declaration) => declaration.kind === "function" && declaration.line > owner.line)
        .sort((left, right) => left.line - right.line)[0];
      for (const call of document.calls) {
        if (call.line < owner.line || (nextOwner && call.line >= nextOwner.line) || call.value === query) continue;
        add(document, call, { kind: "callee", name: call.value, owner: query });
      }
    }
  }
  output.sort((left, right) =>
    String(left.path).localeCompare(String(right.path)) || left.line - right.line || left.column - right.column
  );
  return deduplicate(output, workspaceId);
}

function deduplicate(results, _workspaceId) {
  const seen = new Set();
  return results.filter((result) => {
    const key = `${result.kind}:${result.name || result.module || ""}:${result.path}:${result.line}:${result.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nearestOwner(declarations, line) {
  return declarations
    .filter((declaration) => declaration.kind === "function" && declaration.line <= line)
    .sort((left, right) => right.line - left.line)[0] || null;
}

function parseImports(content, language) {
  const output = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let match;
    let module = null;
    let names = [];
    if ((match = line.match(/^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']/))) {
      module = match[2];
      names = identifiers(match[1]);
    } else if ((match = line.match(/^\s*import\s+["']([^"']+)["']/))) {
      module = match[1];
    } else if (language === "python" && (match = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/))) {
      module = match[1];
      names = identifiers(match[2]);
    } else if (language === "python" && (match = line.match(/^\s*import\s+([\w.]+)/))) {
      module = match[1];
    } else if (language === "rust" && (match = line.match(/^\s*use\s+([^;]+);/))) {
      module = match[1];
    } else if (["java", "kotlin", "csharp"].includes(language) &&
        (match = line.match(/^\s*(?:import|using)\s+([^;]+);?/))) {
      module = match[1];
    } else if (language === "go" && (match = line.match(/^\s*(?:import\s+)?["']([^"']+)["']/))) {
      module = match[1];
    }
    if (!module) continue;
    output.push({ module, names, line: index + 1, column: Math.max(1, line.indexOf(module) + 1) });
  }
  return output;
}

function identifiers(value) {
  return [...String(value).matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
}

function containsIdentifier(content, query) {
  let index = content.indexOf(query);
  while (index >= 0) {
    const before = content[index - 1] || "";
    const after = content[index + query.length] || "";
    if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) return true;
    index = content.indexOf(query, index + Math.max(1, query.length));
  }
  return false;
}

function lineSnippet(content, targetLine) {
  return (content.split(/\r?\n/)[Math.max(0, targetLine - 1)] || "").trim().slice(0, 500);
}

function readNoFollowText(filePath) {
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw workerError("STRUCTURAL_SOURCE_INVALID", "Source file is unsafe.");
  const descriptor = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function normalizeRelative(value) {
  const normalized = String(value).split(path.sep).join("/").replace(/^\.\/+/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) return null;
  return normalized;
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
