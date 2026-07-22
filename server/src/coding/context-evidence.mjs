// Local Coding Agent focused context evidence helpers
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

let DEFAULT_RESPONSE_CHARS = 64 * 1024;

export function configureContextEvidence({ defaultResponseChars }) {
  DEFAULT_RESPONSE_CHARS = defaultResponseChars;
}

export function tokenizeSearch(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[\s\\/_.:-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export async function focusedWorkspaceEvidence(queryEngine, focus, { refresh = false, limit = 40 } = {}) {
  const requestedFocus = String(focus || "").trim();
  if (!requestedFocus) return null;
  let evidence = await queryEngine.query({
    query: requestedFocus,
    mode: "text",
    depth: "fast",
    limit,
    refresh
  });
  if (evidence.count > 0) return { requested_focus: requestedFocus, ...evidence };

  const generic = new Set([
    "a", "an", "and", "class", "code", "file", "for", "function", "in",
    "method", "module", "of", "on", "or", "the", "to", "with"
  ]);
  const candidates = tokenizeSearch(requestedFocus)
    .filter((token) => token.length >= 3 && !generic.has(token))
    .sort((left, right) => right.length - left.length)
    .slice(0, 4);
  for (const candidate of candidates) {
    evidence = await queryEngine.query({
      query: candidate,
      mode: "text",
      depth: "fast",
      limit,
      refresh: false
    });
    if (evidence.count > 0) {
      return {
        requested_focus: requestedFocus,
        focus_fallback: candidate,
        ...evidence
      };
    }
  }
  return { requested_focus: requestedFocus, ...evidence };
}

export function compactWorkspaceSnapshotForBudget(snapshot, requestedChars) {
  const requested = Number(requestedChars || 0);
  if (!Number.isFinite(requested) || requested <= 0 || requested >= DEFAULT_RESPONSE_CHARS) {
    return snapshot;
  }
  const targetBytes = Math.max(1_500, requested - 1_500);
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= targetBytes) return snapshot;

  const compact = {
    ...snapshot,
    response_compacted: true,
    tree: snapshot.tree ? {
      ...snapshot.tree,
      entries: (snapshot.tree.entries || []).slice(0, 24)
    } : undefined,
    important_files: (snapshot.important_files || []).slice(0, 12),
    recommended_reads: (snapshot.recommended_reads || []).slice(0, 8),
    symbols: snapshot.symbols?.slice(0, 16),
    evidence: snapshot.evidence ? {
      ...snapshot.evidence,
      results: (snapshot.evidence.results || []).slice(0, 10)
    } : undefined,
    graph: snapshot.graph ? {
      workspace_id: snapshot.graph.workspace_id,
      generation: snapshot.graph.generation,
      freshness: snapshot.graph.freshness,
      coverage: snapshot.graph.coverage,
      counts: snapshot.graph.counts
    } : undefined
  };
  delete compact.workflow_hints;
  delete compact.next_best_actions;
  delete compact.ripgrep;
  delete compact.cache;
  if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= targetBytes) return compact;

  if (compact.evidence?.results) compact.evidence.results = compact.evidence.results.slice(0, 4);
  if (compact.tree?.entries) compact.tree.entries = compact.tree.entries.slice(0, 10);
  compact.important_files = compact.important_files.slice(0, 5);
  compact.recommended_reads = compact.recommended_reads.slice(0, 4);
  delete compact.symbols;
  delete compact.git;
  if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= targetBytes) return compact;

  // Focused calls prioritize the requested evidence over general repository
  // decoration when the caller chooses a very small response budget.
  if (compact.evidence) {
    return {
      kind: compact.kind,
      workspace_id: compact.workspace_id,
      version: compact.version,
      root: compact.root,
      response_compacted: true,
      omitted: ["profile", "tree", "git", "graph", "recommendations"],
      evidence: compact.evidence
    };
  }
  return compact;
}
