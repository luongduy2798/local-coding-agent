// Local Coding Agent runtime data migration tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { openRegistryDatabase } from "../../src/storage/database.mjs";
import {
  prepareRuntimeDataDirectory,
  resolveRuntimeDataPaths,
  RuntimeDataMigrationError
} from "../../src/storage/runtime-data.mjs";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";

test("fresh runtime data uses the stable runtime directory", async () => {
  await withFixture("fresh", async ({ dataRoot }) => {
    const result = await prepareRuntimeDataDirectory({ agentDataDir: dataRoot });
    assert.equal(result.state, "fresh");
    assert.equal(result.runtimeDir, path.join(dataRoot, "runtime"));
    const marker = JSON.parse(await readFile(path.join(result.runtimeDir, ".runtime-activation.json"), "utf8"));
    assert.equal(marker.active, true);
    assert.equal(marker.source, null);
  });
});

test("legacy v5 data is copied transactionally and retained as backup", async () => {
  await withFixture("legacy", async ({ dataRoot }) => {
    const paths = await createLegacyData(dataRoot);
    const result = await prepareRuntimeDataDirectory({ agentDataDir: dataRoot });
    assert.equal(result.state, "migrated");
    assert.equal(await readFile(path.join(paths.runtimeDir, "journal", "record.json"), "utf8"), "{\"ok\":true}\n");
    assert.equal(await readFile(path.join(paths.legacyDir, "journal", "record.json"), "utf8"), "{\"ok\":true}\n");
    assert.equal((await lstat(paths.runtimeDir)).mode & 0o777, 0o750);
    assert.equal((await lstat(path.join(paths.runtimeDir, "journal", "record.json"))).mode & 0o777, 0o640);
    const marker = JSON.parse(await readFile(path.join(paths.runtimeDir, ".runtime-activation.json"), "utf8"));
    assert.equal(marker.source.canonical_path, await import("node:fs/promises").then(({ realpath }) => realpath(paths.legacyDir)));
  });
});

test("target-only state is activated without creating a versioned source tree", async () => {
  await withFixture("target", async ({ dataRoot }) => {
    const paths = resolveRuntimeDataPaths({ agentDataDir: dataRoot });
    await mkdir(paths.runtimeDir, { recursive: true });
    await writeFile(path.join(paths.runtimeDir, "state.txt"), "active\n");
    const result = await prepareRuntimeDataDirectory({ agentDataDir: dataRoot });
    assert.equal(result.state, "active");
    assert.equal(await readFile(path.join(paths.runtimeDir, "state.txt"), "utf8"), "active\n");
  });
});

test("ambiguous legacy and runtime directories fail closed", async () => {
  await withFixture("conflict", async ({ dataRoot }) => {
    const paths = resolveRuntimeDataPaths({ agentDataDir: dataRoot });
    await mkdir(paths.legacyDir, { recursive: true });
    await mkdir(paths.runtimeDir, { recursive: true });
    await assert.rejects(
      prepareRuntimeDataDirectory({ agentDataDir: dataRoot }),
      (error) => error instanceof RuntimeDataMigrationError && error.code === "RUNTIME_DATA_CONFLICT"
    );
  });
});

test("an activated runtime tolerates mount device drift but rejects stable identity changes", async () => {
  await withFixture("activation-device-drift", async ({ dataRoot }) => {
    const paths = await createLegacyData(dataRoot);
    const migrated = await prepareRuntimeDataDirectory({ agentDataDir: dataRoot });
    assert.equal(migrated.state, "migrated");

    const markerPath = path.join(paths.runtimeDir, ".runtime-activation.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.source.device = `remounted-${marker.source.device}`;
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });

    const active = await prepareRuntimeDataDirectory({ agentDataDir: dataRoot });
    assert.equal(active.state, "active");

    marker.source.inode = `replaced-${marker.source.inode}`;
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(
      prepareRuntimeDataDirectory({ agentDataDir: dataRoot }),
      (error) => error instanceof RuntimeDataMigrationError && error.code === "RUNTIME_DATA_CONFLICT"
    );
  });
});

for (const stage of ["after_intent", "after_copy", "during_validation", "after_validate", "after_rename", "after_activation"]) {
  test(`migration recovers idempotently after ${stage}`, async () => {
    await withFixture(`fault-${stage}`, async ({ dataRoot }) => {
      const paths = await createLegacyData(dataRoot);
      await assert.rejects(
        prepareRuntimeDataDirectory({ agentDataDir: dataRoot, faultAt: stage }),
        (error) => error instanceof RuntimeDataMigrationError && error.code === "RUNTIME_MIGRATION_FAULT"
      );
      const recovered = await prepareRuntimeDataDirectory({ agentDataDir: dataRoot });
      assert.ok(["migrated", "recovered"].includes(recovered.state));
      assert.equal(await readFile(path.join(paths.runtimeDir, "journal", "record.json"), "utf8"), "{\"ok\":true}\n");
      assert.equal(await readFile(path.join(paths.legacyDir, "journal", "record.json"), "utf8"), "{\"ok\":true}\n");
    });
  });
}

test("migration recovers after a disk-full copy failure", async () => {
  await withFixture("disk-full", async ({ dataRoot }) => {
    const paths = await createLegacyData(dataRoot);
    let injected = false;
    await assert.rejects(
      prepareRuntimeDataDirectory({
        agentDataDir: dataRoot,
        stageHook(stage) {
          if (stage !== "before_copy" || injected) return;
          injected = true;
          const error = new Error("Injected disk full");
          error.code = "ENOSPC";
          throw error;
        }
      }),
      (error) => error?.code === "ENOSPC"
    );
    const recovered = await prepareRuntimeDataDirectory({ agentDataDir: dataRoot });
    assert.equal(recovered.state, "migrated");
    assert.equal(await readFile(path.join(paths.runtimeDir, "journal", "record.json"), "utf8"), "{\"ok\":true}\n");
  });
});

test("migration recovers after SQLite reports busy during validation", async () => {
  await withFixture("database-busy", async ({ dataRoot }) => {
    const paths = await createLegacyData(dataRoot);
    let injected = false;
    await assert.rejects(
      prepareRuntimeDataDirectory({
        agentDataDir: dataRoot,
        stageHook(stage) {
          if (stage !== "before_validation" || injected) return;
          injected = true;
          const error = new Error("Injected SQLite busy");
          error.code = "SQLITE_BUSY";
          throw error;
        }
      }),
      (error) => error?.code === "SQLITE_BUSY"
    );
    const recovered = await prepareRuntimeDataDirectory({ agentDataDir: dataRoot });
    assert.equal(recovered.state, "migrated");
    assert.equal(await readFile(path.join(paths.runtimeDir, "journal", "record.json"), "utf8"), "{\"ok\":true}\n");
  });
});

test("migration rejects a source symlink swap and remains fail-closed after source identity changes", async () => {
  await withFixture("symlink-swap", async ({ dataRoot, fixtureDir }) => {
    const paths = await createLegacyData(dataRoot);
    const outside = path.join(fixtureDir, "outside-swap.txt");
    const swapped = path.join(paths.legacyDir, "swapped-link");
    await writeFile(outside, "outside\n");
    await assert.rejects(
      prepareRuntimeDataDirectory({
        agentDataDir: dataRoot,
        async stageHook(stage) {
          if (stage === "after_copy_contents") await symlink(outside, swapped);
        }
      }),
      (error) => error instanceof RuntimeDataMigrationError && error.code === "RUNTIME_MIGRATION_SYMLINK"
    );
    await unlink(swapped);
    await assert.rejects(
      prepareRuntimeDataDirectory({ agentDataDir: dataRoot }),
      (error) => error instanceof RuntimeDataMigrationError && error.code === "RUNTIME_MIGRATION_INTENT_CONFLICT"
    );
    await assert.rejects(lstat(paths.runtimeDir), (error) => error?.code === "ENOENT");
  });
});

test("migration runs the stopped-process guard before writing intent", async () => {
  await withFixture("stopped-guard", async ({ dataRoot }) => {
    const paths = await createLegacyData(dataRoot);
    await assert.rejects(
      prepareRuntimeDataDirectory({
        agentDataDir: dataRoot,
        assertStopped() {
          const error = new Error("Supervisor still running");
          error.code = "RUNTIME_PROCESS_ACTIVE";
          throw error;
        }
      }),
      (error) => error?.code === "RUNTIME_PROCESS_ACTIVE"
    );
    await assert.rejects(readFile(paths.intentPath, "utf8"), (error) => error?.code === "ENOENT");
  });
});

test("migration rejects symlinks before copying legacy data", async () => {
  await withFixture("symlink", async ({ dataRoot, fixtureDir }) => {
    const paths = resolveRuntimeDataPaths({ agentDataDir: dataRoot });
    await mkdir(paths.legacyDir, { recursive: true });
    const outside = path.join(fixtureDir, "outside.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(paths.legacyDir, "escape"));
    await assert.rejects(
      prepareRuntimeDataDirectory({ agentDataDir: dataRoot }),
      (error) => error instanceof RuntimeDataMigrationError && error.code === "RUNTIME_MIGRATION_SYMLINK"
    );
  });
});

async function createLegacyData(dataRoot) {
  const paths = resolveRuntimeDataPaths({ agentDataDir: dataRoot });
  await mkdir(path.join(paths.legacyDir, "journal"), { recursive: true });
  await chmod(paths.legacyDir, 0o750);
  const record = path.join(paths.legacyDir, "journal", "record.json");
  await writeFile(record, "{\"ok\":true}\n", { mode: 0o640 });
  await chmod(record, 0o640);
  const database = await openRegistryDatabase({
    databasePath: path.join(paths.legacyDir, "registry.sqlite"),
    busyTimeoutMs: 5_000
  });
  await database.close();
  return paths;
}

async function withFixture(name, callback) {
  const context = await createIsolatedTestRoot({
    prefix: `lca-runtime-data-${name}-`,
    protectedPaths: [path.resolve("..")] 
  });
  const dataRoot = path.join(context.dataDir, "state");
  await mkdir(dataRoot, { recursive: true });
  try {
    await callback({ ...context, dataRoot });
  } finally {
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
}
