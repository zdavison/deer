import type { PersistedTask } from "./task";
import type { TaskStateFile } from "./task-state";
import type { AgentStatus } from "./state-machine";

// ── Types ────────────────────────────────────────────────────────────

interface TeardownResult {
  finalBranch: string;
  prUrl: string;
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
  /** Log lines (capped) */
  logs: string[];
  /** Teardown result */
  result: TeardownResult | null;
  /** Error message on failure */
  error: string;
  /** PR state on GitHub */
  prState: "open" | "merged" | "closed" | null;
  /** True if this agent was loaded from history (not spawned this session) */
  historical: boolean;
  /** True when Claude is idle (waiting for user input) */
  idle: boolean;
  /** True while a PR is being created */
  creatingPr: boolean;
  /** True while an existing PR is being updated (new commits pushed) */
  updatingPr: boolean;
  /** True if this task has been explicitly deleted (suppresses history write on cleanup) */
  deleted: boolean;
  /** ISO 8601 timestamp when the task was created */
  createdAt: string;
  /** Path to the git worktree for this task */
  worktreePath: string;
  /** Git branch name for this task */
  branch: string;
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
    historical: false,
    idle: false,
    creatingPr: false,
    updatingPr: false,
    deleted: false,
    createdAt: new Date().toISOString(),
    worktreePath: "",
    branch: "",
    ...overrides,
  };
}

// ── Historical agent helpers ─────────────────────────────────────────

/** Convert a persisted task to a read-only AgentState for display. */
export function historicalAgent(task: PersistedTask): AgentState {
  const wasInterrupted = task.status === "running";
  return createAgentState({
    taskId: task.taskId,
    prompt: task.prompt,
    status: wasInterrupted ? "interrupted" : (task.status as AgentStatus),
    elapsed: task.elapsed,
    lastActivity: wasInterrupted ? "Interrupted — deer was closed" : task.lastActivity,
    result: task.prUrl ? { finalBranch: task.finalBranch ?? "", prUrl: task.prUrl } : null,
    error: task.error || "",
    historical: true,
    createdAt: task.createdAt,
    branch: task.finalBranch ?? `deer/${task.taskId}`,
  });
}

/**
 * Build an AgentState from a live task-state file for a task managed by
 * another deer instance. Includes full logs, idle status, and elapsed
 * as written by the owning instance.
 */
export function liveTaskFromStateFile(stateFile: TaskStateFile): AgentState {
  return createAgentState({
    taskId: stateFile.taskId,
    prompt: stateFile.prompt,
    status: "running",
    elapsed: stateFile.elapsed,
    lastActivity: stateFile.lastActivity,
    logs: [...stateFile.logs],
    idle: stateFile.idle,
    historical: true,
    result: stateFile.prUrl
      ? { finalBranch: stateFile.finalBranch ?? "", prUrl: stateFile.prUrl }
      : null,
    createdAt: stateFile.createdAt,
    worktreePath: stateFile.worktreePath,
    branch: stateFile.finalBranch ?? `deer/${stateFile.taskId}`,
  });
}

/**
 * Build an AgentState from a state file whose owning process has died.
 * Shows the task as interrupted with its last known state.
 */
export function historicalAgentFromStateFile(stateFile: TaskStateFile): AgentState {
  return createAgentState({
    taskId: stateFile.taskId,
    prompt: stateFile.prompt,
    status: "interrupted",
    elapsed: stateFile.elapsed,
    lastActivity: "Interrupted — deer was closed",
    logs: [...stateFile.logs],
    result: stateFile.prUrl
      ? { finalBranch: stateFile.finalBranch ?? "", prUrl: stateFile.prUrl }
      : null,
    error: stateFile.error || "",
    historical: true,
    createdAt: stateFile.createdAt,
    worktreePath: stateFile.worktreePath,
    branch: stateFile.finalBranch ?? `deer/${stateFile.taskId}`,
  });
}
