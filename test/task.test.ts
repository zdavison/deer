import { test, expect, describe, afterEach } from "bun:test";
import { generateTaskId, dataDir, historyPath, loadHistory, loadAllHistory, removeFromHistory, upsertHistory } from "../src/task";
import type { PersistedTask } from "../src/task";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("generateTaskId", () => {
  test("produces unique IDs across 1000 invocations", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateTaskId());
    }
    expect(ids.size).toBe(1000);
  });

  test("IDs are sortable by creation time", async () => {
    const first = generateTaskId();
    // Small delay to ensure timestamp advances
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = generateTaskId();

    expect(first < second).toBe(true);
  });

  test("IDs match expected format: deer_ prefix + alphanumeric", () => {
    const id = generateTaskId();
    expect(id).toMatch(/^deer_[a-z0-9]+$/);
  });

  test("IDs have the deer_ prefix", () => {
    const id = generateTaskId();
    expect(id.startsWith("deer_")).toBe(true);
  });

  test("IDs are URL-safe (no special characters)", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateTaskId();
      // URL-safe: only alphanumeric, hyphens, underscores
      expect(id).toMatch(/^[a-zA-Z0-9_]+$/);
    }
  });
});

describe("dataDir", () => {
  test("returns expected path under ~/.local/share/deer", () => {
    const dir = dataDir();
    const home = process.env.HOME;
    expect(dir).toBe(`${home}/.local/share/deer`);
  });
});

describe("historyPath", () => {
  test("returns same path for the same repo", () => {
    const a = historyPath("/home/user/project");
    const b = historyPath("/home/user/project");
    expect(a).toBe(b);
  });

  test("returns different paths for different repos", () => {
    const a = historyPath("/home/user/project-a");
    const b = historyPath("/home/user/project-b");
    expect(a).not.toBe(b);
  });

  test("path is under dataDir/history/", () => {
    const path = historyPath("/some/repo");
    expect(path.startsWith(`${dataDir()}/history/`)).toBe(true);
    expect(path.endsWith(".jsonl")).toBe(true);
  });
});

describe("history persistence", () => {
  const testDirs: string[] = [];

  function makeFakeDataDir(): string {
    // We'll create a temp dir and pass it as a repo path that hashes uniquely
    const dir = join(tmpdir(), `deer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    // Clean up the actual history files we created
    for (const dir of testDirs) {
      const path = historyPath(dir);
      try { await rm(path); } catch { /* ignore */ }
    }
    testDirs.length = 0;
  });

  function makeTask(overrides?: Partial<PersistedTask>): PersistedTask {
    return {
      taskId: generateTaskId(),
      prompt: "fix the login bug",
      status: "cancelled",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      elapsed: 45,
      prUrl: "https://github.com/org/repo/pull/1",
      finalBranch: null,
      error: null,
      lastActivity: "PR ready",
      baseBranch: "main",
      worktreePath: "",
      ...overrides,
    };
  }

  test("loadHistory returns empty array when no file exists", async () => {
    const result = await loadHistory("/nonexistent/repo/path/xyz");
    expect(result).toEqual([]);
  });

  test("upsertHistory + loadHistory roundtrip", async () => {
    const repoPath = makeFakeDataDir();
    const task = makeTask();

    await upsertHistory(repoPath, task);
    const loaded = await loadHistory(repoPath);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe(task.taskId);
    expect(loaded[0].prompt).toBe(task.prompt);
    expect(loaded[0].prUrl).toBe(task.prUrl);
  });

  test("multiple appends accumulate", async () => {
    const repoPath = makeFakeDataDir();

    await upsertHistory(repoPath, makeTask({ prompt: "task 1" }));
    await upsertHistory(repoPath, makeTask({ prompt: "task 2" }));
    await upsertHistory(repoPath, makeTask({ prompt: "task 3" }));

    const loaded = await loadHistory(repoPath);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((t) => t.prompt)).toEqual(["task 1", "task 2", "task 3"]);
  });

  test("failed tasks persist with error", async () => {
    const repoPath = makeFakeDataDir();
    const task = makeTask({
      status: "failed",
      error: "Claude exited with code 1",
      prUrl: null,
    });

    await upsertHistory(repoPath, task);
    const loaded = await loadHistory(repoPath);

    expect(loaded[0].status).toBe("failed");
    expect(loaded[0].error).toBe("Claude exited with code 1");
  });

  test("different repos have independent histories", async () => {
    const repoA = makeFakeDataDir();
    const repoB = makeFakeDataDir();

    await upsertHistory(repoA, makeTask({ prompt: "task A" }));
    await upsertHistory(repoB, makeTask({ prompt: "task B" }));

    const loadedA = await loadHistory(repoA);
    const loadedB = await loadHistory(repoB);

    expect(loadedA).toHaveLength(1);
    expect(loadedA[0].prompt).toBe("task A");
    expect(loadedB).toHaveLength(1);
    expect(loadedB[0].prompt).toBe("task B");
  });

  test("removeFromHistory deletes a task by taskId", async () => {
    const repoPath = makeFakeDataDir();
    const task1 = makeTask({ prompt: "task 1" });
    const task2 = makeTask({ prompt: "task 2" });
    const task3 = makeTask({ prompt: "task 3" });

    await upsertHistory(repoPath, task1);
    await upsertHistory(repoPath, task2);
    await upsertHistory(repoPath, task3);

    await removeFromHistory(repoPath, task2.taskId);
    const loaded = await loadHistory(repoPath);

    expect(loaded).toHaveLength(2);
    expect(loaded.map((t) => t.prompt)).toEqual(["task 1", "task 3"]);
  });

  test("removeFromHistory with nonexistent taskId is a no-op", async () => {
    const repoPath = makeFakeDataDir();
    const task = makeTask({ prompt: "keep me" });

    await upsertHistory(repoPath, task);
    await removeFromHistory(repoPath, "deer_nonexistent");

    const loaded = await loadHistory(repoPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].prompt).toBe("keep me");
  });

  test("removeFromHistory on nonexistent file is a no-op", async () => {
    const repoPath = makeFakeDataDir();
    await removeFromHistory(repoPath, "deer_whatever");
    const loaded = await loadHistory(repoPath);
    expect(loaded).toEqual([]);
  });

  test("upsertHistory appends when task does not exist", async () => {
    const repoPath = makeFakeDataDir();
    const task = makeTask({ prompt: "new task" });

    await upsertHistory(repoPath, task);
    const loaded = await loadHistory(repoPath);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe(task.taskId);
    expect(loaded[0].prompt).toBe("new task");
  });

  test("upsertHistory replaces existing task by taskId", async () => {
    const repoPath = makeFakeDataDir();
    const taskId = generateTaskId();

    // Write initial "running" state
    await upsertHistory(repoPath, makeTask({
      taskId,
      prompt: "fix the bug",
      status: "running",
      completedAt: null,
      elapsed: 0,
    }));

    // Upsert should replace the running entry
    await upsertHistory(repoPath, makeTask({
      taskId,
      prompt: "fix the bug",
      status: "cancelled",
      completedAt: new Date().toISOString(),
      elapsed: 120,
    }));

    const loaded = await loadHistory(repoPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe("cancelled");
    expect(loaded[0].elapsed).toBe(120);
  });

  test("upsertHistory preserves other tasks when replacing", async () => {
    const repoPath = makeFakeDataDir();
    const taskId = generateTaskId();

    await upsertHistory(repoPath, makeTask({ prompt: "task before" }));
    await upsertHistory(repoPath, makeTask({ taskId, prompt: "the task", status: "running", completedAt: null, elapsed: 0 }));
    await upsertHistory(repoPath, makeTask({ prompt: "task after" }));

    // Now update the running task to cancelled
    await upsertHistory(repoPath, makeTask({ taskId, prompt: "the task", status: "cancelled" }));

    const loaded = await loadHistory(repoPath);
    expect(loaded).toHaveLength(3);
    expect(loaded[0].prompt).toBe("task before");
    expect(loaded[1].prompt).toBe("the task");
    expect(loaded[1].status).toBe("cancelled");
    expect(loaded[2].prompt).toBe("task after");
  });

  test("loadAllHistory returns tasks from all repos", async () => {
    const repoA = makeFakeDataDir();
    const repoB = makeFakeDataDir();
    const taskA = makeTask({ prompt: "task in repo A" });
    const taskB = makeTask({ prompt: "task in repo B" });

    await upsertHistory(repoA, taskA);
    await upsertHistory(repoB, taskB);

    const all = await loadAllHistory();
    const ids = all.map((t) => t.taskId);
    expect(ids).toContain(taskA.taskId);
    expect(ids).toContain(taskB.taskId);
  });

  test("loadAllHistory returns empty array when history dir has no matching files", async () => {
    // This just verifies it doesn't throw on a (potentially) empty dir
    const result = await loadAllHistory();
    expect(Array.isArray(result)).toBe(true);
  });

  test("running tasks can be persisted and loaded", async () => {
    const repoPath = makeFakeDataDir();
    const task = makeTask({
      status: "running",
      completedAt: null,
      elapsed: 0,
      prUrl: null,
      lastActivity: "",
    });

    await upsertHistory(repoPath, task);
    const loaded = await loadHistory(repoPath);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe("running");
    expect(loaded[0].completedAt).toBeNull();
  });
});
