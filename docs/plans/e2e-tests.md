---
nav_exclude: true
---

# E2E Test Plan for deer

This document describes the E2E test suite to be built for deer. The goal is to catch real-world integration bugs that only surface when running actual deer — things like the TUI not rendering correctly, state sync failing between instances, or the full agent lifecycle breaking.

## Background: What Unit Tests Don't Catch

The current unit tests cover individual modules well (state machine, task persistence, config parsing, sandbox launch). But the bugs that keep recurring are at the integration seams:

- The TUI renders nothing or the wrong thing after state changes
- The dashboard doesn't pick up a state file written by a running agent
- A task appears stuck/running after deer is restarted
- Keyboard actions (kill, delete, retry) silently fail
- The bypass dialog isn't dismissed, so Claude hangs waiting for input
- Worktrees or tmux sessions are left behind after a crash

E2E tests close these gaps by running the actual `bun src/cli.tsx` binary and verifying both **TUI output** and **filesystem state**.

## Approach

### TUI capture via tmux

deer already uses tmux internally. The E2E tests piggyback on this: they spawn deer itself inside a named tmux session, then use `captureTmuxPane` (already in `src/sandbox/index.ts`) to read the rendered TUI.

```
test process
  └─ tmux new-session -s deer-e2e-test-NNN
       └─ bun src/cli.tsx   ← deer TUI renders here
            └─ [user spawns a task]
                 └─ tmux session: deer-<taskId>   ← Claude runs here
```

This means:
- The TUI is a real Ink render inside a real terminal (tmux pane)
- Keystrokes are sent via `tmux send-keys`
- Output is captured via `tmux capture-pane -p`
- No PTY emulation library needed — tmux handles it

### Waiting for expected state

Use a poll helper rather than fixed sleeps:

```typescript
async function waitFor(
  condition: () => Promise<boolean>,
  { timeout = 15_000, interval = 200 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(interval);
  }
  throw new Error("waitFor timed out");
}
```

### Fake Claude stub

Most E2E tests should NOT call real Claude. Instead, use a fake `claude` script that:
- Prints some plausible output to stdout
- Exits with 0 after a short delay

Location: `test/fixtures/fake-claude.sh`

```bash
#!/bin/sh
# Fake claude stub for E2E tests.
# Simulates a brief run and exits successfully.
sleep 1
echo "● Applying the fix"
sleep 1
echo "● Done"
exit 0
```

The test harness injects this by prepending a temp dir containing a `claude` symlink to `PATH` before launching deer.

### Test helper module

Create `test/e2e/helpers.ts` with shared utilities:

```typescript
export async function startDeerSession(repoPath: string, extraEnv?: Record<string, string>): Promise<{
  sessionName: string;
  stop: () => Promise<void>;
}>

export async function waitForPane(sessionName: string, text: string, timeoutMs?: number): Promise<void>

export async function sendKeys(sessionName: string, keys: string): Promise<void>

export async function createTestRepo(): Promise<{ repoPath: string; cleanup: () => Promise<void> }>

export async function withFakeClaude<T>(fn: (path: string) => Promise<T>): Promise<T>
```

---

## Test Files

### `test/e2e/cli-startup.test.ts`

**Purpose:** Verify deer launches, renders the TUI, and exits cleanly.

**Test: renders dashboard header in a git repo**
```
1. createTestRepo()
2. startDeerSession(repoPath) — spawns `bun src/cli.tsx` in tmux
3. waitForPane(session, "deer") — any identifying header text
4. sendKeys(session, "q") — quit
5. waitFor(() => isTmuxSessionDead(session))
6. Verify exit (no dangling session)
```

**Test: exits with error when not in a git repo**
```
1. Run `bun src/cli.tsx` in /tmp (not a git repo) as a subprocess (not in tmux)
2. Capture stderr/stdout
3. Expect process.exited !== 0
4. Expect output contains "Error"
```

**Test: preflight error shown in TUI when claude is missing**
```
1. createTestRepo()
2. Build a PATH that excludes claude
3. startDeerSession(repoPath, { PATH: pathWithoutClaude })
4. waitForPane(session, "claude CLI not available")
5. Quit
```

**Test: preflight shows credential type**
```
1. createTestRepo()
2. startDeerSession(repoPath, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" })
3. waitForPane(session, "subscription")  — or whatever label is shown
4. Quit
```

---

### `test/e2e/agent-lifecycle.test.ts`

**Purpose:** Verify the full path from prompt submission to completion. This is the most important E2E test — it catches the most regressions.

**Test: submitting a prompt creates a worktree and tmux session**
```
1. createTestRepo()
2. withFakeClaude(async (claudePath) => {
3.   startDeerSession(repoPath, { PATH: claudePath + ":" + process.env.PATH })
4.   waitForPane(session, "deer")  — TUI is up
5.   sendKeys(session, "fix the bug<Enter>")
6.   waitFor(() => Bun.file(join(dataDir(), "tasks", ???, "state.json")).exists())
7.     — hard: we don't know the taskId yet. Solution: scan dataDir/tasks/ for new dirs
8.   Verify state.json has status: "running"
9.   Verify tmux session deer-<taskId> exists (isTmuxSessionDead returns false)
10.  waitFor(() => isTmuxSessionDead(`deer-${taskId}`))  — fake claude finishes
11.  waitFor(() => loadHistory(repoPath) has an entry for this prompt)
12.  Verify history entry status is not "running" (completed, cancelled, or failed)
13. })
```

**Test: state.json is removed after agent completes**
```
After the agent's tmux session dies and deer processes it:
- Verify state.json is gone (the JSONL history is now authoritative)
```

**Test: worktree directory exists while agent is running**
```
After prompt submission, before fake claude exits:
- Verify dataDir/tasks/<taskId>/worktree/.git exists
```

**Implementation note on taskId discovery:** Because the TUI doesn't print the taskId to the pane, scan `dataDir()/tasks/` for directories created after the test started:
```typescript
async function waitForNewTaskId(since: number): Promise<string> {
  return waitFor(async () => {
    const entries = await readdir(join(dataDir(), "tasks"));
    return entries.find(e => e.startsWith("deer_") && statSync(join(dataDir(), "tasks", e)).ctimeMs > since);
  });
}
```

---

### `test/e2e/keyboard-actions.test.ts`

**Purpose:** Verify keyboard actions (kill, delete, retry) actually work end-to-end.

**Test: 'x' kills a running agent**
```
1. Start deer, submit a long-running fake claude (sleep 60 stub)
2. Wait for agent tmux session to appear
3. The running task should be selected by default
4. sendKeys(deer-session, "x")   — kill action
5. waitForPane(deer-session, "Cancel")  — confirmation prompt appears
6. sendKeys(deer-session, "y") or Enter  — confirm
7. waitFor(() => isTmuxSessionDead(`deer-<taskId>`))
8. waitForPane(deer-session, "cancelled")
9. Verify history has status: "cancelled"
```

**Test: Backspace/Delete removes a completed task**
```
1. Start deer, submit fast fake claude
2. Wait for agent to complete
3. sendKeys(deer-session, Backspace)
4. waitFor(() => !Bun.file(join(dataDir(), "tasks", taskId, "state.json")).exists())
5. Verify JSONL history no longer has this taskId
6. Verify worktree directory is gone
7. Verify the task is no longer shown in the TUI pane
```

**Test: 'r' retries a completed task using --continue**
```
1. Start deer, submit fast fake claude (records worktreePath)
2. Wait for completion
3. sendKeys(deer-session, "r")  — retry
4. waitFor(() => new tmux session for same taskId exists)
5. Verify session name is deer-<same taskId>
6. Verify worktree path is same as before (--continue reuses it)
```

---

### `test/e2e/multi-instance.test.ts`

**Purpose:** Verify that tasks from a second deer instance appear correctly in the first instance's dashboard.

**Test: task from another instance appears as running**
```
1. createTestRepo()
2. Start deer instance A in tmux session A
3. Directly write a state.json into dataDir/tasks/<fakeTaskId>/state.json
   with ownerPid = process.pid (so isOwnerAlive returns true)
   and status = "running"
4. waitFor(() => captureTmuxPane(sessionA) includes fakeTaskId's prompt)
5. Verify TUI shows the task as "running"
```

**Test: task becomes interrupted when owning process dies**
```
1. (continuing from above, or new setup)
2. Write state.json with ownerPid = a PID that doesn't exist (e.g. 99999999)
3. waitForPane(sessionA, "interrupted")  — or task disappears
4. Alternatively verify via syncWithHistory logic directly (without TUI)
```

**Implementation note:** The multi-instance sync is driven by `fs.watch` + a safety poll (every 10s, `TASK_SYNC_SAFETY_POLL_MS`). Tests should write the state file and then wait up to ~15s for the sync to fire. The test can alternatively trigger the watch event by writing to the watched directory.

---

### `test/e2e/state-sync.test.ts`

**Purpose:** Verify the state sync pipeline (state files → agent list) without needing the full TUI. This is faster and more deterministic than TUI-level tests.

These tests call the sync logic directly:

```typescript
import { scanLiveTaskIds } from "../../src/task-state";
import { readTaskState } from "../../src/task-state";
import { loadHistory } from "../../src/task";
import { liveTaskFromStateFile, historicalAgentFromStateFile } from "../../src/agent-state";
import { isOwnerAlive } from "../../src/task-state";
```

**Test: live state file with alive owner → liveTaskFromStateFile**
```
1. Write state.json with ownerPid = process.pid, status = "running"
2. scanLiveTaskIds() includes the taskId
3. readTaskState(taskId) returns the state
4. isOwnerAlive(state.ownerPid) === true
5. liveTaskFromStateFile(state).status === "running"
6. liveTaskFromStateFile(state).historical === true
Cleanup: removeTaskState(taskId)
```

**Test: state file with dead owner → historicalAgentFromStateFile**
```
1. Write state.json with ownerPid = 99999999 (dead), status = "running"
2. readTaskState(taskId) returns state
3. isOwnerAlive(state.ownerPid) === false
4. historicalAgentFromStateFile(state).status === "interrupted"
5. historicalAgentFromStateFile(state).lastActivity === "Interrupted — deer was closed"
Cleanup: removeTaskState(taskId)
```

**Test: deleted taskId is excluded from sync results**
```
1. Write state.json for taskId
2. scanLiveTaskIds() includes taskId
3. Add taskId to a Set<string> (simulating deletedTaskIdsRef)
4. Filter: liveTaskIds.filter(id => !deleted.has(id)) — taskId excluded
```

**Test: JSONL history entry used as fallback when no state file**
```
1. upsertHistory(repoPath, { taskId, status: "cancelled", ... })
2. No state.json written
3. loadHistory(repoPath) returns the task
4. historicalAgent(task).status === "cancelled"
Cleanup: removeFromHistory(repoPath, taskId)
```

**Test: state file takes priority over JSONL history for running tasks**
```
1. upsertHistory(repoPath, { taskId, status: "running", ... })  — stale JSONL entry
2. writeTaskState({ taskId, ownerPid: process.pid, status: "running", ... })
3. isOwnerAlive(process.pid) === true → use liveTaskFromStateFile
4. Result status is "running" (from state file, not from JSONL)
Cleanup: removeTaskState + removeFromHistory
```

---

### `test/e2e/build-smoke.test.ts`

**Purpose:** Verify the compiled binary works (prevents broken releases).

**Test: binary exits with error when not in a git repo**
```
1. Run dist/deer-darwin-arm64 (or appropriate platform binary) in /tmp
2. Expect exit code != 0
3. Expect stderr contains "Error"
```

**Test: binary produces no startup crash in a git repo**
```
1. createTestRepo()
2. Spawn binary in a tmux session
3. Wait 2s (startup time)
4. Verify tmux session is still alive (binary didn't crash immediately)
5. Send quit key
```

**Note:** This test should only run when `dist/` exists. Skip with `test.skip` when no binary is present, or gate on `DEER_BINARY_PATH` env var.

---

## Infrastructure Needed

### `test/fixtures/fake-claude.sh`

```bash
#!/bin/sh
# Fake claude stub for E2E tests.
# Accepts any arguments (like the real claude binary) and exits quickly.
echo "Claude Code 1.0.0 (fake)"
sleep 0.5
echo "● Implementing the task..."
sleep 0.5
echo "● Done. Changes committed."
exit 0
```

Make executable (`chmod +x`) and reference from `withFakeClaude`.

### `test/e2e/helpers.ts`

Key utilities:

```typescript
import { mkdtemp, rm, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureTmuxPane, isTmuxSessionDead } from "../../src/sandbox/index";
import { dataDir } from "../../src/task";

/** Poll until condition() returns true, or throw on timeout */
export async function waitFor(
  condition: () => Promise<boolean | string | null | undefined>,
  { timeout = 15_000, interval = 250, label = "condition" }: {
    timeout?: number;
    interval?: number;
    label?: string;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(interval);
  }
  throw new Error(`waitFor("${label}") timed out after ${timeout}ms`);
}

/** Poll tmux pane until it contains expected text */
export async function waitForPane(
  sessionName: string,
  text: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitFor(
    async () => {
      const lines = await captureTmuxPane(sessionName, true);
      return lines?.some(l => l.includes(text)) ?? false;
    },
    { timeout: timeoutMs, label: `pane contains "${text}"` },
  );
}

/** Send keys to a tmux session */
export async function sendKeys(sessionName: string, keys: string): Promise<void> {
  await Bun.spawn(["tmux", "send-keys", "-t", sessionName, keys, ""], {
    stdout: "pipe", stderr: "pipe",
  }).exited;
}

/** Create a minimal git repo suitable for E2E tests */
export async function createTestRepo(): Promise<{
  repoPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "deer-e2e-"));
  await Bun.$`git init ${dir}`.quiet();
  await Bun.$`git -C ${dir} config user.name "deer-e2e"`.quiet();
  await Bun.$`git -C ${dir} config user.email "e2e@deer.test"`.quiet();
  await Bun.write(join(dir, "README.md"), "# E2E Test Repo\n");
  await Bun.$`git -C ${dir} add -A && git -C ${dir} commit -m "init"`.quiet();
  await Bun.$`git -C ${dir} branch -M main`.quiet();
  return {
    repoPath: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Run a test with a fake claude binary prepended to PATH */
export async function withFakeClaude<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "deer-e2e-bin-"));
  const fakeBin = join(binDir, "claude");
  // Copy the fixture stub
  const stubSrc = join(import.meta.dir, "../fixtures/fake-claude.sh");
  await Bun.$`cp ${stubSrc} ${fakeBin} && chmod +x ${fakeBin}`.quiet();
  try {
    return await fn({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

/** Spawn deer TUI in a tmux session. Returns session name and a stop() function. */
export async function startDeerSession(
  repoPath: string,
  extraEnv: Record<string, string> = {},
): Promise<{ sessionName: string; stop: () => Promise<void> }> {
  const sessionName = `deer-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cliPath = join(import.meta.dir, "../../src/cli.tsx");

  const envArgs = Object.entries({ ...process.env, ...extraEnv })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  await Bun.spawn([
    "tmux", "new-session", "-d", "-s", sessionName,
    "-c", repoPath,
    "env", ...Object.entries({ ...process.env, ...extraEnv }).map(([k, v]) => `${k}=${v!}`),
    "bun", "run", cliPath,
  ], { stdout: "pipe", stderr: "pipe" }).exited;

  return {
    sessionName,
    stop: async () => {
      await Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
        stdout: "pipe", stderr: "pipe",
      }).exited.catch(() => {});
    },
  };
}

/** Scan dataDir/tasks/ for a taskId dir created after a given timestamp */
export async function waitForNewTaskDir(since: number, timeoutMs = 15_000): Promise<string> {
  const tasksDir = join(dataDir(), "tasks");
  let found: string | undefined;
  await waitFor(
    async () => {
      let entries: string[];
      try { entries = await readdir(tasksDir); } catch { return false; }
      found = (await Promise.all(
        entries
          .filter(e => e.startsWith("deer_"))
          .map(async e => {
            const s = await stat(join(tasksDir, e)).catch(() => null);
            return s && s.ctimeMs > since ? e : null;
          }),
      )).find((e): e is string => e !== null);
      return !!found;
    },
    { timeout: timeoutMs, label: "new task directory" },
  );
  return found!;
}
```

---

## Running E2E Tests

E2E tests are slow (30–60s each) and have external dependencies (tmux, bun, git). They should be in a separate suite from unit tests:

```sh
# Unit tests only (fast, CI default)
bun test test/*.test.ts test/**/*.test.ts

# E2E tests (slow, opt-in)
DEER_E2E=1 bun test test/e2e/*.test.ts
```

Gate E2E tests with an env var check:

```typescript
import { describe, test } from "bun:test";

const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("CLI startup", () => {
  // ...
});
```

Or use `setDefaultTimeout(60_000)` at the top of each E2E test file and skip whole files if the env var is absent.

---

## Implementation Order

1. **`test/fixtures/fake-claude.sh`** — unblocks all lifecycle tests
2. **`test/e2e/helpers.ts`** — shared infrastructure, written once
3. **`test/e2e/state-sync.test.ts`** — no TUI needed, pure filesystem; catches the most common cross-instance bugs
4. **`test/e2e/cli-startup.test.ts`** — verifies TUI boots and quits cleanly
5. **`test/e2e/agent-lifecycle.test.ts`** — full lifecycle, highest regression value
6. **`test/e2e/keyboard-actions.test.ts`** — catch action bugs (kill/delete/retry)
7. **`test/e2e/multi-instance.test.ts`** — cross-instance sync
8. **`test/e2e/build-smoke.test.ts`** — add last, after release pipeline is stable
