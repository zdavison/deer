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
  | "create_pr"
  | "open_pr"
  | "update_pr"
  | "kill"
  | "delete"
  | "toggle_logs"
  | "retry";

export interface AgentContext {
  status: AgentState;
  hasPrUrl: boolean;
  hasFinalBranch: boolean;
  hasHandle: boolean;
  isIdle: boolean;
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
  setup:       ["kill", "delete", "toggle_logs"],
  running:     ["attach", "kill", "delete", "toggle_logs"],
  teardown:    ["delete", "toggle_logs"],
  completed:   ["attach", "create_pr", "open_pr", "update_pr", "delete", "toggle_logs"],
  failed:      ["retry", "delete", "toggle_logs"],
  cancelled:   ["delete", "toggle_logs"],
  interrupted: ["delete", "toggle_logs"],
};

// ── Action Bindings ──────────────────────────────────────────────────

export const ACTION_BINDINGS: Record<AgentAction, ActionBinding> = {
  attach:       { keyDisplay: "⏎", label: "attach" },
  create_pr:    { keyDisplay: "p", label: "create PR" },
  open_pr:      { keyDisplay: "p", label: "open PR" },
  update_pr:    { keyDisplay: "u", label: "update PR" },
  kill:         { keyDisplay: "x", label: "kill" },
  delete:       { keyDisplay: "⌫", label: "delete" },
  toggle_logs:  { keyDisplay: "l", label: "logs" },
  retry:        { keyDisplay: "r", label: "retry" },
};

// ── Runtime Filtering ────────────────────────────────────────────────

/**
 * Returns the actions available for an agent given its current context.
 * Filters the base action list by secondary conditions (e.g. create_pr
 * requires a finalBranch, open_pr requires a PR URL).
 */
export function availableActions(ctx: AgentContext): AgentAction[] {
  const base = [...ACTIONS_BY_STATE[ctx.status]];
  // Idle agents can create or update PRs (Claude is alive but waiting for input)
  if (ctx.isIdle && !base.includes("create_pr")) {
    base.push("create_pr", "open_pr", "update_pr");
  }
  return base.filter((action) => {
    switch (action) {
      case "attach":
        return ctx.hasHandle;
      case "create_pr":
        return ctx.hasFinalBranch && !ctx.hasPrUrl;
      case "open_pr":
        return ctx.hasPrUrl;
      case "update_pr":
        return ctx.hasPrUrl;
      case "delete":
        return true;
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
  // Enter key: attach
  if (key.return) {
    if (actions.includes("attach")) return "attach";
    return null;
  }

  // Backspace / Delete key
  if (key.backspace || key.delete) {
    return actions.includes("delete") ? "delete" : null;
  }

  // Character keys
  // 'p' key: create_pr takes priority over open_pr (they're mutually exclusive)
  if (input === "p") {
    if (actions.includes("create_pr")) return "create_pr";
    if (actions.includes("open_pr")) return "open_pr";
    return null;
  }

  const charMap: Record<string, AgentAction> = {
    x: "kill",
    l: "toggle_logs",
    r: "retry",
    u: "update_pr",
  };

  const action = charMap[input];
  if (action && actions.includes(action)) return action;

  return null;
}
