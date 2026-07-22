// Local Coding Agent change journal contract.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const JOURNAL_SCHEMA_VERSION = 4;
export const DEFAULT_MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export class ChangeJournalError extends Error {
  constructor(code, message, details = {}, statusCode = 400) {
    super(message);
    this.name = "ChangeJournalError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      error: this.code,
      code: this.code,
      message: this.message,
      ...this.details
    };
  }
}
