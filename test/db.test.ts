import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  getDb,
  closeDb,
  insertTask,
  updateTask,
  getTask,
  getTasksByRepo,
  getAllTasks,
  deleteTaskRow,
  claimPoller,
  releasePoller,
  releaseAllPollers,
  repoHash,
  isProcessAlive,
} from "../src/db";

// Use a writable temp dir for the database so tests work in sandboxed environments
const testDataDir = mkdtempSync(join(tmpdir(), "deer-db-test-"));
process.env.DEER_DATA_DIR = testDataDir;

const dbPath = join(testDataDir, "deer.db");

beforeEach(() => {
  closeDb();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(`${dbPath}-wal`); } catch {}
  try { unlinkSync(`${dbPath}-shm`); } catch {}
});

afterEach(() => {
  closeDb();
});

afterAll(() => {
  closeDb();
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  delete process.env.DEER_DATA_DIR;
});

describe("repoHash", () => {
  test("returns same hash for same path", () => {
    expect(repoHash("/home/user/project")).toBe(repoHash("/home/user/project"));
  });

  test("returns different hash for different paths", () => {
    expect(repoHash("/home/user/a")).not.toBe(repoHash("/home/user/b"));
  });

  test("returns a 16-char hex string", () => {
    expect(repoHash("/any/path")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("insertTask + getTask", () => {
  test("roundtrip: insert then get returns the same data", () => {
    const now = Date.now();
    insertTask({
      taskId: "deer_test1",
      repoPath: "/home/user/repo",
      prompt: "fix the bug",
      baseBranch: "main",
      branch: "deer/deer_test1",
      worktreePath: "/tmp/worktree",
      model: "sonnet",
      createdAt: now,
    });

    const row = getTask("deer_test1");
    expect(row).not.toBeNull();
    expect(row!.task_id).toBe("deer_test1");
    expect(row!.repo_path).toBe("/home/user/repo");
    expect(row!.repo_hash).toBe(repoHash("/home/user/repo"));
    expect(row!.prompt).toBe("fix the bug");
    expect(row!.base_branch).toBe("main");
    expect(row!.branch).toBe("deer/deer_test1");
    expect(row!.worktree_path).toBe("/tmp/worktree");
    expect(row!.model).toBe("sonnet");
    expect(row!.status).toBe("setup");
    expect(row!.created_at).toBe(now);
    expect(row!.elapsed).toBe(0);
    expect(row!.idle).toBe(0);
    expect(row!.poller_pid).toBeNull();
  });

  test("getTask returns null for nonexistent task", () => {
    getDb(); // ensure DB is initialized
    expect(getTask("deer_nonexistent")).toBeNull();
  });
});

describe("updateTask", () => {
  test("updates specific fields", () => {
    insertTask({
      taskId: "deer_upd1",
      repoPath: "/repo",
      prompt: "test",
      baseBranch: "main",
      createdAt: Date.now(),
    });

    updateTask("deer_upd1", {
      status: "running",
      branch: "deer/upd1",
      worktreePath: "/tmp/wt",
      lastActivity: "doing stuff",
      elapsed: 42,
      idle: true,
    });

    const row = getTask("deer_upd1");
    expect(row!.status).toBe("running");
    expect(row!.branch).toBe("deer/upd1");
    expect(row!.worktree_path).toBe("/tmp/wt");
    expect(row!.last_activity).toBe("doing stuff");
    expect(row!.elapsed).toBe(42);
    expect(row!.idle).toBe(1);
  });

  test("updates prUrl and finalBranch", () => {
    insertTask({
      taskId: "deer_upd2",
      repoPath: "/repo",
      prompt: "test",
      baseBranch: "main",
      createdAt: Date.now(),
    });

    updateTask("deer_upd2", {
      prUrl: "https://github.com/org/repo/pull/42",
      finalBranch: "deer/my-fix",
      prState: "open",
    });

    const row = getTask("deer_upd2");
    expect(row!.pr_url).toBe("https://github.com/org/repo/pull/42");
    expect(row!.final_branch).toBe("deer/my-fix");
    expect(row!.pr_state).toBe("open");
  });

  test("no-op when fields is empty", () => {
    insertTask({
      taskId: "deer_upd3",
      repoPath: "/repo",
      prompt: "test",
      baseBranch: "main",
      createdAt: Date.now(),
    });

    updateTask("deer_upd3", {});
    const row = getTask("deer_upd3");
    expect(row!.status).toBe("setup");
  });

  test("can set nullable fields to null", () => {
    insertTask({
      taskId: "deer_upd4",
      repoPath: "/repo",
      prompt: "test",
      baseBranch: "main",
      createdAt: Date.now(),
    });

    updateTask("deer_upd4", { prUrl: "https://example.com", error: "oops" });
    updateTask("deer_upd4", { prUrl: null, error: null });

    const row = getTask("deer_upd4");
    expect(row!.pr_url).toBeNull();
    expect(row!.error).toBeNull();
  });
});

describe("getTasksByRepo", () => {
  test("returns only tasks for the given repo", () => {
    const now = Date.now();
    insertTask({ taskId: "deer_r1", repoPath: "/repo-a", prompt: "a", baseBranch: "main", createdAt: now });
    insertTask({ taskId: "deer_r2", repoPath: "/repo-b", prompt: "b", baseBranch: "main", createdAt: now + 1 });
    insertTask({ taskId: "deer_r3", repoPath: "/repo-a", prompt: "c", baseBranch: "main", createdAt: now + 2 });

    const rows = getTasksByRepo("/repo-a");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.task_id)).toEqual(["deer_r1", "deer_r3"]);
  });

  test("returns empty array for unknown repo", () => {
    getDb();
    expect(getTasksByRepo("/nonexistent")).toEqual([]);
  });
});

describe("getAllTasks", () => {
  test("returns all tasks sorted by created_at", () => {
    const now = Date.now();
    insertTask({ taskId: "deer_a1", repoPath: "/a", prompt: "1", baseBranch: "main", createdAt: now + 2 });
    insertTask({ taskId: "deer_a2", repoPath: "/b", prompt: "2", baseBranch: "main", createdAt: now });
    insertTask({ taskId: "deer_a3", repoPath: "/a", prompt: "3", baseBranch: "main", createdAt: now + 1 });

    const rows = getAllTasks();
    expect(rows.map((r) => r.task_id)).toEqual(["deer_a2", "deer_a3", "deer_a1"]);
  });
});

describe("deleteTaskRow", () => {
  test("removes a task", () => {
    insertTask({ taskId: "deer_del1", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    expect(getTask("deer_del1")).not.toBeNull();

    deleteTaskRow("deer_del1");
    expect(getTask("deer_del1")).toBeNull();
  });

  test("no-op for nonexistent task", () => {
    getDb();
    expect(() => deleteTaskRow("deer_nonexistent")).not.toThrow();
  });
});

describe("claimPoller", () => {
  test("claims when poller_pid is null", () => {
    insertTask({ taskId: "deer_cp1", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    expect(claimPoller("deer_cp1", process.pid)).toBe(true);

    const row = getTask("deer_cp1");
    expect(row!.poller_pid).toBe(process.pid);
  });

  test("claims when already owned by same pid", () => {
    insertTask({ taskId: "deer_cp2", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    claimPoller("deer_cp2", process.pid);
    expect(claimPoller("deer_cp2", process.pid)).toBe(true);
  });

  test("claims when existing poller is dead", () => {
    const DEAD_PID = 99999999;
    insertTask({ taskId: "deer_cp3", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    updateTask("deer_cp3", { pollerPid: DEAD_PID });

    expect(claimPoller("deer_cp3", process.pid)).toBe(true);
    expect(getTask("deer_cp3")!.poller_pid).toBe(process.pid);
  });

  test("fails when existing poller is alive and different", () => {
    insertTask({ taskId: "deer_cp4", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    // Use parent PID — guaranteed alive and different from current process
    const ppid = process.ppid;
    updateTask("deer_cp4", { pollerPid: ppid });

    expect(claimPoller("deer_cp4", process.pid)).toBe(false);
    expect(getTask("deer_cp4")!.poller_pid).toBe(ppid);
  });

  test("returns false for nonexistent task", () => {
    getDb();
    expect(claimPoller("deer_nonexistent", process.pid)).toBe(false);
  });
});

describe("releasePoller", () => {
  test("clears poller_pid when it matches", () => {
    insertTask({ taskId: "deer_rp1", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    claimPoller("deer_rp1", process.pid);

    releasePoller("deer_rp1", process.pid);
    expect(getTask("deer_rp1")!.poller_pid).toBeNull();
  });

  test("does not clear when pid does not match", () => {
    insertTask({ taskId: "deer_rp2", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    updateTask("deer_rp2", { pollerPid: 1 });

    releasePoller("deer_rp2", process.pid);
    expect(getTask("deer_rp2")!.poller_pid).toBe(1);
  });
});

describe("releaseAllPollers", () => {
  test("clears all entries for the given pid", () => {
    const now = Date.now();
    insertTask({ taskId: "deer_rap1", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: now });
    insertTask({ taskId: "deer_rap2", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: now + 1 });
    insertTask({ taskId: "deer_rap3", repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: now + 2 });

    claimPoller("deer_rap1", process.pid);
    claimPoller("deer_rap2", process.pid);
    updateTask("deer_rap3", { pollerPid: 1 }); // different pid

    releaseAllPollers(process.pid);

    expect(getTask("deer_rap1")!.poller_pid).toBeNull();
    expect(getTask("deer_rap2")!.poller_pid).toBeNull();
    expect(getTask("deer_rap3")!.poller_pid).toBe(1); // untouched
  });
});

describe("isProcessAlive", () => {
  test("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for a dead PID", () => {
    expect(isProcessAlive(99999999)).toBe(false);
  });

  test("returns false for pid 0", () => {
    expect(isProcessAlive(0)).toBe(false);
  });

  test("returns false for negative pid", () => {
    expect(isProcessAlive(-1)).toBe(false);
  });
});
