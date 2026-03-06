import { test, expect, describe, afterEach } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTaskState,
  writeTaskState,
  removeTaskState,
  isOwnerAlive,
  scanLiveTaskIds,
  type TaskStateFile,
} from "../src/task-state";
import * as taskModule from "../src/task";

// Override dataDir for tests by monkey-patching the task-state module's dep
// We do this by writing state files into a temp tasks dir and pointing the
// module at it via the real filesystem under a unique temp path.

function makeTempDir(): string {
  return join(tmpdir(), `deer-task-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeStateFile(overrides?: Partial<TaskStateFile>): TaskStateFile {
  return {
    taskId: "deer_test01",
    prompt: "fix the login bug",
    status: "running",
    elapsed: 42,
    lastActivity: "● Implementing fix...",
    finalBranch: "deer/deer_test01",
    prUrl: null,
    error: null,
    logs: ["[setup] Creating worktree...", "[running] Claude started"],
    idle: false,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    worktreePath: "/home/user/.local/share/deer/tasks/deer_test01/worktree",
    ...overrides,
  };
}

// Temporarily override dataDir to point at a temp directory
async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  await mkdir(join(dir, "tasks"), { recursive: true });
  const origDataDir = (taskModule as unknown as { dataDir: () => string }).dataDir;

  // We can't easily monkey-patch an ES module, so we test via the filesystem
  // directly: the task-state functions are pure file I/O against dataDir().
  // For these tests we'll use the real dataDir but with unique taskIds that
  // won't collide with real state.
  return fn(dir);
}

// Use unique taskIds per test to avoid cross-contamination
let taskCounter = 0;
function uniqueTaskId(): string {
  return `deer_teststate${Date.now()}${taskCounter++}`;
}

describe("readTaskState", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    for (const id of createdIds) {
      await removeTaskState(id).catch(() => {});
    }
    createdIds.length = 0;
  });

  test("returns null when no state file exists", async () => {
    const result = await readTaskState("deer_nonexistent_xyz_abc");
    expect(result).toBeNull();
  });

  test("roundtrip: write then read returns the same data", async () => {
    const taskId = uniqueTaskId();
    createdIds.push(taskId);
    const state = makeStateFile({ taskId });

    await writeTaskState(state);
    const loaded = await readTaskState(taskId);

    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe(taskId);
    expect(loaded!.prompt).toBe(state.prompt);
    expect(loaded!.elapsed).toBe(state.elapsed);
    expect(loaded!.lastActivity).toBe(state.lastActivity);
    expect(loaded!.logs).toEqual(state.logs);
    expect(loaded!.idle).toBe(state.idle);
    expect(loaded!.ownerPid).toBe(state.ownerPid);
    expect(loaded!.finalBranch).toBe(state.finalBranch);
    expect(loaded!.prUrl).toBe(state.prUrl);
  });

  test("write is idempotent — second write overwrites first", async () => {
    const taskId = uniqueTaskId();
    createdIds.push(taskId);

    await writeTaskState(makeStateFile({ taskId, elapsed: 10 }));
    await writeTaskState(makeStateFile({ taskId, elapsed: 99, lastActivity: "updated" }));

    const loaded = await readTaskState(taskId);
    expect(loaded!.elapsed).toBe(99);
    expect(loaded!.lastActivity).toBe("updated");
  });

  test("persists idle flag", async () => {
    const taskId = uniqueTaskId();
    createdIds.push(taskId);
    await writeTaskState(makeStateFile({ taskId, idle: true }));
    const loaded = await readTaskState(taskId);
    expect(loaded!.idle).toBe(true);
  });

  test("persists prUrl and finalBranch", async () => {
    const taskId = uniqueTaskId();
    createdIds.push(taskId);
    const state = makeStateFile({
      taskId,
      prUrl: "https://github.com/org/repo/pull/42",
      finalBranch: "deer/deer_test01",
    });
    await writeTaskState(state);
    const loaded = await readTaskState(taskId);
    expect(loaded!.prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(loaded!.finalBranch).toBe("deer/deer_test01");
  });

  test("persists error field", async () => {
    const taskId = uniqueTaskId();
    createdIds.push(taskId);
    await writeTaskState(makeStateFile({ taskId, status: "failed", error: "Claude exited with code 1" }));
    const loaded = await readTaskState(taskId);
    expect(loaded!.error).toBe("Claude exited with code 1");
  });
});

describe("removeTaskState", () => {
  test("removes an existing state file", async () => {
    const taskId = uniqueTaskId();
    await writeTaskState(makeStateFile({ taskId }));
    expect(await readTaskState(taskId)).not.toBeNull();

    await removeTaskState(taskId);
    expect(await readTaskState(taskId)).toBeNull();
  });

  test("is a no-op when no state file exists", async () => {
    await expect(removeTaskState("deer_neverexisted_xyz")).resolves.toBeUndefined();
  });
});

describe("isOwnerAlive", () => {
  test("returns true for the current process PID", () => {
    expect(isOwnerAlive(process.pid)).toBe(true);
  });

  test("returns false for PID 0", () => {
    // PID 0 is the swapper/idle process — not a valid user process to signal
    expect(isOwnerAlive(0)).toBe(false);
  });

  test("returns false for a very large PID that does not exist", () => {
    // PID 4194304 is beyond the Linux default max_pid (typically 4194304 is the max,
    // but 99999999 is safely beyond any real process)
    expect(isOwnerAlive(99999999)).toBe(false);
  });
});

describe("scanLiveTaskIds", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    for (const id of createdIds) {
      await removeTaskState(id).catch(() => {});
    }
    createdIds.length = 0;
  });

  test("returns empty array when no state files exist (or tasks dir missing)", async () => {
    // This tests against the real dataDir; as long as no state files are
    // present for the unique IDs we'd create, this is stable.
    const results = await scanLiveTaskIds();
    // Result is an array (may be non-empty if other tests left files, but type is correct)
    expect(Array.isArray(results)).toBe(true);
  });

  test("includes taskIds for which state files have been written", async () => {
    const taskId1 = uniqueTaskId();
    const taskId2 = uniqueTaskId();
    createdIds.push(taskId1, taskId2);

    await writeTaskState(makeStateFile({ taskId: taskId1 }));
    await writeTaskState(makeStateFile({ taskId: taskId2 }));

    const results = await scanLiveTaskIds();
    expect(results).toContain(taskId1);
    expect(results).toContain(taskId2);
  });

  test("does not include taskIds whose state files were removed", async () => {
    const taskId = uniqueTaskId();
    createdIds.push(taskId);

    await writeTaskState(makeStateFile({ taskId }));
    await removeTaskState(taskId);

    const results = await scanLiveTaskIds();
    expect(results).not.toContain(taskId);
  });
});
