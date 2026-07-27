// Local Coding Agent TypeScript semantic result and compiler helpers.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import {
  JAVASCRIPT_EXTENSIONS,
  SOURCE_EXTENSIONS,
  SUPPORTED_LANGUAGES,
  TypeScriptSemanticAdapterError
} from "./typescript-contract.mjs";

export class SemanticResultCollector {
  constructor({ rootDir, state, limit, maxRawResults, resolveLocation }) {
    this.rootDir = rootDir;
    this.state = state;
    this.limit = limit;
    this.maxRawResults = maxRawResults;
    this.resolveLocation = resolveLocation;
    this.results = [];
    this.seen = new Set();
    this.total = 0;
    this.raw = 0;
    this.truncated = false;
    this.fallbackReasons = new Set();
  }

  addFallback(reason) {
    if (reason) this.fallbackReasons.add(reason);
  }

  addDocumentSpan(fileName, textSpan, fields) {
    this.raw++;
    if (this.raw > this.maxRawResults) {
      this.truncated = true;
      return false;
    }
    const location = this.resolveLocation(fileName, textSpan);
    if (!location) return true;
    const key = `${fields.kind}:${fields.name || ""}:${location.path}:${location.line}:${location.column}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    this.total++;
    if (this.results.length >= this.limit) {
      this.truncated = true;
      return true;
    }
    const result = {
      ...fields,
      path: location.path,
      line: location.line,
      column: location.column,
      language: languageForPath(location.path),
      snippet: location.snippet
    };
    for (const keyName of ["detail", "signature", "snippet"]) {
      if (!result[keyName]) delete result[keyName];
    }
    this.results.push(result);
    return true;
  }

  totalForResponse() {
    return this.truncated ? Math.max(this.total, this.results.length + 1) : this.total;
  }
}

export function semanticPack(results, {
  total = results.length,
  truncated = false,
  complete,
  confidence,
  fallbackReasons = []
}) {
  const reasons = [...fallbackReasons].filter(Boolean);
  return {
    engine: "typescript-language-service",
    complete: complete === true,
    confidence,
    results,
    total,
    truncated: Boolean(truncated),
    fallback_reason: reasons.length ? [...new Set(reasons)].join(",") : null
  };
}

export function normalizeTypeScriptModule(namespace) {
  const candidates = [namespace?.default, namespace];
  for (const candidate of candidates) {
    if (candidate &&
        typeof candidate.createLanguageService === "function" &&
        typeof candidate.ScriptSnapshot?.fromString === "function") {
      return candidate;
    }
  }
  return null;
}

export function sanitizeCompilerOptions(options, rootDir) {
  const selected = { ...options };
  delete selected.plugins;
  for (const key of ["baseUrl", "rootDir", "outDir", "declarationDir"]) {
    if (selected[key] && !isWithin(rootDir, path.resolve(rootDir, String(selected[key])))) delete selected[key];
  }
  for (const key of ["rootDirs", "typeRoots"]) {
    if (!Array.isArray(selected[key])) continue;
    selected[key] = selected[key]
      .map((candidate) => path.resolve(rootDir, String(candidate)))
      .filter((candidate) => isWithin(rootDir, candidate));
  }
  return selected;
}

export function cachedLineStarts(state, key, content) {
  const cached = state.lineStarts.get(key);
  if (cached) return cached;
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  state.lineStarts.set(key, starts);
  return starts;
}

export function lineIndexForPosition(starts, position) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= position) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

export function offsetFromLineColumn(content, line, column) {
  const targetLine = boundedInteger(line, 1, 1, Number.MAX_SAFE_INTEGER);
  const targetColumn = boundedInteger(column, 1, 1, Number.MAX_SAFE_INTEGER);
  let cursor = 0;
  for (let currentLine = 1; currentLine < targetLine && cursor < content.length; currentLine++) {
    const newline = content.indexOf("\n", cursor);
    if (newline < 0) return content.length;
    cursor = newline + 1;
  }
  return Math.min(content.length, cursor + targetColumn - 1);
}

export function displayPartsText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => String(part?.text || "")).join("").trim().slice(0, 500);
}

export function takeSemanticCall(budget, maximum) {
  if (budget.calls >= maximum) {
    budget.exhausted = true;
    return false;
  }
  budget.calls++;
  return true;
}

export function languageForPath(filePath) {
  return JAVASCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? "javascript" : "typescript";
}

export function isCommonIdentifier(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

export function hasIdentifierBoundary(content, start, length) {
  const before = start > 0 ? content[start - 1] : "";
  const after = start + length < content.length ? content[start + length] : "";
  return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
}

export function normalizeRelativePath(value) {
  return String(value || "").split(path.sep).join("/").replace(/^\.\/+/, "") || ".";
}

export function samePath(left, right) {
  return comparePath(left) === comparePath(right);
}

export function comparePath(value) {
  const normalized = path.resolve(String(value));
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}

export function isWithin(root, candidate) {
  const rootValue = comparePath(root);
  const candidateValue = comparePath(candidate);
  return candidateValue === rootValue || candidateValue.startsWith(`${rootValue}${path.sep}`);
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("TypeScript semantic query was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

export function adapterError(code, message, cause) {
  return new TypeScriptSemanticAdapterError(code, message, cause ? { cause } : undefined);
}

export function serializeTypeScriptGraph(graph, adapter) {
  const source = typeof graph.iterateRecords === "function"
    ? graph.iterateRecords()
    : graph.getRecords();
  const records = [];
  const incompleteReasons = new Set();
  let sourceBytes = 0;
  for (const record of source) {
    const language = String(record?.language || "");
    if (!SUPPORTED_LANGUAGES.has(language) ||
        !SOURCE_EXTENSIONS.has(path.extname(String(record?.path || "")).toLowerCase())) continue;
    if (records.length >= adapter.maxSourceFiles) {
      incompleteReasons.add("typescript_source_budget_exceeded");
      continue;
    }
    const content = typeof record.content === "string" ? record.content : null;
    const bytes = content === null ? 0 : Buffer.byteLength(content);
    const contentUsable = content !== null &&
      record.content_complete === true &&
      bytes <= adapter.maxSourceFileBytes &&
      sourceBytes + bytes <= adapter.maxSourceBytes;
    if (!contentUsable) {
      incompleteReasons.add(
        sourceBytes + bytes > adapter.maxSourceBytes
          ? "typescript_source_budget_exceeded"
          : "typescript_source_content_incomplete"
      );
    }
    const selectedContent = contentUsable ? content : null;
    if (selectedContent !== null) sourceBytes += bytes;
    records.push({
      path: String(record.path || ""),
      language,
      fingerprint: String(record.fingerprint || ""),
      mtime_ms: Number(record.mtime_ms || 0),
      content: selectedContent,
      content_complete: contentUsable,
      symbols: Array.isArray(record.symbols)
        ? record.symbols.slice(0, 20_000).map((symbol) => ({
          name: String(symbol?.name || "").slice(0, 500),
          kind: String(symbol?.kind || "").slice(0, 100),
          line: boundedInteger(symbol?.line, 1, 1, Number.MAX_SAFE_INTEGER),
          column: boundedInteger(symbol?.column, 1, 1, Number.MAX_SAFE_INTEGER)
        }))
        : []
    });
  }
  return {
    workspaceId: String(graph.workspaceId || ""),
    generation: Number(graph.generation || 0),
    incompleteReasons: [...incompleteReasons],
    records
  };
}

export function abortError(reason) {
  const error = new Error(
    reason instanceof Error && reason.message
      ? reason.message
      : "TypeScript semantic query was cancelled."
  );
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  const selected = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.max(minimum, Math.min(maximum, selected));
}

export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export { SUPPORTED_LANGUAGES as TYPESCRIPT_SEMANTIC_LANGUAGES };
