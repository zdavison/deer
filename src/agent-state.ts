import { join } from "node:path";
import { dataDir } from "./task";
import type { PersistedTask } from "./task";
import type { AgentState as AgentStatus } from "./state-machine";
import type { AgentHandle } from "./agent";

// ── Types ────────────────────────────────────────────────────────────

interface TeardownResult {
  finalBranch: string;
  prUrl: string;
}

export interface AgentState {
  id: number;
  /** Persistent task ID (deer_xxx format) for history storage */
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
  /** Agent handle from the sandbox module */
  handle: AgentHandle | null;
  /** Teardown result */
  result: TeardownResult | null;
  /** Error message on failure */
  error: string;
  /** Timer handle */
  timer: ReturnType<typeof setInterval> | null;
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
  /** AbortController for cancelling the wait loop */
  abortController: AbortController | null;
}

// ── Factory ──────────────────────────────────────────────────────────

/** Factory for AgentState with sensible defaults. */
export function createAgentState(overrides: Partial<AgentState>): AgentState {
  return {
    id: 0,
    taskId: "",
    prompt: "",
    baseBranch: "main",
    status: "setup",
    elapsed: 0,
    lastActivity: "",
    logs: [],
    handle: null,
    result: null,
    error: "",
    timer: null,
    prState: null,
    historical: false,
    idle: false,
    creatingPr: false,
    updatingPr: false,
    abortController: null,
    ...overrides,
  };
}

// ── Historical agent helpers ─────────────────────────────────────────

/** Convert a persisted task to a read-only AgentState for display. */
export function historicalAgent(task: PersistedTask, id: number): AgentState {
  const wasInterrupted = task.status === "running";
  return createAgentState({
    id,
    taskId: task.taskId,
    prompt: task.prompt,
    status: wasInterrupted ? "interrupted" : task.status,
    elapsed: task.elapsed,
    lastActivity: wasInterrupted ? "Interrupted — deer was closed" : task.lastActivity,
    result: task.prUrl ? { finalBranch: task.finalBranch ?? "", prUrl: task.prUrl } : null,
    error: task.error || "",
    historical: true,
  });
}

/**
 * Convert a persisted "running" task to an AgentState for a task managed by
 * another deer instance. The tmux session is still alive, so this shows the
 * task as running and provides a handle for attaching and killing.
 */
export function crossInstanceAgent(task: PersistedTask, id: number): AgentState {
  const sessionName = `deer-${task.taskId}`;
  const worktreePath = join(dataDir(), "tasks", task.taskId, "worktree");
  return createAgentState({
    id,
    taskId: task.taskId,
    prompt: task.prompt,
    status: "running",
    elapsed: task.elapsed,
    lastActivity: task.lastActivity || "Running in another instance...",
    historical: true,
    handle: {
      taskId: task.taskId,
      sessionName,
      worktreePath,
      branch: task.finalBranch ?? `deer/${task.taskId}`,
      async kill() {
        await Bun.spawn(
          ["tmux", "kill-session", "-t", sessionName],
          { stdout: "pipe", stderr: "pipe" },
        ).exited;
      },
    },
  });
}
