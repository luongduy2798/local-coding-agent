// Local Coding Agent patch transaction contract.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PATCH_MANIFEST_VERSION = 1;
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export class PatchTransactionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PatchTransactionError";
    this.code = code;
    this.details = details;
  }
}
