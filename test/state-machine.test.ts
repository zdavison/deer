import { test, expect, describe } from "bun:test";
import {
  transition,
  availableActions,
  resolveKeypress,
  confirmationMessage,
  ACTION_BINDINGS,
  type AgentStatus,
  type AgentEvent,
  type AgentAction,
  type AgentContext,
} from "../src/state-machine";

// ── Transition tests ─────────────────────────────────────────────────

describe("transition", () => {
  test("setup → running on SETUP_COMPLETE", () => {
    expect(transition("setup", "SETUP_COMPLETE")).toBe("running");
  });

  test("setup → failed on ERROR", () => {
    expect(transition("setup", "ERROR")).toBe("failed");
  });

  test("setup → cancelled on USER_KILL", () => {
    expect(transition("setup", "USER_KILL")).toBe("cancelled");
  });

  test("running → teardown on TEARDOWN_START", () => {
    expect(transition("running", "TEARDOWN_START")).toBe("teardown");
  });

  test("running → failed on ERROR", () => {
    expect(transition("running", "ERROR")).toBe("failed");
  });

  test("running → cancelled on USER_KILL", () => {
    expect(transition("running", "USER_KILL")).toBe("cancelled");
  });

  test("running → interrupted on SESSION_CLOSE", () => {
    expect(transition("running", "SESSION_CLOSE")).toBe("interrupted");
  });

  test("teardown → running on TEARDOWN_COMPLETE", () => {
    expect(transition("teardown", "TEARDOWN_COMPLETE")).toBe("running");
  });

  test("teardown → failed on ERROR", () => {
    expect(transition("teardown", "ERROR")).toBe("failed");
  });

  test("interrupted → running on SETUP_COMPLETE", () => {
    expect(transition("interrupted", "SETUP_COMPLETE")).toBe("running");
  });

  test("invalid transition returns null", () => {
    expect(transition("failed", "TEARDOWN_COMPLETE")).toBeNull();
    expect(transition("cancelled", "ERROR")).toBeNull();
    expect(transition("setup", "TEARDOWN_COMPLETE")).toBeNull();
    expect(transition("teardown", "USER_KILL")).toBeNull();
  });

  test("terminal states have no transitions", () => {
    const terminalStates: AgentStatus[] = ["failed", "cancelled"];
    const events: AgentEvent[] = [
      "SETUP_COMPLETE", "TEARDOWN_START", "TEARDOWN_COMPLETE",
      "ERROR", "USER_KILL", "SESSION_CLOSE",
    ];
    for (const state of terminalStates) {
      for (const event of events) {
        expect(transition(state, event)).toBeNull();
      }
    }
  });
});

// ── Available actions tests ──────────────────────────────────────────

describe("availableActions", () => {
  const baseCtx = (overrides: Partial<AgentContext>): AgentContext => ({
    status: "running",
    hasPrUrl: false,
    hasFinalBranch: false,
    hasHandle: true,
    isIdle: false,
    prState: null,
    hasWorktreePath: true,
    ...overrides,
  });

  test("setup state has kill, delete and toggle_logs", () => {
    const actions = availableActions(baseCtx({ status: "setup" }));
    expect(actions).toContain("kill");
    expect(actions).toContain("delete");
    expect(actions).toContain("toggle_logs");
    expect(actions).not.toContain("attach");
    expect(actions).not.toContain("open_pr");
  });

  test("running state has attach, kill, delete, toggle_logs", () => {
    const actions = availableActions(baseCtx({ status: "running" }));
    expect(actions).toContain("attach");
    expect(actions).toContain("kill");
    expect(actions).toContain("delete");
    expect(actions).toContain("toggle_logs");
  });

  test("teardown state has delete and toggle_logs", () => {
    const actions = availableActions(baseCtx({ status: "teardown" }));
    expect(actions).toContain("delete");
    expect(actions).toContain("toggle_logs");
  });


  test("failed state has retry, delete, toggle_logs", () => {
    const actions = availableActions(baseCtx({
      status: "failed",
      hasHandle: true,
    }));
    expect(actions).toContain("retry");
    expect(actions).toContain("delete");
    expect(actions).toContain("toggle_logs");
  });

  test("retry is not available in setup or teardown", () => {
    for (const status of ["setup", "teardown"] as const) {
      const actions = availableActions(baseCtx({ status }));
      expect(actions).not.toContain("retry");
    }
  });

  test("retry is available in running state (with confirmation)", () => {
    const actions = availableActions(baseCtx({ status: "running" }));
    expect(actions).toContain("retry");
  });

  test("retry is available in all terminal states", () => {
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      const actions = availableActions(baseCtx({ status }));
      expect(actions).toContain("retry");
    }
  });

  test("cancelled state has retry, delete, toggle_logs", () => {
    const actions = availableActions(baseCtx({
      status: "cancelled",
      hasHandle: true,
    }));
    expect(actions).toContain("retry");
    expect(actions).toContain("delete");
    expect(actions).toContain("toggle_logs");
  });

  test("interrupted state has retry, delete, toggle_logs", () => {
    const actions = availableActions(baseCtx({ status: "interrupted" }));
    expect(actions).toContain("retry");
    expect(actions).toContain("delete");
    expect(actions).toContain("toggle_logs");
    expect(actions).not.toContain("attach");
  });
  test("idle running state has create_pr and retry available", () => {
    const actions = availableActions(baseCtx({
      status: "running",
      isIdle: true,
      hasFinalBranch: true,
      hasHandle: true,
    }));
    expect(actions).toContain("create_pr");
    expect(actions).toContain("retry");
    expect(actions).toContain("attach");
    expect(actions).toContain("kill");
  });

  test("non-idle running state has retry (with confirmation)", () => {
    const actions = availableActions(baseCtx({
      status: "running",
      isIdle: false,
    }));
    expect(actions).toContain("retry");
  });

  test("idle running state has open_pr when PR exists", () => {
    const actions = availableActions(baseCtx({
      status: "running",
      isIdle: true,
      hasPrUrl: true,
      hasFinalBranch: true,
      hasHandle: true,
      prState: "open",
    }));
    expect(actions).toContain("open_pr");
    expect(actions).not.toContain("create_pr");
  });

  test("create_pr available when original PR was merged and there is a final branch", () => {
    const actions = availableActions(baseCtx({
      status: "running",
      isIdle: true,
      hasPrUrl: true,
      hasFinalBranch: true,
      hasHandle: true,
      prState: "merged",
    }));
    expect(actions).toContain("create_pr");
  });

  test("create_pr not available when PR is open (even with final branch)", () => {
    const actions = availableActions(baseCtx({
      isIdle: true,
      hasPrUrl: true,
      hasFinalBranch: true,
      prState: "open",
    }));
    expect(actions).not.toContain("create_pr");
  });

  test("create_pr not available when PR is closed", () => {
    const actions = availableActions(baseCtx({
      isIdle: true,
      hasPrUrl: true,
      hasFinalBranch: true,
      prState: "closed",
    }));
    expect(actions).not.toContain("create_pr");
  });

  test("non-idle running state does not have create_pr", () => {
    const actions = availableActions(baseCtx({
      status: "running",
      isIdle: false,
      hasFinalBranch: true,
      hasHandle: true,
    }));
    expect(actions).not.toContain("create_pr");
  });
});

// ── resolveKeypress tests ────────────────────────────────────────────

describe("resolveKeypress", () => {
  test("resolves 'l' to toggle_logs when available", () => {
    expect(resolveKeypress("l", {}, ["toggle_logs"])).toBe("toggle_logs");
  });

  test("resolves 'x' to kill when available", () => {
    expect(resolveKeypress("x", {}, ["kill", "toggle_logs"])).toBe("kill");
  });

  test("resolves enter to attach when available", () => {
    expect(resolveKeypress("", { return: true }, ["attach", "kill"])).toBe("attach");
  });

  test("enter does not resolve to open_pr", () => {
    expect(resolveKeypress("", { return: true }, ["open_pr", "delete"])).toBeNull();
  });

  test("resolves backspace to delete when available", () => {
    expect(resolveKeypress("", { backspace: true }, ["delete", "toggle_logs"])).toBe("delete");
  });

  test("resolves delete key to delete when available", () => {
    expect(resolveKeypress("", { delete: true }, ["delete", "toggle_logs"])).toBe("delete");
  });

  test("returns null for unavailable action", () => {
    expect(resolveKeypress("x", {}, ["toggle_logs"])).toBeNull();
  });

  test("returns null for unbound key", () => {
    expect(resolveKeypress("z", {}, ["kill", "toggle_logs"])).toBeNull();
  });

  test("resolves 'r' to retry when available", () => {
    expect(resolveKeypress("r", {}, ["retry", "delete"])).toBe("retry");
  });

  test("does not resolve 'r' when retry is unavailable", () => {
    expect(resolveKeypress("r", {}, ["delete", "toggle_logs"])).toBeNull();
  });

  test("resolves 'p' to create_pr when available", () => {
    expect(resolveKeypress("p", {}, ["create_pr", "delete"])).toBe("create_pr");
  });

  test("resolves 'p' to open_pr when create_pr is unavailable but open_pr is", () => {
    expect(resolveKeypress("p", {}, ["open_pr", "delete"])).toBe("open_pr");
  });

  test("does not resolve 'p' when neither create_pr nor open_pr is available", () => {
    expect(resolveKeypress("p", {}, ["delete", "toggle_logs"])).toBeNull();
  });

  test("'s' is not bound to any action", () => {
    expect(resolveKeypress("s", {}, ["kill", "toggle_logs"])).toBeNull();
  });
});

// ── update_pr action tests ────────────────────────────────────────────

describe("update_pr action", () => {
  const baseCtx = (overrides: Partial<AgentContext>): AgentContext => ({
    status: "running",
    hasPrUrl: true,
    hasFinalBranch: true,
    hasHandle: true,
    isIdle: true,
    prState: "open",
    hasWorktreePath: true,
    ...overrides,
  });

  test("update_pr available when PR is open and handle exists", () => {
    const actions = availableActions(baseCtx({}));
    expect(actions).toContain("update_pr");
  });

  test("update_pr not available without PR URL", () => {
    const actions = availableActions(baseCtx({ hasPrUrl: false, prState: null }));
    expect(actions).not.toContain("update_pr");
  });

  test("update_pr not available without handle", () => {
    const actions = availableActions(baseCtx({ hasHandle: false }));
    expect(actions).not.toContain("update_pr");
  });

  test("update_pr not available when PR is merged", () => {
    const actions = availableActions(baseCtx({ prState: "merged" }));
    expect(actions).not.toContain("update_pr");
  });

  test("update_pr not available when PR is closed", () => {
    const actions = availableActions(baseCtx({ prState: "closed" }));
    expect(actions).not.toContain("update_pr");
  });

  test("update_pr available when idle and PR is open", () => {
    const actions = availableActions(baseCtx({ status: "running", isIdle: true }));
    expect(actions).toContain("update_pr");
  });

  test("update_pr not available in non-idle states", () => {
    for (const status of ["setup", "teardown", "cancelled", "interrupted"] as const) {
      const actions = availableActions(baseCtx({ status, hasPrUrl: true, isIdle: false }));
      expect(actions).not.toContain("update_pr");
    }
  });

  test("'u' key resolves to update_pr when available", () => {
    expect(resolveKeypress("u", {}, ["update_pr", "open_pr", "delete"])).toBe("update_pr");
  });

  test("'u' key returns null when update_pr is not available", () => {
    expect(resolveKeypress("u", {}, ["open_pr", "delete"])).toBeNull();
  });
});

// ── confirmationMessage tests ────────────────────────────────────────

describe("confirmationMessage", () => {
  const baseCtx = (overrides: Partial<AgentContext>): AgentContext => ({
    status: "running",
    hasPrUrl: false,
    hasFinalBranch: false,
    hasHandle: true,
    isIdle: false,
    prState: null,
    hasWorktreePath: true,
    ...overrides,
  });

  // kill always requires confirmation
  test("kill always requires confirmation", () => {
    for (const status of ["setup", "running", "teardown", "completed", "failed", "cancelled", "interrupted"] as const) {
      expect(confirmationMessage("kill", baseCtx({ status }))).not.toBeNull();
    }
  });

  // delete: active states require confirmation
  test("delete requires confirmation when agent is running", () => {
    expect(confirmationMessage("delete", baseCtx({ status: "running" }))).not.toBeNull();
  });

  test("delete requires confirmation when agent is in setup", () => {
    expect(confirmationMessage("delete", baseCtx({ status: "setup" }))).not.toBeNull();
  });

  test("delete requires confirmation when agent is in teardown", () => {
    expect(confirmationMessage("delete", baseCtx({ status: "teardown" }))).not.toBeNull();
  });

  // delete: terminal with work but no PR
  test("delete requires confirmation when completed with work but no PR", () => {
    expect(confirmationMessage("delete", baseCtx({
      status: "completed",
      hasFinalBranch: true,
      hasPrUrl: false,
    }))).not.toBeNull();
  });

  test("delete requires confirmation when failed with work but no PR", () => {
    expect(confirmationMessage("delete", baseCtx({
      status: "failed",
      hasFinalBranch: true,
      hasPrUrl: false,
    }))).not.toBeNull();
  });

  // delete: no confirmation when PR already exists (regardless of state)
  test("delete does not require confirmation when PR exists (completed)", () => {
    expect(confirmationMessage("delete", baseCtx({
      status: "completed",
      hasFinalBranch: true,
      hasPrUrl: true,
    }))).toBeNull();
  });

  test("delete does not require confirmation when PR exists (running)", () => {
    expect(confirmationMessage("delete", baseCtx({
      status: "running",
      hasPrUrl: true,
    }))).toBeNull();
  });

  test("delete does not require confirmation when PR exists (setup)", () => {
    expect(confirmationMessage("delete", baseCtx({
      status: "setup",
      hasPrUrl: true,
    }))).toBeNull();
  });

  // delete: no confirmation when no work to lose
  test("delete does not require confirmation when no final branch", () => {
    expect(confirmationMessage("delete", baseCtx({
      status: "completed",
      hasFinalBranch: false,
      hasPrUrl: false,
    }))).toBeNull();
  });

  // retry: active states require confirmation
  test("retry requires confirmation when agent is running", () => {
    expect(confirmationMessage("retry", baseCtx({ status: "running" }))).not.toBeNull();
  });

  test("retry requires confirmation when agent is in setup", () => {
    expect(confirmationMessage("retry", baseCtx({ status: "setup" }))).not.toBeNull();
  });

  // retry: no confirmation in terminal states
  test("retry does not require confirmation in terminal states", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      expect(confirmationMessage("retry", baseCtx({ status }))).toBeNull();
    }
  });

  // non-dangerous actions never require confirmation
  test("attach, create_pr, open_pr, update_pr, toggle_logs, open_shell never require confirmation", () => {
    const safeActions: AgentAction[] = ["attach", "create_pr", "open_pr", "update_pr", "toggle_logs", "open_shell"];
    for (const action of safeActions) {
      expect(confirmationMessage(action, baseCtx({}))).toBeNull();
    }
  });
});

// ── ACTION_BINDINGS tests ────────────────────────────────────────────

describe("ACTION_BINDINGS", () => {
  test("every action has a keyDisplay and label", () => {
    const actions: AgentAction[] = [
      "attach", "create_pr", "open_pr", "update_pr", "kill", "delete", "toggle_logs", "retry", "open_shell",
    ];
    for (const action of actions) {
      const binding = ACTION_BINDINGS[action];
      expect(binding).toBeDefined();
      expect(binding.keyDisplay).toBeTruthy();
      expect(binding.label).toBeTruthy();
    }
  });
});
