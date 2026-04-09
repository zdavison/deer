import { test, expect, describe, afterAll } from "bun:test";
import { findMostRecentTask, generateTaskId, repoSlug } from "../packages/deerbox/src/task";
import { mkdir, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";

const testDataDir = realpathSync(mkdtempSync(join(tmpdir(), "deer-continue-test-")));
process.env.DEER_DATA_DIR = testDataDir;

afterAll(async () => {
  delete process.env.DEER_DATA_DIR;
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
});

async function setupGitWorktree(worktreePath: string, branch: string): Promise<void> {
  await mkdir(worktreePath, { recursive: true });
  await Bun.$`git init --initial-branch=${branch} ${worktreePath}`.quiet();
  await Bun.$`git -C ${worktreePath} config user.email "test@deer.dev"`.quiet();
  await Bun.$`git -C ${worktreePath} config user.name "Deer Test"`.quiet();
  await Bun.$`git -C ${worktreePath} commit --allow-empty -m "init"`.quiet();
}

async function createTaskDir(repoPath: string, taskId: string, withWorktree: boolean, branch?: string): Promise<void> {
  const taskDir = join(testDataDir, "tasks", repoSlug(repoPath), taskId);
  await mkdir(taskDir, { recursive: true });
  if (withWorktree) {
    await setupGitWorktree(join(taskDir, "worktree"), branch ?? `deer/${taskId}`);
  }
}

describe("findMostRecentTask", () => {
  test("returns null when no tasks directory exists", async () => {
    const result = await findMostRecentTask("/nonexistent/repo/path");
    expect(result).toBeNull();
  });

  test("returns null when tasks dir has no deer_ entries", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "deer-noop-"));
    try {
      await mkdir(join(testDataDir, "tasks", repoSlug(repoDir)), { recursive: true });
      const result = await findMostRecentTask(repoDir);
      expect(result).toBeNull();
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("returns null when task dir exists but worktree directory is missing", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "deer-nowt-"));
    try {
      const taskId = generateTaskId();
      await createTaskDir(repoDir, taskId, false);
      const result = await findMostRecentTask(repoDir);
      expect(result).toBeNull();
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("returns the task when a valid worktree with a git branch exists", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "deer-valid-"));
    try {
      const taskId = generateTaskId();
      const branch = `deer/${taskId}`;
      await createTaskDir(repoDir, taskId, true, branch);

      const result = await findMostRecentTask(repoDir);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe(taskId);
      expect(result!.branch).toBe(branch);
      expect(result!.worktreePath).toContain(taskId);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("returns the most recent task when multiple valid tasks exist", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "deer-multi-"));
    try {
      const taskId1 = generateTaskId();
      await Bun.sleep(2);
      const taskId2 = generateTaskId();

      await createTaskDir(repoDir, taskId1, true);
      await createTaskDir(repoDir, taskId2, true);

      const result = await findMostRecentTask(repoDir);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe(taskId2);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("skips tasks with missing worktrees and falls back to the next valid one", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "deer-fallback-"));
    try {
      const taskId1 = generateTaskId();
      await Bun.sleep(2);
      const taskId2 = generateTaskId();

      await createTaskDir(repoDir, taskId1, true);
      await createTaskDir(repoDir, taskId2, false); // newer but no worktree

      const result = await findMostRecentTask(repoDir);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe(taskId1);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
