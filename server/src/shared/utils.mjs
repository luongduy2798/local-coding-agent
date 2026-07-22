// Local Coding Agent shared pure utilities
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

let MCP_REQUEST_CONTEXT = null;

export function configureSharedUtils({ requestContext }) {
  MCP_REQUEST_CONTEXT = requestContext;
}

export function dedupe(arr) {
  return [...new Set(arr)];
}

export function boundedNumber(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
  return !result.error;
}

export function comparePath(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

export function isoNow() {
  return new Date().toISOString();
}

export function appendLimited(current, next, max) {
  const combined = current + next;
  if (combined.length <= max) return combined;
  return combined.slice(combined.length - max);
}

export function trimOutputPair(rawStdout, rawStderr, { tail_lines, head_lines, max_chars }) {
  let stdout = trimOutput(rawStdout, { tail_lines, head_lines, max_chars });
  let stderr = trimOutput(rawStderr, { tail_lines, head_lines, max_chars });
  const budget = Math.max(0, max_chars || 0);
  if (stdout.length + stderr.length > budget) {
    const stderrBudget = Math.min(stderr.length, Math.max(Math.floor(budget * 0.4), Math.min(stderr.length, budget)));
    const stdoutBudget = Math.max(0, budget - stderrBudget);
    stdout = stdout.slice(0, stdoutBudget);
    stderr = stderr.slice(0, Math.max(0, budget - stdout.length));
  }
  return { stdout, stderr };
}

export function trimOutput(s, { tail_lines, head_lines, max_chars }) {
  if (!s) return s;
  if (head_lines || tail_lines) {
    const lines = s.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // drop trailing newline's empty line
    const picked = head_lines ? lines.slice(0, head_lines) : lines.slice(-tail_lines);
    const out = picked.join("\n");
    return out.length > max_chars ? out.slice(0, max_chars) : out;
  }
  return s.length > max_chars ? s.slice(0, max_chars) : s;
}

export function textResult(text) {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value) {
  const started = performance.now();
  const serialized = JSON.stringify(value);
  const requestMetrics = MCP_REQUEST_CONTEXT?.getStore();
  if (requestMetrics) requestMetrics.serializationMs = roundMs(performance.now() - started);
  return textResult(serialized);
}

export function resultBytes(result) {
  try {
    return Buffer.byteLength(JSON.stringify(result), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function truncateUtf8(value, maxBytes) {
  const source = Buffer.from(String(value || ""), "utf8");
  if (source.byteLength <= maxBytes) return source.toString("utf8");
  return source.subarray(0, Math.max(0, maxBytes)).toString("utf8");
}

export function fitJsonItems(items, maxChars) {
  const source = Array.isArray(items) ? items : [];
  const budget = Math.max(100, Number(maxChars) || 100);
  const selected = [];
  let chars = 2;
  for (const item of source) {
    const serialized = JSON.stringify(item);
    const cost = serialized.length + (selected.length ? 1 : 0);
    if (selected.length && chars + cost > budget) break;
    if (!selected.length && chars + cost > budget) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const compact = { ...item };
        for (const key of ["snippet", "content", "text"]) {
          if (typeof compact[key] === "string") compact[key] = compact[key].slice(0, Math.max(100, budget - 500));
        }
        selected.push(compact);
        chars += JSON.stringify(compact).length;
      }
      break;
    }
    selected.push(item);
    chars += cost;
  }
  return { items: selected, chars, truncated: selected.length < source.length };
}

export function roundMs(value) {
  return Math.max(0, Math.round(Number(value || 0) * 10) / 10);
}

export function finiteMetric(value) {
  return Number.isFinite(value) ? roundMs(value) : 0;
}

export async function atomicWriteJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

export function firstText(result) {
  try {
    return result?.content?.[0]?.text || "";
  } catch {
    return "";
  }
}

export function resultLen(result) {
  try {
    let n = 0;
    for (const c of result?.content || []) n += (c?.text || "").length;
    return n;
  } catch {
    return 0;
  }
}
