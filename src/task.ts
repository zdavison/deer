import { join, basename } from "node:path";
import { mkdir } from "node:fs/promises";
import { HOME } from "./constants";

/**
 * Generate a unique, sortable, URL-safe task ID.
 *
 * Format: `deer_<base36-timestamp><random-suffix>`
 * @duplicate packages/deerbox/src/task.ts — keep both in sync
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
 * @duplicate packages/deerbox/src/task.ts — keep both in sync
 * @example "/home/user/.local/share/deer"
 */
export function dataDir(): string {
  if (process.env.DEER_DATA_DIR) return process.env.DEER_DATA_DIR;
  return `${HOME}/.local/share/deer`;
}

/**
 * Derive a human-readable slug from a repository path.
 * @duplicate packages/deerbox/src/task.ts — keep both in sync
 * @example repoSlug("/home/user/projects/my-app") => "my-app"
 */
export function repoSlug(repoPath: string): string {
  return basename(repoPath);
}

/**
 * Returns the worktree path for a given task ID scoped by repository.
 */
export function taskWorktreePath(repoPath: string, taskId: string): string {
  return join(dataDir(), "tasks", repoSlug(repoPath), taskId, "worktree");
}

// ── Prompt Input History ──────────────────────────────────────────────

const PROMPT_HISTORY_MAX = 500;

function promptHistoryPath(): string {
  return `${dataDir()}/prompt-history.json`;
}

/** Load persisted prompt input history. Returns an empty array if none saved. */
export async function loadPromptHistory(): Promise<string[]> {
  const file = Bun.file(promptHistoryPath());
  if (!(await file.exists())) return [];
  try {
    const data = await file.json();
    if (Array.isArray(data)) return data as string[];
  } catch {
    // ignore malformed file
  }
  return [];
}

/** Append a new entry to the persisted prompt history, capping at PROMPT_HISTORY_MAX. */
export async function savePromptHistory(history: string[]): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const capped = history.slice(-PROMPT_HISTORY_MAX);
  await Bun.write(promptHistoryPath(), JSON.stringify(capped));
}
