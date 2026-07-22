// Local Coding Agent code query engine
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { recordLineSnippet, TYPE_KINDS } from "../workspace/graph/workspace-graph.mjs";

const QUERY_MODES = new Set([
  "text", "symbol", "definition", "references", "imports", "callers", "callees", "type"
]);
const QUERY_DEPTHS = new Set(["fast", "auto", "semantic"]);
const SEMANTIC_PREFERRED_MODES = new Set(["references", "callers", "callees", "type"]);
const LOWERCASE_CONTENT_CACHE = new WeakMap();
const LOWERCASE_CONTENT_CACHE_MAX_RECORDS = 10_000;
const FAST_QUERY_CACHE_LIMIT = 32;

export class CodeQueryEngine {
  constructor({
    graph,
    semanticAdapters = {},
    confidenceThreshold = 0.75,
    astTimeoutMs = 800,
    semanticWarmTimeoutMs = 2_000,
    semanticColdTimeoutMs = 5_000
  } = {}) {
    if (!graph || typeof graph.ensureFresh !== "function") {
      throw new TypeError("CodeQueryEngine requires a WorkspaceGraph-compatible graph.");
    }
    this.graph = graph;
    this.semanticAdapters = semanticAdapters;
    this.confidenceThreshold = boundedNumber(confidenceThreshold, 0.75, 0, 1);
    this.astTimeoutMs = boundedInteger(astTimeoutMs, 800, 50, 30_000);
    this.semanticWarmTimeoutMs = boundedInteger(semanticWarmTimeoutMs, 2_000, 50, 30_000);
    this.semanticColdTimeoutMs = boundedInteger(semanticColdTimeoutMs, 5_000, 50, 60_000);
    this.fastQueryCache = new Map();
  }

  async query({
    query,
    mode = "text",
    depth = "auto",
    limit = 50,
    case_sensitive = false,
    refresh = false,
    max_files,
    max_depth,
    max_file_bytes,
    signal
  } = {}) {
    const needle = String(query || "").trim();
    if (!needle) throw new TypeError("code_query requires a non-empty query.");
    if (!QUERY_MODES.has(mode)) throw new TypeError(`Unsupported code_query mode: ${mode}`);
    if (!QUERY_DEPTHS.has(depth)) throw new TypeError(`Unsupported code_query depth: ${depth}`);
    const boundedLimit = boundedInteger(limit, 50, 1, 500);
    const started = performance.now();
    await this.graph.ensureFresh({
      force: Boolean(refresh),
      returnSnapshot: false,
      ...(max_files === undefined ? {} : { maxFiles: max_files }),
      ...(max_depth === undefined ? {} : { maxDepth: max_depth }),
      ...(max_file_bytes === undefined ? {} : { maxFileBytes: max_file_bytes })
    });

    const graphFreshnessBeforeQuery = this.graph.freshness();
    const cacheKey = depth === "fast" && !refresh && signal === undefined &&
      max_files === undefined && max_depth === undefined && max_file_bytes === undefined
      ? JSON.stringify([
          this.graph.generation,
          graphFreshnessBeforeQuery.state,
          graphFreshnessBeforeQuery.authoritative !== false,
          Boolean(this.graph.coverage?.complete),
          Boolean(this.graph.coverage?.content_complete),
          needle,
          mode,
          boundedLimit,
          Boolean(case_sensitive)
        ])
      : null;
    if (cacheKey) {
      const cached = this.fastQueryCache.get(cacheKey);
      if (cached) {
        // Refresh LRU order. The immutable evidence array is reused; only the
        // tiny response envelope is allocated for timing/freshness metadata.
        this.fastQueryCache.delete(cacheKey);
        this.fastQueryCache.set(cacheKey, cached);
        await yieldToEventLoop();
        return {
          ...cached,
          freshness: graphFreshnessBeforeQuery,
          cache_hit: true,
          timing_ms: roundMs(performance.now() - started)
        };
      }
    }

    const lexical = await runLexicalQuery(this.graph, {
      needle,
      mode,
      limit: boundedLimit,
      caseSensitive: Boolean(case_sensitive)
    });
    let results = lexical.results;
    let engine = lexical.engine;
    let confidence = lexical.confidence;
    let semanticComplete = false;
    let semanticRequested = false;
    let semanticUsed = false;
    let semanticTruncated = false;
    let fallbackReason = null;
    const semanticEngines = [];
    let semanticAttempted = 0;
    const shouldEscalate = depth === "semantic" ||
      (depth === "auto" && (confidence < this.confidenceThreshold || SEMANTIC_PREFERRED_MODES.has(mode)));

    if (shouldEscalate) {
      semanticRequested = true;
      const candidateLanguages = [...new Set(
        lexical.results.map((result) => result.language).filter(Boolean)
      )];
      const selection = selectSemanticAdapters(
        this.semanticAdapters,
        candidateLanguages.length ? candidateLanguages : this.graph.languages()
      );
      if (!selection.adapters.length) {
        fallbackReason = "semantic_adapter_unavailable";
      } else {
        semanticAttempted = selection.adapters.length;
        const semanticCalls = selection.adapters.map(({ adapter, languages }) => {
          const adapterTimeout = adapter.kind === "ast"
            ? this.astTimeoutMs
            : adapter.warm === false ? this.semanticColdTimeoutMs : this.semanticWarmTimeoutMs;
          return callSemanticAdapter(adapter, {
            graph: this.graph,
            query: needle,
            mode,
            limit: boundedLimit,
            languages,
            signal,
            timeoutMs: adapterTimeout
          }).then((outcome) => ({ outcome, languages }));
        });
        const settled = await Promise.all(semanticCalls);
        const fallbackReasons = [];
        let everyComplete = selection.uncovered.length === 0;
        if (selection.uncovered.length) {
          fallbackReasons.push(`semantic_adapter_unavailable_for:${selection.uncovered.join(",")}`);
        }
        for (const { outcome } of settled) {
          if (!outcome.ok) {
            everyComplete = false;
            fallbackReasons.push(outcome.reason);
            continue;
          }
          const normalized = normalizeSemanticResults(outcome.value, this.graph, mode, boundedLimit);
          semanticUsed = true;
          everyComplete &&= normalized.complete;
          semanticTruncated ||= normalized.truncated;
          results = mergeResults(results, normalized.results, boundedLimit);
          semanticEngines.push(normalized.engine || "semantic");
          if (normalized.complete || normalized.results.length) {
            confidence = Math.max(confidence, normalized.confidence);
          }
          if (normalized.fallbackReason) fallbackReasons.push(normalized.fallbackReason);
          else if (!normalized.complete) fallbackReasons.push("semantic_incomplete");
        }
        semanticComplete = semanticUsed && everyComplete && !semanticTruncated;
        if (semanticEngines.length) {
          const uniqueEngines = [...new Set(semanticEngines)];
          engine = lexical.results.length
            ? `lexical+${uniqueEngines.join("+")}`
            : uniqueEngines.join("+");
        }
        fallbackReason = fallbackReasons.length ? [...new Set(fallbackReasons)].join(";") : null;
      }
    }

    results = results.slice(0, boundedLimit);
    const graphFreshness = this.graph.freshness();
    const graphComplete = Boolean(this.graph.coverage?.complete);
    const contentComplete = Boolean(this.graph.coverage?.content_complete);
    const freshnessComplete = graphFreshness.authoritative !== false &&
      !["uninitialized", "invalidated", "stale", "degraded"].includes(graphFreshness.state);
    const resultTruncated = lexical.total > boundedLimit || semanticTruncated;
    const staticGraphComplete = lexical.staticGraphComplete;
    const complete = graphComplete &&
      contentComplete &&
      freshnessComplete &&
      staticGraphComplete &&
      !resultTruncated &&
      (!semanticRequested || semanticComplete);
    if (!complete) confidence = Math.min(confidence, semanticUsed ? 0.94 : 0.74);
    if (!staticGraphComplete) {
      fallbackReason = fallbackReason
        ? `${fallbackReason};unresolved_local_imports`
        : "unresolved_local_imports";
    }
    if (!freshnessComplete) {
      confidence = Math.min(confidence, 0.7);
      fallbackReason = fallbackReason
        ? `${fallbackReason};freshness_unverified`
        : "freshness_unverified";
    }

    // A warm lexical query can otherwise complete through microtasks only.
    // Yield once so a burst of many local calls cannot starve watcher, MCP,
    // cancellation, and telemetry callbacks on the event loop.
    await yieldToEventLoop();
    const response = {
      workspace_id: this.graph.workspaceId,
      query: { text: needle, mode, depth },
      engine,
      freshness: graphFreshness,
      completeness: {
        state: complete ? "complete" : "partial",
        graph_complete: graphComplete,
        content_complete: contentComplete,
        freshness_complete: freshnessComplete,
        result_truncated: resultTruncated,
        semantic_requested: semanticRequested,
        semantic_attempted: semanticAttempted,
        semantic_used: semanticUsed,
        semantic_complete: semanticComplete,
        semantic_engines: [...new Set(semanticEngines)],
        static_graph_complete: staticGraphComplete
      },
      confidence: roundConfidence(confidence),
      fallback_reason: fallbackReason,
      count: results.length,
      results: freezeEvidenceResults(results),
      cache_hit: false,
      timing_ms: roundMs(performance.now() - started)
    };
    if (cacheKey) {
      this.fastQueryCache.set(cacheKey, response);
      while (this.fastQueryCache.size > FAST_QUERY_CACHE_LIMIT) {
        this.fastQueryCache.delete(this.fastQueryCache.keys().next().value);
      }
    }
    return response;
  }
}

export async function codeQuery(graph, input, options = {}) {
  const engine = new CodeQueryEngine({ graph, ...options });
  return engine.query(input);
}

async function runLexicalQuery(graph, { needle, mode, limit, caseSensitive }) {
  let matches;
  let total = null;
  let hasExact = null;
  if (mode === "text") {
    const packed = typeof graph.collectTextMatches === "function"
      ? await graph.collectTextMatches({ needle, caseSensitive, limit })
      : null;
    const collected = packed || await textMatches(
      graph,
      graph.getRecords(),
      needle,
      caseSensitive,
      limit
    );
    matches = collected.matches;
    total = collected.total;
    hasExact = collected.hasExact;
  } else {
    const records = typeof graph.iterateRecords === "function"
      ? graph.iterateRecords()
      : graph.getRecords();
    if (mode === "symbol" || mode === "definition" || mode === "type") {
      matches = await symbolMatches(graph, records, needle, mode, caseSensitive);
    } else if (mode === "references") {
      matches = await referenceMatches(graph, records, needle, caseSensitive);
    } else if (mode === "imports") {
      matches = await importMatches(graph, records, needle, caseSensitive);
    } else if (mode === "callers") {
      matches = await callerMatches(graph, records, needle, caseSensitive);
    } else {
      matches = await calleeMatches(graph, records, needle, caseSensitive);
    }
  }
  const graphAwareMode = ["definition", "references", "callers", "callees"].includes(mode);
  if (graphAwareMode) matches = await enrichWithDefinitionEvidence(graph, matches);
  matches.sort(compareMatches);
  const dependencyGraph = graphAwareMode && typeof graph.dependencyGraph === "function"
    ? graph.dependencyGraph()
    : null;
  return {
    results: matches.slice(0, limit),
    total: total ?? matches.length,
    confidence: lexicalConfidence(mode, matches, graph.coverage, hasExact),
    engine: matches.some((match) => match.resolution?.engine === "dependency_graph")
      ? "lexical+dependency_graph"
      : "lexical",
    staticGraphComplete: !dependencyGraph || dependencyGraph.unresolved_local_imports.length === 0
  };
}

async function enrichWithDefinitionEvidence(graph, matches) {
  if (typeof graph.definitionCandidates !== "function") return matches;
  const enriched = [];
  let lastYield = performance.now();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const filePath = match.location?.path;
    const symbolName = match.kind === "caller"
      ? String(match.calls || "").split(".").pop()
      : match.kind === "callee" ? match.name : match.name;
    if (!filePath || !symbolName) {
      enriched.push(match);
      if ((index + 1) % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
      continue;
    }
    const candidates = graph.definitionCandidates(filePath, symbolName);
    if (candidates.length !== 1) {
      enriched.push(match);
      if ((index + 1) % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
      continue;
    }
    const candidate = candidates[0];
    const graphScore = candidate.source === "static_import"
      ? 0.91
      : candidate.source === "same_file" ? 0.89 : 0.8;
    enriched.push({
      ...match,
      definition: candidate.location,
      resolution: {
        engine: candidate.source === "static_import"
          ? "dependency_graph"
          : "lexical_symbol_table",
        source: candidate.source,
        confidence: graphScore
      },
      score: Math.max(Number(match.score || 0), graphScore)
    });
    if ((index + 1) % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
  }
  return enriched;
}

async function textMatches(graph, records, needle, caseSensitive, limit) {
  const expected = normalizeCase(needle, caseSensitive);
  // Per-record lowercase caching is a large win on ordinary repositories, but
  // a 100k-file graph turns WeakMap metadata and retained lowercase strings
  // into a permanent double-digit-MB tax. Large scans trade a little CPU for a
  // bounded steady-state heap instead.
  const cacheLowercaseContent = !caseSensitive && records.length <= LOWERCASE_CONTENT_CACHE_MAX_RECORDS;
  const output = [];
  let total = 0;
  let hasExact = false;
  let worstIndex = -1;
  let lastYield = performance.now();
  let occurrenceCount = 0;
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex];
    if (!record.content) continue;
    const source = record.content;
    let haystack = source;
    if (!caseSensitive) {
      haystack = cacheLowercaseContent ? LOWERCASE_CONTENT_CACHE.get(record) : undefined;
      if (haystack === undefined) {
        haystack = source.toLowerCase();
        if (cacheLowercaseContent) LOWERCASE_CONTENT_CACHE.set(record, haystack);
      }
    }
    let cursor = haystack.indexOf(expected);
    let line = 1;
    let lineStart = 0;
    let nextNewline = haystack.indexOf("\n");
    while (cursor >= 0) {
      while (nextNewline >= 0 && nextNewline < cursor) {
        line++;
        lineStart = nextNewline + 1;
        nextNewline = haystack.indexOf("\n", lineStart);
      }
      const lineEnd = nextNewline >= 0 ? nextNewline : source.length;
      const rawLineWithCarriageReturn = source.slice(lineStart, lineEnd);
      const rawLine = rawLineWithCarriageReturn.endsWith("\r")
        ? rawLineWithCarriageReturn.slice(0, -1)
        : rawLineWithCarriageReturn;
      const score = normalizeCase(rawLine, caseSensitive) === expected ? 1 : 0.8;
      total++;
      hasExact ||= score === 1;
      const rank = { score, path: record.path, line };
      if (
        output.length < limit ||
        (worstIndex >= 0 && compareRankToMatch(rank, output[worstIndex]) < 0)
      ) {
        const selected = {
          kind: "text",
          location: location(graph, record, line, cursor - lineStart + 1),
          snippet: rawLine.trim().slice(0, 500),
          language: record.language,
          score
        };
        if (output.length < limit) output.push(selected);
        else output[worstIndex] = selected;
        worstIndex = output.length === limit ? findWorstMatchIndex(output) : -1;
      }
      cursor = haystack.indexOf(expected, cursor + Math.max(1, expected.length));
      occurrenceCount++;
      if (occurrenceCount % 1_024 === 0) {
        lastYield = await yieldScanIfDue(lastYield);
      }
    }
    if ((recordIndex + 1) % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
  }
  return { matches: output, total, hasExact };
}

async function symbolMatches(graph, records, needle, mode, caseSensitive) {
  const expected = normalizeCase(needle, caseSensitive);
  const output = [];
  let lastYield = performance.now();
  let recordIndex = 0;
  for (const record of records) {
    for (const symbol of record.symbols) {
      if (mode === "type" && !TYPE_KINDS.has(symbol.kind)) continue;
      const actual = normalizeCase(symbol.name, caseSensitive);
      if (!actual.includes(expected) && !expected.includes(actual)) continue;
      const exact = actual === expected;
      output.push({
        kind: mode === "symbol" ? "symbol" : mode,
        name: symbol.name,
        symbol_kind: symbol.kind,
        location: location(graph, record, symbol.line, symbol.column),
        signature: recordLineSnippet(record, symbol.line, 300),
        language: record.language,
        score: exact ? 1 : actual.startsWith(expected) ? 0.86 : 0.68
      });
    }
    recordIndex++;
    if (recordIndex % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
  }
  return output;
}

async function referenceMatches(graph, records, needle, caseSensitive) {
  const output = [];
  const regex = identifierRegex(needle, caseSensitive);
  let lastYield = performance.now();
  let recordIndex = 0;
  for (const record of records) {
    if (!record.content) {
      recordIndex++;
      if (recordIndex % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
      continue;
    }
    const definitions = new Set(record.symbols
      .filter((symbol) => equalText(symbol.name, needle, caseSensitive))
      .map((symbol) => `${symbol.line}:${symbol.column}`));
    const lines = record.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(lines[index]))) {
        const column = match.index + 1;
        if (definitions.has(`${index + 1}:${column}`)) continue;
        output.push({
          kind: "reference",
          name: match[0],
          location: location(graph, record, index + 1, column),
          snippet: lines[index].trim().slice(0, 500),
          language: record.language,
          score: match[0] === needle ? 0.8 : 0.7
        });
        if (!match[0].length) regex.lastIndex++;
      }
    }
    recordIndex++;
    if (recordIndex % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
  }
  return output;
}

async function importMatches(graph, records, needle, caseSensitive) {
  const output = [];
  let lastYield = performance.now();
  let recordIndex = 0;
  for (const record of records) {
    for (const imported of record.imports) {
      const moduleMatch = includesText(imported.module, needle, caseSensitive);
      const nameMatch = imported.names.find((name) => includesText(name, needle, caseSensitive));
      if (!moduleMatch && !nameMatch) continue;
      output.push({
        kind: "import",
        module: imported.module,
        imported_names: imported.names,
        matched_name: nameMatch || null,
        location: location(graph, record, imported.line, imported.column),
        snippet: imported.raw,
        language: record.language,
        score: equalText(imported.module, needle, caseSensitive) || equalText(nameMatch, needle, caseSensitive) ? 1 : 0.78
      });
    }
    recordIndex++;
    if (recordIndex % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
  }
  return output;
}

async function callerMatches(graph, records, needle, caseSensitive) {
  const output = [];
  let lastYield = performance.now();
  let recordIndex = 0;
  for (const record of records) {
    for (const call of record.calls) {
      if (!equalText(call.name, needle, caseSensitive) && !equalText(call.expression, needle, caseSensitive)) continue;
      const owner = nearestOwner(record.symbols, call.line);
      output.push({
        kind: "caller",
        name: owner?.name || "<module>",
        symbol_kind: owner?.kind || "module",
        calls: call.expression,
        location: location(graph, record, call.line, call.column),
        definition: owner
          ? location(graph, record, owner.line, owner.column)
          : location(graph, record, 1, 1),
        language: record.language,
        score: owner ? 0.75 : 0.6
      });
    }
    recordIndex++;
    if (recordIndex % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
  }
  return output;
}

async function calleeMatches(graph, records, needle, caseSensitive) {
  const output = [];
  let lastYield = performance.now();
  let recordIndex = 0;
  for (const record of records) {
    const ordered = [...record.symbols].sort((a, b) => a.line - b.line || a.column - b.column);
    for (let symbolIndex = 0; symbolIndex < ordered.length; symbolIndex++) {
      const symbol = ordered[symbolIndex];
      if (!equalText(symbol.name, needle, caseSensitive)) continue;
      const nextOwner = ordered.slice(symbolIndex + 1).find((candidate) =>
        candidate.line > symbol.line && ["function", "method"].includes(candidate.kind)
      );
      const endLine = nextOwner?.line ?? Number.MAX_SAFE_INTEGER;
      for (const call of record.calls) {
        if (call.line < symbol.line || call.line >= endLine) continue;
        output.push({
          kind: "callee",
          name: call.name,
          expression: call.expression,
          owner: symbol.name,
          location: location(graph, record, call.line, call.column),
          owner_definition: location(graph, record, symbol.line, symbol.column),
          language: record.language,
          score: 0.7
        });
      }
    }
    recordIndex++;
    if (recordIndex % 256 === 0) lastYield = await yieldScanIfDue(lastYield);
  }
  return deduplicate(output);
}

async function yieldScanIfDue(lastYield) {
  const now = performance.now();
  if (now - lastYield < 6) return lastYield;
  await yieldToEventLoop();
  return performance.now();
}

function nearestOwner(symbols, line) {
  return [...symbols]
    .filter((symbol) => symbol.line <= line && ["function", "method"].includes(symbol.kind))
    .sort((a, b) => b.line - a.line || b.column - a.column)[0] || null;
}

function lexicalConfidence(mode, matches, coverage, knownExact = null) {
  const exact = knownExact ?? matches.some((match) => match.score >= 0.99);
  let confidence;
  if (!matches.length) confidence = 0.25;
  else if (mode === "text") confidence = exact ? 0.95 : 0.86;
  else if (mode === "symbol" || mode === "definition") confidence = exact ? 0.93 : 0.72;
  else if (mode === "imports") confidence = exact ? 0.92 : 0.82;
  else if (mode === "type") confidence = exact ? 0.82 : 0.68;
  else confidence = exact ? 0.72 : 0.62;
  if (!coverage?.complete || !coverage?.content_complete) confidence = Math.min(confidence, 0.7);
  return confidence;
}

function selectSemanticAdapters(adapters, languages) {
  if (!adapters) return { adapters: [], uncovered: [...languages] };
  if (typeof adapters.query === "function") {
    return { adapters: [{ adapter: adapters, languages: [...languages] }], uncovered: [] };
  }
  const read = (language) => adapters instanceof Map ? adapters.get(language) : adapters[language];
  const wildcard = read("*");
  if (!languages.length && wildcard && typeof wildcard.query === "function") {
    return { adapters: [{ adapter: wildcard, languages: ["*"] }], uncovered: [] };
  }
  const selected = new Map();
  const uncovered = [];
  for (const language of languages) {
    const adapter = read(language) || wildcard;
    if (!adapter || typeof adapter.query !== "function") {
      uncovered.push(language);
      continue;
    }
    const entry = selected.get(adapter) || { adapter, languages: [] };
    entry.languages.push(language);
    selected.set(adapter, entry);
  }
  return { adapters: [...selected.values()], uncovered };
}

async function callSemanticAdapter(adapter, { graph, query, mode, limit, languages, signal, timeoutMs }) {
  if (signal?.aborted) return { ok: false, reason: "semantic_cancelled" };
  const controller = new AbortController();
  let resolveCancellation;
  const cancellation = new Promise((resolve) => {
    resolveCancellation = resolve;
  });
  const forwardAbort = () => {
    controller.abort(signal?.reason);
    resolveCancellation({ cancelled: true });
  };
  signal?.addEventListener?.("abort", forwardAbort, { once: true });
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("semantic query timeout"));
        resolve({ timedOut: true });
      }, timeoutMs);
      timer.unref?.();
    });
    const invoked = Promise.resolve(adapter.query({
      workspace_id: graph.workspaceId,
      root_dir: graph.rootDir,
      graph,
      query,
      mode,
      limit,
      languages,
      signal: controller.signal
    })).then((value) => ({ value }), (error) => ({ error }));
    const settled = await Promise.race([invoked, timeout, cancellation]);
    if (settled.timedOut) return { ok: false, reason: "semantic_timeout" };
    if (settled.cancelled) return { ok: false, reason: "semantic_cancelled" };
    if (settled.error) return { ok: false, reason: `semantic_adapter_failed:${safeErrorCode(settled.error)}` };
    return { ok: true, value: settled.value };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", forwardAbort);
  }
}

function normalizeSemanticResults(value, graph, mode, limit) {
  const pack = Array.isArray(value) ? { results: value } : (value || {});
  const results = [];
  for (const raw of Array.isArray(pack.results) ? pack.results : []) {
    const normalizedLocation = normalizeAdapterLocation(raw.location || raw, graph);
    if (!normalizedLocation) continue;
    const selected = selectSemanticFields(raw);
    results.push({
      ...selected,
      kind: selected.kind || mode,
      location: normalizedLocation,
      score: boundedNumber(raw.score, 0.95, 0, 1)
    });
  }
  return {
    results,
    complete: pack.complete === true,
    confidence: boundedNumber(pack.confidence, results.length ? 0.95 : 0.5, 0, 1),
    engine: String(pack.engine || "semantic"),
    fallbackReason: pack.fallback_reason ? String(pack.fallback_reason) : null,
    truncated: pack.truncated === true ||
      (Number.isFinite(pack.total) && Number(pack.total) > results.length) ||
      results.length > limit
  };
}

function selectSemanticFields(raw) {
  const selected = {};
  for (const key of [
    "kind", "name", "symbol_kind", "signature", "snippet", "language",
    "detail", "owner", "module", "expression"
  ]) {
    if (typeof raw?.[key] === "string") selected[key] = raw[key].slice(0, key === "snippet" ? 1_000 : 500);
  }
  return selected;
}

function normalizeAdapterLocation(raw, graph) {
  let relativePath = String(raw?.path || "");
  if (!relativePath) return null;
  if (path.isAbsolute(relativePath)) {
    relativePath = path.relative(graph.rootDir, relativePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  }
  relativePath = relativePath.split(path.sep).join("/").replace(/^\.\/+/, "");
  if (!relativePath || relativePath.split("/").includes("..")) return null;
  if (typeof graph.getRecord === "function" && !graph.getRecord(relativePath)) return null;
  return {
    workspace_id: graph.workspaceId,
    path: relativePath,
    line: boundedInteger(raw.line, 1, 1, Number.MAX_SAFE_INTEGER),
    column: boundedInteger(raw.column, 1, 1, Number.MAX_SAFE_INTEGER)
  };
}

function mergeResults(lexical, semantic, limit) {
  const combined = deduplicate([...semantic, ...lexical]);
  combined.sort(compareMatches);
  return combined.slice(0, limit);
}

function freezeEvidenceResults(results) {
  for (const result of results) {
    if (result.location && !Object.isFrozen(result.location)) Object.freeze(result.location);
    if (result.definition && !Object.isFrozen(result.definition)) Object.freeze(result.definition);
    if (result.owner_definition && !Object.isFrozen(result.owner_definition)) Object.freeze(result.owner_definition);
    if (result.resolution && !Object.isFrozen(result.resolution)) Object.freeze(result.resolution);
    if (Array.isArray(result.imported_names) && !Object.isFrozen(result.imported_names)) Object.freeze(result.imported_names);
    if (!Object.isFrozen(result)) Object.freeze(result);
  }
  return Object.freeze(results);
}

function deduplicate(results) {
  const seen = new Set();
  return results.filter((result) => {
    const place = result.location || {};
    const key = `${result.kind}:${result.name || ""}:${place.path || ""}:${place.line || 0}:${place.column || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareMatches(a, b) {
  return Number(b.score || 0) - Number(a.score || 0) ||
    String(a.location?.path || "").localeCompare(String(b.location?.path || "")) ||
    Number(a.location?.line || 0) - Number(b.location?.line || 0);
}

function compareRankToMatch(rank, match) {
  return Number(match.score || 0) - Number(rank.score || 0) ||
    String(rank.path || "").localeCompare(String(match.location?.path || "")) ||
    Number(rank.line || 0) - Number(match.location?.line || 0);
}

function findWorstMatchIndex(matches) {
  let worst = 0;
  for (let index = 1; index < matches.length; index++) {
    if (compareMatches(matches[index], matches[worst]) > 0) worst = index;
  }
  return worst;
}

function location(graph, record, line, column) {
  return {
    workspace_id: graph.workspaceId,
    path: record.path,
    line,
    column
  };
}

function identifierRegex(value, caseSensitive) {
  const escaped = escapeRegExp(value);
  const identifier = /^[A-Za-z_$][\w$]*$/.test(value);
  return new RegExp(identifier ? `\\b${escaped}\\b` : escaped, caseSensitive ? "g" : "gi");
}

function includesText(value, needle, caseSensitive) {
  return normalizeCase(value, caseSensitive).includes(normalizeCase(needle, caseSensitive));
}

function equalText(value, expected, caseSensitive) {
  if (value === null || value === undefined) return false;
  return normalizeCase(value, caseSensitive) === normalizeCase(expected, caseSensitive);
}

function normalizeCase(value, caseSensitive) {
  const text = String(value || "");
  return caseSensitive ? text : text.toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeErrorCode(error) {
  return String(error?.code || error?.name || "ERROR").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function boundedInteger(value, fallback, min, max) {
  return Math.trunc(boundedNumber(value, fallback, min, max));
}

function roundConfidence(value) {
  return Math.round(boundedNumber(value, 0, 0, 1) * 1000) / 1000;
}

function roundMs(value) {
  return Math.max(0, Math.round(Number(value || 0) * 10) / 10);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export { QUERY_DEPTHS, QUERY_MODES };
