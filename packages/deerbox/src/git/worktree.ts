import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { dataDir } from "../task";

export interface WorktreeInfo {
  repoPath: string;
  worktreePath: string;
  branch: string;
}

export interface RepoInfo {
  repoPath: string;
  defaultBranch: string;
}

/**
 * Detect the git repository by walking up from `startDir`.
 * @duplicate src/git/detect.ts — keep both in sync
 */
export async function detectRepo(startDir: string): Promise<RepoInfo> {
  const result =
    await Bun.$`git -C ${startDir} rev-parse --show-toplevel`.quiet().nothrow();

  if (result.exitCode !== 0) {
    throw new Error(
      `Not a git repository (searched from ${startDir})`
    );
  }

  const repoPath = result.stdout.toString().trim();

  // Get default branch
  const branchResult =
    await Bun.$`git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD`.quiet().nothrow();

  let defaultBranch: string;
  if (branchResult.exitCode === 0) {
    // refs/remotes/origin/HEAD → extract branch name
    defaultBranch = branchResult.stdout
      .toString()
      .trim()
      .replace("refs/remotes/origin/", "");
  } else {
    // Fallback: check if main or master exists
    const mainCheck =
      await Bun.$`git -C ${repoPath} show-ref --verify --quiet refs/heads/main`.quiet().nothrow();
    defaultBranch = mainCheck.exitCode === 0 ? "main" : "master";
  }

  return { repoPath, defaultBranch };
}

/**
 * Create a git worktree for a task.
 *
 * Branch: `deer/<taskId>`
 * Path: `~/.local/share/deer/tasks/<taskId>/worktree`
 */
export async function createWorktree(
  repoPath: string,
  taskId: string,
  baseBranch: string
): Promise<WorktreeInfo> {
  const branch = `deer/${taskId}`;
  const worktreePath = join(dataDir(), "tasks", taskId, "worktree");

  // Ensure parent directory exists
  await mkdir(join(dataDir(), "tasks", taskId), { recursive: true });

  const result =
    await Bun.$`git -C ${repoPath} worktree add -b ${branch} ${worktreePath} ${baseBranch}`.quiet();

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create worktree: ${result.stderr.toString()}`
    );
  }

  return { repoPath, worktreePath, branch };
}

/**
 * Create a git worktree for a task by checking out an existing branch.
 *
 * Unlike `createWorktree`, this does NOT create a new branch — it checks
 * out the given branch as-is. Used with `--from` to continue work on an
 * existing branch.
 *
 * Path: `~/.local/share/deer/tasks/<taskId>/worktree`
 */
export async function checkoutWorktree(
  repoPath: string,
  taskId: string,
  branch: string,
): Promise<WorktreeInfo> {
  const worktreePath = join(dataDir(), "tasks", taskId, "worktree");

  await mkdir(join(dataDir(), "tasks", taskId), { recursive: true });

  // Fetch the branch from origin in case it only exists remotely
  await Bun.$`git -C ${repoPath} fetch origin ${branch}:${branch}`.quiet().nothrow();

  const result = await Bun.$`git -C ${repoPath} worktree add ${worktreePath} ${branch}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to checkout worktree for branch '${branch}': ${result.stderr.toString()}`,
    );
  }

  return { repoPath, worktreePath, branch };
}

/**
 * Remove a worktree and its branch reference.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  // Detect the branch name before removing the worktree
  const branchResult =
    await Bun.$`git -C ${worktreePath} rev-parse --abbrev-ref HEAD`.quiet().nothrow();
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.toString().trim() : null;

  const result =
    await Bun.$`git -C ${repoPath} worktree remove ${worktreePath} --force`.quiet();

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to remove worktree: ${result.stderr.toString()}`
    );
  }

  // Clean up the worktree branch if it was a deer branch
  if (branch?.startsWith("deer/")) {
    await Bun.$`git -C ${repoPath} branch -D ${branch}`.quiet().nothrow();
  }
}

/**
 * Clean up a worktree and optionally delete the branch.
 */
export async function cleanupWorktree(
  repoPath: string,
  worktreePath: string,
  branch?: string,
): Promise<void> {
  await Bun.$`git -C ${repoPath} worktree remove ${worktreePath} --force`.quiet().nothrow();
  if (branch) {
    await Bun.$`git -C ${repoPath} branch -D ${branch}`.quiet().nothrow();
  }
}
