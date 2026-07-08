#!/usr/bin/env bash
# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Legacy convenience wrapper. The setup flow lives in scripts/lca setup.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$ROOT/scripts/local-coding-agent.mjs" setup "$@"
