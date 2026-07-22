// Local Coding Agent signed pagination cursors
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, timingSafeEqual } from "node:crypto";

let PAGE_CURSOR_SECRET;
let MAX_PAGE_OFFSET;

export function configurePagination({ pageCursorSecret, maxPageOffset }) {
  PAGE_CURSOR_SECRET = pageCursorSecret;
  MAX_PAGE_OFFSET = maxPageOffset;
}

export function pageScope(kind, value) {
  return createHash("sha256")
    .update(String(kind))
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function encodePageCursor({ kind, scope, offset }) {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    kind: String(kind),
    scope: String(scope),
    offset: Math.max(0, Math.trunc(Number(offset) || 0))
  })).toString("base64url");
  const signature = createHash("sha256")
    .update(PAGE_CURSOR_SECRET)
    .update("\0")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function decodePageCursor(cursor, { kind, scope }) {
  if (!cursor) return 0;
  const source = String(cursor);
  if (source.length > 2_048) throw invalidPageCursor();
  const [payload, signature, extra] = source.split(".");
  if (!payload || !signature || extra !== undefined) throw invalidPageCursor();
  const expected = createHash("sha256")
    .update(PAGE_CURSOR_SECRET)
    .update("\0")
    .update(payload)
    .digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw invalidPageCursor();
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidPageCursor();
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw invalidPageCursor();
  }
  const offset = Number(decoded?.offset);
  if (
    decoded?.version !== 1 ||
    decoded?.kind !== kind ||
    decoded?.scope !== scope ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_PAGE_OFFSET
  ) throw invalidPageCursor();
  return offset;
}

export function invalidPageCursor() {
  const error = new Error("Cursor is invalid, stale, or belongs to a different query.");
  error.code = "INVALID_CURSOR";
  return error;
}

export function pageMetadata({ kind, scope, offset, limit, returned, hasMore, windowExhausted = false }) {
  const nextOffset = offset + returned;
  return {
    offset,
    limit,
    returned,
    has_more: Boolean(hasMore),
    next_cursor: hasMore && returned > 0 && nextOffset <= MAX_PAGE_OFFSET
      ? encodePageCursor({ kind, scope, offset: nextOffset })
      : null,
    ...(windowExhausted ? { window_exhausted: true } : {})
  };
}

export function historyPagination(history, { scope }) {
  const pagination = history?.pagination || {};
  return pageMetadata({
    kind: "change_history",
    scope,
    offset: Number(pagination.offset || 0),
    limit: Number(pagination.limit || 50),
    returned: Number(pagination.returned ?? history?.changes?.length ?? 0),
    hasMore: pagination.has_more === true
  });
}
