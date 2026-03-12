// ── Agent State Machine ──────────────────────────────────────────────
//
// Defines explicit state transitions, per-state actions with keybindings,
// and runtime filtering for context-dependent action availability.

// ── Types ────────────────────────────────────────────────────────────

export type AgentStatus =
  | "setup"
  | "running"
  | "teardown"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "pr_failed";

export type AgentEvent =
  | "SETUP_COMPLETE"
  | "TEARDOWN_START"
  | "TEARDOWN_COMPLETE"
  | "ERROR"
  | "USER_KILL"
  | "SESSION_CLOSE"
  | "PR_FAILED";

export type AgentAction =
  | "attach"
  | "create_pr"
  | "open_pr"
  | "update_pr"
  | "kill"
  | "delete"
  | "toggle_logs"
  | "copy_logs"
  | "toggle_verbose"
  | "retry"
  | "open_shell";

export interface AgentContext {
  status: AgentStatus;
  hasPrUrl: boolean;
  hasFinalBranch: boolean;
  hasHandle: boolean;
  isIdle: boolean;
  prState: "open" | "merged" | "closed" | null;
  hasWorktreePath: boolean;
  logExpanded?: boolean;
}

interface ActionBinding {
  keyDisplay: string;
  label: string;
}

// ── Transition Table ─────────────────────────────────────────────────

const TRANSITIONS: Record<AgentStatus, Partial<Record<AgentEvent, AgentStatus>>> = {
  setup:       { SETUP_COMPLETE: "running", ERROR: "failed", USER_KILL: "cancelled" },
  running:     { TEARDOWN_START: "teardown", ERROR: "failed", USER_KILL: "cancelled", SESSION_CLOSE: "interrupted", PR_FAILED: "pr_failed" },
  teardown:    { TEARDOWN_COMPLETE: "running", ERROR: "failed" },
  failed:      {},
  cancelled:   {},
  interrupted: { SETUP_COMPLETE: "running" },
  pr_failed:   {},
};

/**
 * Attempt a state transition. Returns the next state, or null if the
 * transition is invalid for the current state.
 */
export function transition(current: AgentStatus, event: AgentEvent): AgentStatus | null {
  return TRANSITIONS[current][event] ?? null;
}

// ── Action Map per State ─────────────────────────────────────────────

const ACTIONS_BY_STATE: Record<AgentStatus, AgentAction[]> = {
  setup:       ["kill", "delete", "toggle_logs"],
  running:     ["attach", "kill", "open_shell", "delete", "toggle_logs", "retry"],
  teardown:    ["open_shell", "delete", "toggle_logs"],
  failed:      ["retry", "open_shell", "delete", "toggle_logs"],
  cancelled:   ["retry", "open_shell", "delete", "toggle_logs"],
  interrupted: ["retry", "open_shell", "delete", "toggle_logs"],
  pr_failed:   ["attach", "create_pr", "open_shell", "delete", "toggle_logs", "retry"],
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
  copy_logs:    { keyDisplay: "c", label: "copy" },
  toggle_verbose: { keyDisplay: "v", label: "verbose" },
  retry:        { keyDisplay: "r", label: "retry" },
  open_shell:   { keyDisplay: "s", label: "shell" },
};

// ── Runtime Filtering ────────────────────────────────────────────────

/**
 * Returns the actions available for an agent given its current context.
 * Filters the base action list by secondary conditions (e.g. create_pr
 * requires a finalBranch, open_pr requires a PR URL).
 */
export function availableActions(ctx: AgentContext): AgentAction[] {
  const base = [...ACTIONS_BY_STATE[ctx.status]];
  // Idle agents can create/update PRs and retry (Claude is at rest)
  if (ctx.isIdle && !base.includes("create_pr")) {
    base.push("create_pr", "open_pr", "update_pr", "retry");
  }
  // copy_logs and toggle_verbose are available when the log panel is open
  if (ctx.logExpanded) {
    if (!base.includes("copy_logs")) base.push("copy_logs");
    if (!base.includes("toggle_verbose")) base.push("toggle_verbose");
  }
  return base.filter((action) => {
    switch (action) {
      case "attach":
        return ctx.hasHandle;
      case "create_pr":
        return ctx.hasFinalBranch && !ctx.hasPrUrl;
      case "open_pr":
        return ctx.hasPrUrl;
      case "open_shell":
        return ctx.hasWorktreePath;
      case "update_pr":
        return ctx.hasPrUrl && ctx.hasHandle && ctx.prState !== "merged" && ctx.prState !== "closed";
      case "copy_logs":
      case "toggle_verbose":
        return ctx.logExpanded;
      case "delete":
        return true;
      default:
        return true;
    }
  });
}

// ── Confirmation Messages ─────────────────────────────────────────────

import { t } from "./i18n";

const ACTIVE_STATES = new Set<AgentStatus>(["setup", "running", "teardown"]);

/**
 * Returns a confirmation prompt for dangerous actions, or null if the action
 * is safe to execute without prompting. Conditions vary by action and context.
 */
export function confirmationMessage(action: AgentAction, ctx: AgentContext): string | null {
  switch (action) {
    case "kill":
      return t("confirm_kill");
    case "delete":
      if (ctx.hasPrUrl) {
        return null;
      }
      if (ACTIVE_STATES.has(ctx.status)) {
        return t("confirm_delete_running");
      }
      if (ctx.hasFinalBranch) {
        return t("confirm_delete_no_pr");
      }
      return null;
    case "retry":
      if (ACTIVE_STATES.has(ctx.status)) {
        return t("confirm_retry_running");
      }
      return null;
    default:
      return null;
  }
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
    c: "copy_logs",
    v: "toggle_verbose",
    r: "retry",
    s: "open_shell",
    u: "update_pr",
  };

  const action = charMap[input];
  if (action && actions.includes(action)) return action;

  return null;
}
