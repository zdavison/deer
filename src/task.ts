import { mkdir } from "node:fs/promises";

/**
 * Generate a unique, sortable, URL-safe task ID.
 *
 * Format: `deer_<base36-timestamp><random-suffix>`
 * - Timestamp prefix makes IDs sortable by creation time
 * - Random suffix ensures uniqueness across concurrent invocations
 * - All characters are URL-safe (lowercase alphanumeric + underscore prefix)
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
 * @example "/home/user/.local/share/deer"
 */
export function dataDir(): string {
  const home = process.env.HOME;
  return `${home}/.local/share/deer`;
}

// ── Task Types ───────────────────────────────────────────────────────

/** Shared fields common to all task representations. */
export interface TaskMetadata {
  /** @example "deer_01jm8k3nxa7f" */
  taskId: string;
  prompt: string;
  status: "running" | "failed" | "cancelled";
  /** Elapsed seconds */
  elapsed: number;
  lastActivity: string;
  /** @example "https://github.com/org/repo/pull/42" */
  prUrl: string | null;
  /** @example "deer/fix-login-bug" */
  finalBranch: string | null;
  error: string | null;
}

// ── Task History Persistence ──────────────────────────────────────────

export interface PersistedTask extends TaskMetadata {
  /** ISO 8601 timestamp */
  createdAt: string;
  /** ISO 8601 timestamp — null while task is still running */
  completedAt: string | null;
}

/**
 * Returns the JSONL file path for a repo's task history.
 * Scoped by a hash of the repo's absolute path.
 * @example "/home/user/.local/share/deer/history/a1b2c3d4e5f6.jsonl"
 */
export function historyPath(repoPath: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(repoPath);
  const hash = hasher.digest("hex").slice(0, 16);
  return `${dataDir()}/history/${hash}.jsonl`;
}

/**
 * Load all persisted tasks for a repo.
 * Returns an empty array if no history file exists.
 */
export async function loadHistory(repoPath: string): Promise<PersistedTask[]> {
  const path = historyPath(repoPath);
  const file = Bun.file(path);
  if (!(await file.exists())) return [];

  const text = await file.text();
  const tasks: PersistedTask[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      tasks.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return tasks;
}

/**
 * Remove a task from the repo's history file by taskId.
 */
export async function removeFromHistory(repoPath: string, taskId: string): Promise<void> {
  const path = historyPath(repoPath);
  const file = Bun.file(path);
  if (!(await file.exists())) return;

  const text = await file.text();
  const lines = text.split("\n").filter((line) => {
    if (!line.trim()) return false;
    try {
      const task: PersistedTask = JSON.parse(line);
      return task.taskId !== taskId;
    } catch {
      return true;
    }
  });
  await Bun.write(path, lines.length > 0 ? lines.join("\n") + "\n" : "");
}

/**
 * Insert or replace a task in the repo's history file by taskId.
 * If a task with the same taskId already exists, it is replaced in-place.
 * Otherwise the task is appended. Use this instead of appendToHistory when
 * a task may have been previously written (e.g. to persist the running state
 * and later update it with the final outcome).
 */
export async function upsertHistory(repoPath: string, task: PersistedTask): Promise<void> {
  const path = historyPath(repoPath);
  const dir = `${dataDir()}/history`;
  await mkdir(dir, { recursive: true });

  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";

  let replaced = false;
  const lines = existing.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const t: PersistedTask = JSON.parse(line);
      if (t.taskId === task.taskId) {
        replaced = true;
        return [JSON.stringify(task)];
      }
    } catch {
      // keep malformed lines as-is
    }
    return [line];
  });

  if (!replaced) lines.push(JSON.stringify(task));
  await Bun.write(path, lines.join("\n") + "\n");
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
