#!/usr/bin/env node
// v4.6 model-router standalone client entry point.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { startStudio } from "./standalone-app.mjs";

const manifest = JSON.parse(await readFile(new URL("./version-manifest.json", import.meta.url), "utf8"));
startStudio(manifest);
