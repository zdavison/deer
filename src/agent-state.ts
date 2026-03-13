import type { AgentStatus } from "./state-machine";
import type { TaskRow } from "./db";

// ── Types ────────────────────────────────────────────────────────────

export interface TeardownResult {
  finalBranch: string;
  prUrl: string;
}

export interface LogEntry {
  text: string;
  verbose: boolean;
}

export interface AgentState {
  /** Persistent task ID (deer_xxx format) for history storage and React key */
  taskId: string;
  prompt: string;
  /** @example "main" */
  baseBranch: string;
  status: AgentStatus;
  /** Elapsed seconds */
  elapsed: number;
  /** Last activity from tmux pane capture */
  lastActivity: string;
  /** Log entries (capped) */
  logs: LogEntry[];
  /** Teardown result */
  result: TeardownResult | null;
  /** Error message on failure */
  error: string;
  /** PR state on GitHub */
  prState: "open" | "merged" | "closed" | null;
  /** True when Claude is idle (waiting for user input) */
  idle: boolean;
  /** True while a PR is being created */
  creatingPr: boolean;
  /** True while an existing PR is being updated (new commits pushed) */
  updatingPr: boolean;
  /** True if this task has been explicitly deleted (suppresses cleanup) */
  deleted: boolean;
  /** ISO 8601 timestamp when the task was created */
  createdAt: string;
  /** Path to the git worktree for this task */
  worktreePath: string;
  /** Git branch name for this task */
  branch: string;
  /** Cumulative API cost in USD (only set when using pay-as-you-go API key) */
  cost: number | null;
}

// ── Factory ──────────────────────────────────────────────────────────

/** Factory for AgentState with sensible defaults. */
export function createAgentState(overrides: Partial<AgentState>): AgentState {
  return {
    taskId: "",
    prompt: "",
    baseBranch: "main",
    status: "setup",
    elapsed: 0,
    lastActivity: "",
    logs: [],
    result: null,
    error: "",
    prState: null,
    idle: false,
    creatingPr: false,
    updatingPr: false,
    deleted: false,
    createdAt: new Date().toISOString(),
    worktreePath: "",
    branch: "",
    cost: null,
    ...overrides,
  };
}

// ── DB row → AgentState ──────────────────────────────────────────────

// Statuses that represent a graceful terminal outcome.
// Preserved as-is instead of being overridden with "interrupted".
const TERMINAL_STATUSES = new Set<string>(["cancelled", "failed", "pr_failed"]);

/**
 * Build an AgentState from a database row plus live tmux status.
 *
 * - If DB says "running"/"setup" but tmux is dead → "interrupted"
 * - Derives lastActivity: if interrupted and not idle → "Interrupted — deer was closed"
 * - Logs are always empty (captured from tmux on render, never stored)
 */
export function agentFromDbRow(row: TaskRow, tmuxAlive: boolean): AgentState {
  const dbStatus = row.status as AgentStatus;
  const isIdle = !!row.idle;

  let status: AgentStatus;
  if ((dbStatus === "running" || dbStatus === "setup") && !tmuxAlive) {
    status = TERMINAL_STATUSES.has(dbStatus) ? dbStatus : "interrupted";
  } else {
    status = dbStatus;
  }

  const lastActivity =
    status === "interrupted" && !isIdle
      ? "Interrupted — deer was closed"
      : row.last_activity;

  const branch = row.final_branch ?? row.branch;
  const result = row.final_branch
    ? { finalBranch: row.final_branch, prUrl: row.pr_url ?? "" }
    : null;

  return createAgentState({
    taskId: row.task_id,
    prompt: row.prompt,
    baseBranch: row.base_branch || "main",
    status,
    elapsed: row.elapsed,
    lastActivity,
    logs: [],
    idle: isIdle,
    result,
    error: row.error || "",
    prState: row.pr_state as AgentState["prState"],
    createdAt: new Date(row.created_at).toISOString(),
    worktreePath: row.worktree_path || "",
    branch,
    cost: row.cost ?? null,
  });
}
