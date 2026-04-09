import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * A resumable deerbox task found on disk.
 */
export interface ContinuableTask {
  taskId: string;
  worktreePath: string;
  branch: string;
}

/**
 * Finds the most recent resumable deerbox task for a given repository.
 *
 * Scans `<dataDir>/tasks/<repoSlug>/` for task directories (sorted by task ID,
 * which embeds a timestamp), verifies the worktree directory still exists, and
 * reads the current branch from git. Returns the first valid entry, or null if
 * none is found.
 */
export async function findMostRecentTask(repoPath: string): Promise<ContinuableTask | null> {
  const tasksDir = join(dataDir(), "tasks", repoSlug(repoPath));

  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    return null;
  }

  // Task IDs embed a base36 timestamp — lexicographic descending = most recent first
  const sorted = entries
    .filter((e) => e.startsWith("deer_"))
    .sort()
    .reverse();

  for (const taskId of sorted) {
    const worktreePath = join(tasksDir, taskId, "worktree");

    try {
      const s = await stat(worktreePath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const branchResult = await Bun.$`git -C ${worktreePath} rev-parse --abbrev-ref HEAD`.quiet().nothrow();
    if (branchResult.exitCode !== 0) continue;
    const branch = branchResult.stdout.toString().trim();
    if (!branch || branch === "HEAD") continue;

    return { taskId, worktreePath, branch };
  }

  return null;
}

/**
 * Generate a unique, sortable, URL-safe task ID.
 *
 * Format: `deer_<base36-timestamp><random-suffix>`
 * @duplicate src/task.ts — keep both in sync
 */
export function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(random)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 8);
  return `deer_${timestamp}${suffix}`;
}

/**
 * Returns the base data directory for deer task storage.
 * @duplicate src/task.ts — keep both in sync
 * @example "/home/user/.local/share/deer"
 */
export function dataDir(): string {
  if (process.env.DEER_DATA_DIR) return process.env.DEER_DATA_DIR;
  const home = process.env.HOME;
  return `${home}/.local/share/deer`;
}

/**
 * Derive a human-readable slug from a repository path.
 * Uses the directory basename, which is sufficient for scoping tasks
 * on the same machine.
 * @duplicate src/task.ts — keep both in sync
 * @example repoSlug("/home/user/projects/my-app") => "my-app"
 */
export function repoSlug(repoPath: string): string {
  return require("node:path").basename(repoPath);
}
