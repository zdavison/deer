import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { detectRepo, createWorktree, checkoutWorktree, removeWorktree, generateTaskId, dataDir } from "../../packages/deerbox/src/index";
import { mkdtemp, rm, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Create a bare-bones git repo with an initial commit and an origin remote
 * pointing at a bare repo (so push works locally).
 */
async function createTestRepo(dir: string): Promise<{
  repoPath: string;
}> {
  const barePath = join(dir, "bare.git");
  const repoPath = join(dir, "repo");

  // Create a bare repo with "main" as the default branch
  await Bun.$`git init --bare --initial-branch=main ${barePath}`.quiet();

  // Clone it to get a working repo with origin set up
  await Bun.$`git clone ${barePath} ${repoPath}`.quiet();

  // Configure user for commits in this repo
  await Bun.$`git -C ${repoPath} config user.email "test@deer.dev"`.quiet();
  await Bun.$`git -C ${repoPath} config user.name "Deer Test"`.quiet();

  // Create an initial commit so we have a branch
  await Bun.$`git -C ${repoPath} checkout -b main`.quiet();
  await Bun.$`git -C ${repoPath} commit --allow-empty -m "initial commit"`.quiet();
  await Bun.$`git -C ${repoPath} push -u origin main`.quiet();

  return { repoPath };
}

describe("detectRepo", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "deer-git-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("finds .git walking up from subdirectory", async () => {
    const { repoPath } = await createTestRepo(tmpDir);
    const subDir = join(repoPath, "src", "deep", "nested");
    await mkdir(subDir, { recursive: true });

    const result = await detectRepo(subDir);

    expect(result.repoPath).toBe(repoPath);
    expect(result.defaultBranch).toBe("main");
  });

  test("finds .git from repo root directly", async () => {
    const { repoPath } = await createTestRepo(tmpDir);

    const result = await detectRepo(repoPath);
    expect(result.repoPath).toBe(repoPath);
  });

  test("errors when not in a git repo", async () => {
    const noGitDir = join(tmpDir, "no-git");
    await mkdir(noGitDir, { recursive: true });

    expect(detectRepo(noGitDir)).rejects.toThrow();
  });
});

describe("createWorktree", () => {
  let tmpDir: string;
  const createdWorktrees: Array<{ repoPath: string; worktreePath: string }> = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-wt-test-"));
    createdWorktrees.length = 0;
  });

  afterEach(async () => {
    // Clean up worktrees from the real dataDir
    for (const wt of createdWorktrees) {
      await Bun.$`git -C ${wt.repoPath} worktree remove ${wt.worktreePath} --force`
        .quiet()
        .nothrow();
      const taskDir = join(wt.worktreePath, "..");
      await rm(taskDir, { recursive: true, force: true });
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creates directory and git worktree", async () => {
    const { repoPath } = await createTestRepo(tmpDir);
    const taskId = generateTaskId();

    const info = await createWorktree(repoPath, taskId, "main");
    createdWorktrees.push({ repoPath, worktreePath: info.worktreePath });

    // Worktree directory should exist
    expect(await Bun.file(join(info.worktreePath, ".git")).exists()).toBe(true);

    // Branch should be checked out
    const branch =
      await Bun.$`git -C ${info.worktreePath} rev-parse --abbrev-ref HEAD`.text();
    expect(branch.trim()).toBe(`deer/${taskId}`);
  });

  test("branch name follows deer/<taskId> convention", async () => {
    const { repoPath } = await createTestRepo(tmpDir);
    const taskId = generateTaskId();

    const info = await createWorktree(repoPath, taskId, "main");
    createdWorktrees.push({ repoPath, worktreePath: info.worktreePath });

    expect(info.branch).toBe(`deer/${taskId}`);
  });

  test("worktree path is under dataDir/tasks/<taskId>/worktree", async () => {
    const { repoPath } = await createTestRepo(tmpDir);
    const taskId = generateTaskId();

    const info = await createWorktree(repoPath, taskId, "main");
    createdWorktrees.push({ repoPath, worktreePath: info.worktreePath });

    expect(info.worktreePath).toContain(taskId);
    expect(info.worktreePath).toEndWith("/worktree");
    expect(info.worktreePath).toStartWith(dataDir());
  });
});

describe("checkoutWorktree", () => {
  let tmpDir: string;
  const createdWorktrees: Array<{ repoPath: string; worktreePath: string }> = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-checkout-test-"));
    createdWorktrees.length = 0;
  });

  afterEach(async () => {
    for (const wt of createdWorktrees) {
      await Bun.$`git -C ${wt.repoPath} worktree remove ${wt.worktreePath} --force`.quiet().nothrow();
      const taskDir = join(wt.worktreePath, "..");
      await rm(taskDir, { recursive: true, force: true });
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("checks out existing branch without creating a new one", async () => {
    const { repoPath } = await createTestRepo(tmpDir);

    // Create a feature branch
    await Bun.$`git -C ${repoPath} checkout -b feature/test-branch`.quiet();
    await Bun.$`git -C ${repoPath} commit --allow-empty -m "feature commit"`.quiet();
    await Bun.$`git -C ${repoPath} checkout main`.quiet();

    const taskId = generateTaskId();
    const info = await checkoutWorktree(repoPath, taskId, "feature/test-branch");
    createdWorktrees.push({ repoPath, worktreePath: info.worktreePath });

    expect(await Bun.file(join(info.worktreePath, ".git")).exists()).toBe(true);

    const branch = await Bun.$`git -C ${info.worktreePath} rev-parse --abbrev-ref HEAD`.text();
    expect(branch.trim()).toBe("feature/test-branch");
    expect(info.branch).toBe("feature/test-branch");
  });

  test("worktree path is under dataDir/tasks/<taskId>/worktree", async () => {
    const { repoPath } = await createTestRepo(tmpDir);
    await Bun.$`git -C ${repoPath} checkout -b feature/test-branch`.quiet();
    await Bun.$`git -C ${repoPath} commit --allow-empty -m "feature"`.quiet();
    await Bun.$`git -C ${repoPath} checkout main`.quiet();

    const taskId = generateTaskId();
    const info = await checkoutWorktree(repoPath, taskId, "feature/test-branch");
    createdWorktrees.push({ repoPath, worktreePath: info.worktreePath });

    expect(info.worktreePath).toContain(taskId);
    expect(info.worktreePath).toEndWith("/worktree");
    expect(info.worktreePath).toStartWith(dataDir());
  });

  test("throws for non-existent branch", async () => {
    const { repoPath } = await createTestRepo(tmpDir);
    const taskId = generateTaskId();

    expect(checkoutWorktree(repoPath, taskId, "non-existent-branch")).rejects.toThrow();
  });
});

describe("removeWorktree", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-rm-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("cleans up worktree directory", async () => {
    const { repoPath } = await createTestRepo(tmpDir);
    const taskId = generateTaskId();
    const info = await createWorktree(repoPath, taskId, "main");

    // Worktree exists
    expect(await Bun.file(join(info.worktreePath, ".git")).exists()).toBe(true);

    await removeWorktree(repoPath, info.worktreePath);

    // Worktree directory should be gone
    const exists = await Bun.file(join(info.worktreePath, ".git")).exists();
    expect(exists).toBe(false);

    // Clean up the task directory
    const taskDir = join(info.worktreePath, "..");
    await rm(taskDir, { recursive: true, force: true });
  });
});
