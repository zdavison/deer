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
