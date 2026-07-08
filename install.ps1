# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Legacy convenience wrapper. The setup flow lives in scripts\lca.cmd setup.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $Root "scripts\local-coding-agent.mjs") setup @args
exit $LASTEXITCODE
