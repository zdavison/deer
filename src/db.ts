/**
 * SQLite database module — single source of truth for task state.
 *
 * Uses bun:sqlite (synchronous API) with WAL mode for concurrent reads
 * across multiple deer instances.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dataDir } from "./task";
import type { AgentStatus } from "./state-machine";

// ── Types ────────────────────────────────────────────────────────────

export interface TaskRow {
  task_id: string;
  repo_path: string;
  repo_hash: string;
  prompt: string;
  base_branch: string;
  branch: string;
  worktree_path: string;
  model: string | null;
  status: string;
  pr_url: string | null;
  pr_state: string | null;
  final_branch: string | null;
  cost: number | null;
  error: string | null;
  last_activity: string;
  elapsed: number;
  idle: number;
  created_at: number;
  finished_at: number | null;
  poller_pid: number | null;
}

// ── Database singleton ───────────────────────────────────────────────

let _db: Database | null = null;

function dbPath(): string {
  return `${dataDir()}/deer.db`;
}

export function getDb(): Database {
  if (_db) return _db;
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(dbPath());
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id       TEXT PRIMARY KEY,
      repo_path     TEXT NOT NULL,
      repo_hash     TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      base_branch   TEXT NOT NULL,
      branch        TEXT NOT NULL DEFAULT '',
      worktree_path TEXT NOT NULL DEFAULT '',
      model         TEXT,
      status        TEXT NOT NULL DEFAULT 'setup',
      pr_url        TEXT,
      pr_state      TEXT,
      final_branch  TEXT,
      cost          REAL,
      error         TEXT,
      last_activity TEXT NOT NULL DEFAULT '',
      elapsed       INTEGER NOT NULL DEFAULT 0,
      idle          INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      poller_pid    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_repo_hash ON tasks(repo_hash);
  `);
  _db = db;
  return db;
}

/**
 * Close the database and reset the singleton.
 * Primarily for tests to avoid sharing state between test runs.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

export function repoHash(repoPath: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(repoPath);
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Returns true if the process with the given PID is still running.
 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── CRUD operations ──────────────────────────────────────────────────

export interface InsertTaskFields {
  taskId: string;
  repoPath: string;
  prompt: string;
  baseBranch: string;
  branch?: string;
  worktreePath?: string;
  model?: string;
  status?: AgentStatus;
  createdAt: number;
}

export function insertTask(fields: InsertTaskFields): void {
  const db = getDb();
  db.run(
    `INSERT INTO tasks (task_id, repo_path, repo_hash, prompt, base_branch, branch, worktree_path, model, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.taskId,
      fields.repoPath,
      repoHash(fields.repoPath),
      fields.prompt,
      fields.baseBranch,
      fields.branch ?? "",
      fields.worktreePath ?? "",
      fields.model ?? null,
      fields.status ?? "setup",
      fields.createdAt,
    ],
  );
}

/** Updatable task fields (all optional — only provided fields are SET). */
export interface UpdateTaskFields {
  status?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string | null;
  prState?: string | null;
  finalBranch?: string | null;
  cost?: number | null;
  error?: string | null;
  lastActivity?: string;
  elapsed?: number;
  idle?: boolean;
  finishedAt?: number | null;
  pollerPid?: number | null;
}

const FIELD_TO_COLUMN: Record<string, string> = {
  status: "status",
  branch: "branch",
  worktreePath: "worktree_path",
  prUrl: "pr_url",
  prState: "pr_state",
  finalBranch: "final_branch",
  cost: "cost",
  error: "error",
  lastActivity: "last_activity",
  elapsed: "elapsed",
  idle: "idle",
  finishedAt: "finished_at",
  pollerPid: "poller_pid",
};

export function updateTask(taskId: string, fields: UpdateTaskFields): void {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (key in fields) {
      setClauses.push(`${column} = ?`);
      let value = (fields as Record<string, unknown>)[key];
      // Convert boolean idle to integer for SQLite
      if (key === "idle") value = value ? 1 : 0;
      values.push(value ?? null);
    }
  }

  if (setClauses.length === 0) return;
  values.push(taskId);

  const db = getDb();
  db.run(`UPDATE tasks SET ${setClauses.join(", ")} WHERE task_id = ?`, values);
}

export function getTask(taskId: string): TaskRow | null {
  const db = getDb();
  return db.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | null;
}

export function getTasksByRepo(repoPath: string): TaskRow[] {
  const db = getDb();
  const hash = repoHash(repoPath);
  return db.query("SELECT * FROM tasks WHERE repo_hash = ? ORDER BY created_at").all(hash) as TaskRow[];
}

export function getAllTasks(): TaskRow[] {
  const db = getDb();
  return db.query("SELECT * FROM tasks ORDER BY created_at").all() as TaskRow[];
}

export function deleteTaskRow(taskId: string): void {
  const db = getDb();
  db.run("DELETE FROM tasks WHERE task_id = ?", [taskId]);
}

/**
 * CAS: set poller_pid only if null or the existing poller process is dead.
 * Returns true if this process successfully claimed the poller slot.
 */
export function claimPoller(taskId: string, pid: number): boolean {
  const db = getDb();
  const row = db.query("SELECT poller_pid FROM tasks WHERE task_id = ?").get(taskId) as { poller_pid: number | null } | null;
  if (!row) return false;

  if (row.poller_pid === null || row.poller_pid === pid || !isProcessAlive(row.poller_pid)) {
    db.run("UPDATE tasks SET poller_pid = ? WHERE task_id = ?", [pid, taskId]);
    return true;
  }
  return false;
}

/**
 * Clear poller_pid if it matches the given pid.
 */
export function releasePoller(taskId: string, pid: number): void {
  const db = getDb();
  db.run("UPDATE tasks SET poller_pid = NULL WHERE task_id = ? AND poller_pid = ?", [taskId, pid]);
}

/**
 * Clear all poller_pid entries for this process (shutdown cleanup).
 */
export function releaseAllPollers(pid: number): void {
  const db = getDb();
  db.run("UPDATE tasks SET poller_pid = NULL WHERE poller_pid = ?", [pid]);
}
