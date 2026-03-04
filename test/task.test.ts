import { test, expect, describe, afterEach } from "bun:test";
import { generateTaskId, dataDir, historyPath, loadHistory, appendToHistory } from "../src/task";
import type { PersistedTask } from "../src/task";
import { rm, mkdtemp } from "node:fs/promises";
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
      status: "completed",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      elapsed: 45,
      prUrl: "https://github.com/org/repo/pull/1",
      error: null,
      transcriptPath: null,
      lastActivity: "PR ready",
      ...overrides,
    };
  }

  test("loadHistory returns empty array when no file exists", async () => {
    const result = await loadHistory("/nonexistent/repo/path/xyz");
    expect(result).toEqual([]);
  });

  test("appendToHistory + loadHistory roundtrip", async () => {
    const repoPath = makeFakeDataDir();
    const task = makeTask();

    await appendToHistory(repoPath, task);
    const loaded = await loadHistory(repoPath);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe(task.taskId);
    expect(loaded[0].prompt).toBe(task.prompt);
    expect(loaded[0].prUrl).toBe(task.prUrl);
  });

  test("multiple appends accumulate", async () => {
    const repoPath = makeFakeDataDir();

    await appendToHistory(repoPath, makeTask({ prompt: "task 1" }));
    await appendToHistory(repoPath, makeTask({ prompt: "task 2" }));
    await appendToHistory(repoPath, makeTask({ prompt: "task 3" }));

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

    await appendToHistory(repoPath, task);
    const loaded = await loadHistory(repoPath);

    expect(loaded[0].status).toBe("failed");
    expect(loaded[0].error).toBe("Claude exited with code 1");
  });

  test("different repos have independent histories", async () => {
    const repoA = makeFakeDataDir();
    const repoB = makeFakeDataDir();

    await appendToHistory(repoA, makeTask({ prompt: "task A" }));
    await appendToHistory(repoB, makeTask({ prompt: "task B" }));

    const loadedA = await loadHistory(repoA);
    const loadedB = await loadHistory(repoB);

    expect(loadedA).toHaveLength(1);
    expect(loadedA[0].prompt).toBe("task A");
    expect(loadedB).toHaveLength(1);
    expect(loadedB[0].prompt).toBe("task B");
  });
});
