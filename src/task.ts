import { mkdir } from "node:fs/promises";

export interface Task {
  /** @example "deer_01jm8k3nxa7f" */
  id: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  /** @example "/home/user/repos/my-project" */
  repo: string;
  /** @example "github.com/org/repo" */
  repoRemote: string;
  /** @example "main" */
  baseBranch: string;
  /** @example "deer/deer_01jm8k3n" */
  workBranch: string;
  /** @example "~/.local/share/deer/tasks/deer_01jm8k3n/worktree" */
  worktreePath: string;
  /** Full task markdown */
  instruction: string;
  /** @example "https://github.com/org/repo/issues/42" */
  instructionSource: string;
  env: Record<string, string>;
  networkAllowlist: string[];
  /**
   * @default 1800000 (30 minutes)
   */
  timeoutMs: number;
  setupCommand?: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  prUrl: string | null;
  error: string | null;
}

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

/**
 * Returns the directory for persisted Q&A transcripts.
 * @example "/home/user/.local/share/deer/transcripts"
 */
export function transcriptsDir(): string {
  return `${dataDir()}/transcripts`;
}

// ── Task History Persistence ──────────────────────────────────────────

export interface PersistedTask {
  /** @example "deer_01jm8k3nxa7f" */
  taskId: string;
  prompt: string;
  status: "completed" | "failed" | "cancelled";
  /** ISO 8601 timestamp */
  createdAt: string;
  /** ISO 8601 timestamp */
  completedAt: string;
  /** Elapsed seconds */
  elapsed: number;
  /** @example "https://github.com/org/repo/pull/42" */
  prUrl: string | null;
  error: string | null;
  /** Path to persisted Q&A transcript markdown file */
  transcriptPath: string | null;
  lastActivity: string;
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
 * Append a completed/failed/cancelled task to the repo's history file.
 */
export async function appendToHistory(repoPath: string, task: PersistedTask): Promise<void> {
  const path = historyPath(repoPath);
  const dir = `${dataDir()}/history`;
  await mkdir(dir, { recursive: true });

  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(path, existing + JSON.stringify(task) + "\n");
}
