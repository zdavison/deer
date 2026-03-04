// ── Agent State Machine ──────────────────────────────────────────────
//
// Defines explicit state transitions, per-state actions with keybindings,
// and runtime filtering for context-dependent action availability.

// ── Types ────────────────────────────────────────────────────────────

export type AgentState =
  | "setup"
  | "running"
  | "teardown"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AgentEvent =
  | "SETUP_COMPLETE"
  | "TEARDOWN_START"
  | "TEARDOWN_COMPLETE"
  | "ERROR"
  | "USER_KILL"
  | "SESSION_CLOSE";

export type AgentAction =
  | "attach"
  | "open_pr"
  | "shell"
  | "continue_pr"
  | "kill"
  | "delete"
  | "toggle_logs"
  | "retry";

export interface AgentContext {
  status: AgentState;
  hasPrUrl: boolean;
  hasFinalBranch: boolean;
  hasMeta: boolean;
  prState: "open" | "merged" | "closed" | null;
}

interface ActionBinding {
  keyDisplay: string;
  label: string;
}

// ── Transition Table ─────────────────────────────────────────────────

const TRANSITIONS: Record<AgentState, Partial<Record<AgentEvent, AgentState>>> = {
  setup:       { SETUP_COMPLETE: "running", ERROR: "failed", USER_KILL: "cancelled" },
  running:     { TEARDOWN_START: "teardown", ERROR: "failed", USER_KILL: "cancelled", SESSION_CLOSE: "interrupted" },
  teardown:    { TEARDOWN_COMPLETE: "completed", ERROR: "failed" },
  completed:   {},
  failed:      {},
  cancelled:   {},
  interrupted: { SETUP_COMPLETE: "running" },
};

/**
 * Attempt a state transition. Returns the next state, or null if the
 * transition is invalid for the current state.
 */
export function transition(current: AgentState, event: AgentEvent): AgentState | null {
  return TRANSITIONS[current][event] ?? null;
}

// ── Action Map per State ─────────────────────────────────────────────

const ACTIONS_BY_STATE: Record<AgentState, AgentAction[]> = {
  setup:       ["kill", "toggle_logs"],
  running:     ["attach", "shell", "kill", "toggle_logs"],
  teardown:    ["toggle_logs"],
  completed:   ["open_pr", "shell", "continue_pr", "delete", "toggle_logs"],
  failed:      ["retry", "shell", "delete", "toggle_logs"],
  cancelled:   ["shell", "delete", "toggle_logs"],
  interrupted: ["delete", "toggle_logs"],
};

// ── Action Bindings ──────────────────────────────────────────────────

export const ACTION_BINDINGS: Record<AgentAction, ActionBinding> = {
  attach:       { keyDisplay: "⏎", label: "attach" },
  open_pr:      { keyDisplay: "⏎", label: "open PR" },
  shell:        { keyDisplay: "s", label: "shell" },
  continue_pr:  { keyDisplay: "c", label: "continue PR" },
  kill:         { keyDisplay: "x", label: "kill" },
  delete:       { keyDisplay: "⌫", label: "delete" },
  toggle_logs:  { keyDisplay: "l", label: "logs" },
  retry:        { keyDisplay: "r", label: "retry" },
};

// ── Runtime Filtering ────────────────────────────────────────────────

/**
 * Returns the actions available for an agent given its current context.
 * Filters the base action list by secondary conditions (e.g. open_pr
 * requires a PR URL, delete is blocked when PR is open).
 */
export function availableActions(ctx: AgentContext): AgentAction[] {
  const base = ACTIONS_BY_STATE[ctx.status];
  return base.filter((action) => {
    switch (action) {
      case "open_pr":
        return ctx.hasPrUrl;
      case "shell":
        return ctx.hasMeta;
      case "continue_pr":
        return ctx.hasFinalBranch;
      case "delete":
        return ctx.prState !== "open";
      default:
        return true;
    }
  });
}

// ── Key Resolution ───────────────────────────────────────────────────

interface KeyInfo {
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  [key: string]: unknown;
}

/**
 * Maps a raw keypress to an action, but only if that action is in the
 * available set. Returns null if no match or action is unavailable.
 */
export function resolveKeypress(
  input: string,
  key: KeyInfo,
  actions: AgentAction[],
): AgentAction | null {
  // Enter key: attach takes priority over open_pr
  if (key.return) {
    if (actions.includes("attach")) return "attach";
    if (actions.includes("open_pr")) return "open_pr";
    return null;
  }

  // Backspace / Delete key
  if (key.backspace || key.delete) {
    return actions.includes("delete") ? "delete" : null;
  }

  // Character keys
  const charMap: Record<string, AgentAction> = {
    x: "kill",
    s: "shell",
    c: "continue_pr",
    l: "toggle_logs",
    r: "retry",
  };

  const action = charMap[input];
  if (action && actions.includes(action)) return action;

  return null;
}
