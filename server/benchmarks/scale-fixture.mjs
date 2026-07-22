// Local Coding Agent runtime scale benchmark fixtures
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function generateMonorepo(root, { fileCount, packageCount, concurrency }) {
  const packageNames = Array.from(
    { length: packageCount },
    (_, index) => `@lca-bench/pkg-${String(index).padStart(3, "0")}`
  );
  const rootManifest = `${JSON.stringify({
    name: "lca-scale-monorepo",
    private: true,
    workspaces: ["packages/*"]
  })}\n`;
  await writeFile(path.join(root, "package.json"), rootManifest, "utf8");
  let written = 1;
  let bytes = Buffer.byteLength(rootManifest);

  for (let packageIndex = 0; packageIndex < packageCount; packageIndex++) {
    const packageDir = path.join(root, "packages", `pkg-${String(packageIndex).padStart(3, "0")}`);
    const srcDir = path.join(packageDir, "src");
    await mkdir(srcDir, { recursive: true });
    const dependency = packageIndex > 0 ? packageNames[packageIndex - 1] : null;
    const manifest = `${JSON.stringify({
      name: packageNames[packageIndex],
      version: "1.0.0",
      type: "module",
      ...(dependency ? { dependencies: { [dependency]: "workspace:*" } } : {})
    })}\n`;
    const indexContent = packageIndex === 0
      ? hotFileContent("LCA_SCALE_BASELINE")
      : `import { packageValue${packageIndex - 1} } from ${JSON.stringify(dependency)};\nexport const packageValue${packageIndex} = packageValue${packageIndex - 1} + ${packageIndex};\n`;
    const testContent = `import { packageValue${packageIndex} } from "./index.js";\nexport const packageTest${packageIndex} = packageValue${packageIndex};\n`;
    await Promise.all([
      writeFile(path.join(packageDir, "package.json"), manifest, "utf8"),
      writeFile(path.join(srcDir, "index.js"), indexContent, "utf8"),
      writeFile(path.join(srcDir, "index.test.js"), testContent, "utf8")
    ]);
    written += 3;
    bytes += Buffer.byteLength(manifest) + Buffer.byteLength(indexContent) + Buffer.byteLength(testContent);
  }

  let sequence = 0;
  while (written < fileCount) {
    const batch = [];
    while (written + batch.length < fileCount && batch.length < concurrency) {
      const fileIndex = sequence++;
      const packageIndex = fileIndex % packageCount;
      const packageSlug = `pkg-${String(packageIndex).padStart(3, "0")}`;
      const fileName = `generated-${String(fileIndex).padStart(6, "0")}.js`;
      const content = `export const generated${fileIndex} = ${fileIndex}; // LCA_SCALE_QUERY_NEEDLE\n`;
      bytes += Buffer.byteLength(content);
      batch.push(writeFile(
        path.join(root, "packages", packageSlug, "src", fileName),
        content,
        "utf8"
      ));
    }
    await Promise.all(batch);
    written += batch.length;
  }

  return {
    fileCount: written,
    packageCount,
    bytes,
    queryNeedle: "LCA_SCALE_QUERY_NEEDLE",
    hotFile: "packages/pkg-000/src/index.js"
  };
}

export async function generateConsumerWorkspace(root) {
  await mkdir(path.join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "lca-scale-consumer", private: true, type: "module" })}\n`,
      "utf8"
    ),
    writeFile(path.join(root, "src", "index.js"), "export const consumer = true;\n", "utf8")
  ]);
}

export function hotFileContent(marker) {
  return `export const packageValue0 = ${JSON.stringify(marker)};\n`;
}
