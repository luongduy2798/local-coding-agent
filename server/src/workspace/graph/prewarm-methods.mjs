// Local Coding Agent workspace graph prewarm adoption.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  persistenceError,
  validateExternalPrewarmReceipt
} from "./persistence.mjs";
import { boundedInteger } from "./scanner.mjs";

export class WorkspaceGraphPrewarmMethods {
  async prewarm(options = {}) {
    this._assertOpen();
    return this._runExclusive(async () => {
      await this._initializeNow();
      const snapshot = await this._ensureFreshNow(options);
      this.dependencyGraph();
      return {
        ...snapshot,
        prewarmed: true,
        persistence: this.persistenceStatus()
      };
    });
  }

  /**
   * Adopt an index that was fully rebuilt and atomically persisted by the
   * short-lived builder process. The receipt is matched against both the
   * decoded payload and the file identity after the read, so a concurrent
   * writer cannot silently make an unrelated index authoritative.
   *
   * Direct WorkspaceGraph users keep the conservative persisted-index
   * validation path in prewarm(). Only the process orchestrator calls this
   * method with a receipt obtained over the private child IPC channel.
   */
  async adoptExternalPrewarm(receipt, options = {}) {
    this._assertOpen();
    return this._runExclusive(async () => {
      await this._initializeNow({ loadPersistence: false });
      this._persistenceLoadAttempted = true;
      const loaded = await this._loadPersistedIndexNow();
      if (!loaded) {
        throw persistenceError(
          "EXTERNAL_INDEX_LOAD_FAILED",
          "The externally built workspace index could not be loaded."
        );
      }
      await validateExternalPrewarmReceipt(this, receipt);

      // The builder completed a full reconciliation immediately before it
      // emitted the receipt. Preserve any parent watcher events collected
      // while it ran; they are applied below before callers receive the graph.
      this._persistedNeedsValidation = false;
      this.checkedAt = new Date(Date.parse(receipt.checked_at)).toISOString();
      this._lastFullReconcileAt = this.checkedAt;
      this.lastQueryFingerprint = null;
      this._lastQueryFingerprintAtMs = this.now();

      const externallyCoveredRevision = boundedInteger(
        options.externalConsumeWatchThrough,
        0,
        0,
        this._watchRevision
      );
      if (externallyCoveredRevision > 0) {
        this._consumeWatchEventsThrough(externallyCoveredRevision);
      }

      let result;
      const pendingFullReconciliation = this._pendingFullInvalidationRevision > 0;
      const pendingIncrementalReconciliation = !pendingFullReconciliation && this._pendingWatchPaths.size > 0;
      if (this._hasPendingWatchEvents()) {
        result = await this._applyPendingWatchEventsNow(options);
      } else {
        result = this.snapshot();
      }
      return {
        ...result,
        cache_hit: true,
        prewarmed: true,
        external_builder: {
          protocol_version: receipt.protocol_version,
          child_pid: receipt.child_pid,
          duration_ms: receipt.duration_ms,
          completed_at: receipt.completed_at,
          main_reconciliation: pendingFullReconciliation
            ? "full"
            : pendingIncrementalReconciliation ? "incremental" : null
        },
        persistence: this.persistenceStatus()
      };
    });
  }

}

