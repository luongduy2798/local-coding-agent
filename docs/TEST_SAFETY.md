# Test Safety

## Core rule

A test may only delete files created inside an isolated fixture owned by the current test run.
The active Local Coding Agent workspace, the source checkout, repository clones, Git roots,
the user's home directory, Desktop, the OS root, and the OS temp root are never disposable.

## Standard fixture

All filesystem-mutating tests must call `createIsolatedTestRoot()` from
`server/tests/helpers/test-guard.mjs`.

```text
/tmp/lca-test-<random>/
├── .lca-test-marker
├── fixture/
├── data/
└── repo/
```

The marker contains a random run ID. Cleanup is denied when the marker is missing,
unreadable, or belongs to another run.

```js
import {
  createIsolatedTestRoot,
  safeRemove
} from "../helpers/test-guard.mjs";

const context = await createIsolatedTestRoot({
  prefix: "lca-feature-",
  protectedPaths: [realRepository]
});

// Use context.fixtureDir as AGENT_WORKSPACE.
// Use context.dataDir as AGENT_DATA_DIR.
await safeRemove(
  path.join(context.fixtureDir, "generated"),
  context,
  { recursive: true, force: true }
);
```

## Protected paths

The guard protects at least:

- The active source repository and configured real repository.
- Every registered repository clone or Git fixture root.
- The current working directory.
- `AGENT_WORKSPACE`, `LCA_REAL_REPO`, `GITHUB_WORKSPACE`, and runner workspaces.
- The user's home directory and Desktop.
- The filesystem root, OS temp root, test root, and `repoDir`.

A target must be below the current test root and inside a registered disposable root.
If safety cannot be proven, deletion is denied.

## Git fixtures

Prefer `createGitFixture()` over cloning the real repository. It creates a Git repository
below `context.repoDir`, protects the Git root, and registers only its `fixture/` child as
disposable.

A test may mutate and clean a registered child such as:

```text
repo/git-fixture-1234/fixture/generated/
```

It must never delete:

- The Git root.
- A subtree containing `.git`.
- A nested repository.
- A worktree whose `.git` marker is a file.
- An ancestor of a protected repository.

Clone the real repository only when the test requires its actual source layout. The clone
root remains protected and is retained by default for debugging.

## Symlink protection

`assertSafeDeleteTarget()` inspects path segments with `lstat()` and resolves symlinks with
`realpath()`. Cleanup is rejected when a link escapes the test root, resolves into a
protected path, or reaches a Git repository.

## Runtime isolation

Integration tests must use:

- A dynamically allocated port, never port `8789`.
- A temporary `AGENT_WORKSPACE`.
- A temporary `AGENT_DATA_DIR`.
- A unique `LCA_TEST_RUN_ID`.
- Only the exact child process spawned by the suite.

Use `server/tests/helpers/test-runtime.mjs`:

```js
const runtime = await startTestServer({
  workspace: context.fixtureDir,
  dataDir: context.dataDir,
  runId: context.runId
});

await stopTestProcess(runtime.child);
```

Do not use `pkill`, `killall`, process-name matching, or the real runtime data directory.

## Forbidden patterns

Tests and CI must not use:

- Direct recursive `rm`, `rmSync`, `fs.rm`, or `Remove-Item -Recurse`.
- Shell recursive deletion.
- `git clean`, `git reset --hard`, `git checkout -- .`, or `git restore .`.
- `process.cwd()` or the active `AGENT_WORKSPACE` as a disposable fixture.
- Port `8789` for a test server.
- `server/data` as test data storage.
- Process-name-based termination.

All recursive test cleanup must go through `safeRemove()`.

## Security tests

Run security tests only through:

```bash
cd server
npm run test:security
```

`server/tests/runners/run-security-isolated.mjs` snapshots the real repository, creates separate runtime and
baseline workspaces, uses separate data directories and ports, stops only its own child
processes, and verifies that the real repository is unchanged afterward.

The inner security scripts reject direct execution when the required test marker variables
are absent.

## Repository integrity

Use `snapshotRepositoryState()` before a destructive suite and
`assertRepositoryIntact()` afterward. The guard verifies:

- `.git` still exists.
- The path is still a worktree.
- HEAD and branch did not change.
- Remote configuration did not change.

A pre-existing dirty working tree is allowed; a safety test must not replace or remove the
repository.

## Fail-safe cleanup

When cleanup is rejected:

1. Keep the fixture for inspection.
2. Print the test root and requested target.
3. Report the guard reason.
4. Do not try a shell fallback.
5. Do not delete a parent directory.
6. Do not disable the guard automatically.

## Required checks

Before running destructive integration or security suites:

```bash
cd server
npm run test:safety
```

The safety command runs the source scanner and guard regression tests. CI must stop when
this gate fails.

## New-test checklist

- [ ] Fixture created with `createIsolatedTestRoot()`.
- [ ] Workspace is below `context.fixtureDir`.
- [ ] Data uses `context.dataDir` through `AGENT_DATA_DIR`.
- [ ] Test server uses a dynamic port.
- [ ] Only the spawned child process is stopped.
- [ ] Recursive cleanup uses `safeRemove()`.
- [ ] Git roots remain protected.
- [ ] Symlink and marker behavior is covered when relevant.
- [ ] `npm run test:safety` passes.
