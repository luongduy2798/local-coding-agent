// Local Coding Agent workspace graph text search.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import {
  comparePackedRankToMatch,
  escapeRipgrepGlob,
  findWorstPackedMatchIndex
} from "./packed-store.mjs";
import {
  boundedInteger,
  countLinesThrough,
  detectLanguage,
  normalizeRelativePath
} from "./scanner.mjs";
import { yieldToEventLoop } from "./freshness.mjs";

export async function collectWorkspaceTextMatches({
  rootDir,
  workspaceId,
  records,
  skipDirs,
  needle,
  caseSensitive,
  limit
}) {
  const state = {
    workspaceId,
    records,
    expected: caseSensitive ? needle : needle.toLowerCase(),
    caseSensitive,
    limit,
    output: [],
    total: 0,
    hasExact: false,
    worstIndex: -1,
    seen: new Set()
  };
  const common = { rootDir, skipDirs, needle, caseSensitive, state };
  const exact = await runRipgrepTextPhase({ ...common, wholeLine: true });
  if (!exact.available) {
    return collectWorkspaceTextMatchesFallback(state);
  }
  if (!exact.truncated) {
    const general = await runRipgrepTextPhase({ ...common, wholeLine: false });
    if (!general.available) return collectWorkspaceTextMatchesFallback(state);
  }
  return {
    matches: state.output,
    total: state.total,
    hasExact: state.hasExact
  };
}

export function runRipgrepTextPhase({
  rootDir,
  skipDirs,
  needle,
  caseSensitive,
  state,
  wholeLine
}) {
  return new Promise((resolve) => {
    const args = [
      "--json",
      "--fixed-strings",
      "--sort",
      "path",
      "--hidden",
      "--no-ignore",
      "--no-messages",
      caseSensitive ? "--case-sensitive" : "--ignore-case",
      ...(wholeLine ? ["--line-regexp"] : []),
      ...[...skipDirs].flatMap((directory) => [
        "--glob",
        `!**/${escapeRipgrepGlob(directory)}/**`
      ]),
      "--",
      needle,
      "."
    ];
    const child = spawn("rg", args, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let carry = "";
    let settled = false;
    let stopped = false;
    let stderr = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const consumeLine = (line) => {
      if (!line || stopped) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type !== "match") return;
      addRipgrepMatchEvent(state, event.data, wholeLine);
      if (state.total > state.limit) {
        stopped = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      carry += chunk;
      let newline;
      while (!stopped && (newline = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        consumeLine(line);
      }
      if (carry.length > 2 * 1024 * 1024) carry = "";
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length);
    });
    child.once("error", () => finish({ available: false, truncated: false }));
    child.once("close", (code, signal) => {
      if (!stopped && carry) consumeLine(carry);
      const normal = code === 0 || code === 1;
      finish({
        available: stopped || (normal && !signal && !stderr.trim()),
        truncated: stopped
      });
    });
  });
}

export function addRipgrepMatchEvent(state, data, wholeLine) {
  let relativePath;
  try {
    relativePath = normalizeRelativePath(data?.path?.text);
  } catch {
    return;
  }
  if (!relativePath || !state.records.has(relativePath)) return;
  const sourceLine = String(data?.lines?.text || "").replace(/\n$/, "").replace(/\r$/, "");
  const line = boundedInteger(data?.line_number, 1, 1, Number.MAX_SAFE_INTEGER);
  const language = state.records.getLanguage(relativePath) || detectLanguage(relativePath, sourceLine);
  const submatches = Array.isArray(data?.submatches) ? data.submatches : [];
  for (const submatch of submatches) {
    const byteColumn = boundedInteger(submatch?.start, 0, 0, Buffer.byteLength(sourceLine));
    const column = /^[\x00-\x7f]*$/.test(sourceLine.slice(0, byteColumn))
      ? byteColumn + 1
      : Buffer.from(sourceLine).subarray(0, byteColumn).toString("utf8").length + 1;
    const key = `${relativePath}\0${line}\0${column}`;
    if (state.seen.has(key)) continue;
    state.seen.add(key);
    const exact = wholeLine || (state.caseSensitive ? sourceLine : sourceLine.toLowerCase()) === state.expected;
    const score = exact ? 1 : 0.8;
    state.total++;
    state.hasExact ||= exact;
    const rank = { score, path: relativePath, line };
    if (
      state.output.length < state.limit ||
      (state.worstIndex >= 0 && comparePackedRankToMatch(rank, state.output[state.worstIndex]) < 0)
    ) {
      const selected = {
        kind: "text",
        location: {
          workspace_id: state.workspaceId,
          path: relativePath,
          line,
          column
        },
        snippet: sourceLine.trim().slice(0, 500),
        language,
        score
      };
      if (state.output.length < state.limit) state.output.push(selected);
      else state.output[state.worstIndex] = selected;
      state.worstIndex = state.output.length === state.limit
        ? findWorstPackedMatchIndex(state.output)
        : -1;
    }
    if (state.total > state.limit) return;
  }
}

export async function collectWorkspaceTextMatchesFallback(state) {
  state.output = [];
  state.total = 0;
  state.hasExact = false;
  state.worstIndex = -1;
  state.seen.clear();
  let scanned = 0;
  for (const record of state.records.values()) {
    appendRankedRecordTextMatches(record, state);
    scanned++;
    if (scanned % 256 === 0) await yieldToEventLoop();
  }
  return {
    matches: state.output,
    total: state.total,
    hasExact: state.hasExact
  };
}

export function appendRankedRecordTextMatches(record, state) {
  const source = record.content;
  if (!source) return;
  const haystack = state.caseSensitive ? source : source.toLowerCase();
  let cursor = haystack.indexOf(state.expected);
  while (cursor >= 0) {
    const lineStart = haystack.lastIndexOf("\n", cursor - 1) + 1;
    const nextNewline = haystack.indexOf("\n", cursor);
    const lineEnd = nextNewline < 0 ? source.length : nextNewline;
    const rawLine = source.slice(lineStart, lineEnd).replace(/\r$/, "");
    const line = countLinesThrough(source, cursor);
    addRipgrepMatchEvent(state, {
      path: { text: record.path },
      lines: { text: rawLine },
      line_number: line,
      submatches: [{ start: Buffer.byteLength(source.slice(lineStart, cursor)) }]
    }, false);
    cursor = haystack.indexOf(state.expected, cursor + Math.max(1, state.expected.length));
  }
}

export function cloneTextMatchCollection(value) {
  return {
    matches: value.matches.map((match) => ({
      ...match,
      location: { ...match.location }
    })),
    total: value.total,
    hasExact: value.hasExact
  };
}
