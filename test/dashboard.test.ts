import { test, expect, describe } from "bun:test";
import { historicalAgent, crossInstanceAgent, createAgentState } from "../src/agent-state";
import { generateTaskId } from "../src/task";
import type { PersistedTask } from "../src/task";
import { fuzzyMatch } from "../src/fuzzy";
import { applyKittyData } from "../src/kitty-input";

function makeTask(overrides?: Partial<PersistedTask>): PersistedTask {
  return {
    taskId: generateTaskId(),
    prompt: "fix the bug",
    status: "cancelled",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    elapsed: 60,
    prUrl: null,
    finalBranch: null,
    error: null,
    lastActivity: "done",
    ...overrides,
  };
}

describe("applyKittyData", () => {
  test("Shift+Enter inserts newline at cursor", () => {
    expect(applyKittyData("\x1b[13;2u", "hello", 5)).toEqual({ value: "hello\n", cursor: 6 });
  });

  test("Shift+Enter inserts newline mid-string", () => {
    expect(applyKittyData("\x1b[13;2u", "hello world", 5)).toEqual({ value: "hello\n world", cursor: 6 });
  });

  test("backspace (\\x1b[127;1u) deletes char before cursor", () => {
    expect(applyKittyData("\x1b[127;1u", "hello", 5)).toEqual({ value: "hell", cursor: 4 });
  });

  test("backspace (\\x1b[127u) deletes char before cursor", () => {
    expect(applyKittyData("\x1b[127u", "hello", 5)).toEqual({ value: "hell", cursor: 4 });
  });

  test("backspace mid-string deletes correct char", () => {
    expect(applyKittyData("\x1b[127;1u", "hello", 3)).toEqual({ value: "helo", cursor: 2 });
  });

  test("backspace at start of string returns null", () => {
    expect(applyKittyData("\x1b[127;1u", "hello", 0)).toBeNull();
  });

  test("returns null for unknown sequences", () => {
    expect(applyKittyData("\x1b[1;2A", "hello", 5)).toBeNull();
  });
});

describe("fuzzyMatch", () => {
  test("matches exact substring", () => {
    expect(fuzzyMatch("fix the bug", "fix")).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(fuzzyMatch("Fix the Bug", "FIX")).toBe(true);
  });

  test("matches subsequence characters in order", () => {
    expect(fuzzyMatch("fix the bug", "ftb")).toBe(true);
  });

  test("does not match when characters are out of order", () => {
    expect(fuzzyMatch("fix the bug", "bfix")).toBe(false);
  });

  test("returns true for empty query", () => {
    expect(fuzzyMatch("anything", "")).toBe(true);
  });

  test("returns false when no subsequence match", () => {
    expect(fuzzyMatch("hello", "xyz")).toBe(false);
  });

  test("matches full text", () => {
    expect(fuzzyMatch("add dark mode toggle", "add dark mode toggle")).toBe(true);
  });

  test("returns false for query longer than text with no match", () => {
    expect(fuzzyMatch("hi", "hello world")).toBe(false);
  });
});

describe("historicalAgent", () => {
  test("converts running status to interrupted", () => {
    const task = makeTask({ status: "running", completedAt: null });
    const agent = historicalAgent(task, 1);
    expect(agent.status).toBe("interrupted");
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
  });

  test("preserves cancelled status", () => {
    const task = makeTask({ status: "cancelled" });
    const agent = historicalAgent(task, 1);
    expect(agent.status).toBe("cancelled");
  });

  test("preserves failed status with error", () => {
    const task = makeTask({ status: "failed", error: "Claude exited with code 1", prUrl: null });
    const agent = historicalAgent(task, 1);
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("Claude exited with code 1");
  });

  test("preserves cancelled status", () => {
    const task = makeTask({ status: "cancelled" });
    const agent = historicalAgent(task, 1);
    expect(agent.status).toBe("cancelled");
  });

  test("is marked as historical", () => {
    const task = makeTask();
    const agent = historicalAgent(task, 1);
    expect(agent.historical).toBe(true);
  });

  test("populates result from prUrl", () => {
    const task = makeTask({ prUrl: "https://github.com/org/repo/pull/1", finalBranch: "deer/my-task" });
    const agent = historicalAgent(task, 1);
    expect(agent.result?.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(agent.result?.finalBranch).toBe("deer/my-task");
  });

  test("has no handle", () => {
    const task = makeTask();
    const agent = historicalAgent(task, 1);
    expect(agent.handle).toBeNull();
  });
});

describe("crossInstanceAgent", () => {
  test("status is running", () => {
    const task = makeTask({ status: "running", completedAt: null });
    const agent = crossInstanceAgent(task, 1);
    expect(agent.status).toBe("running");
  });

  test("is marked as historical", () => {
    const task = makeTask({ status: "running", completedAt: null });
    const agent = crossInstanceAgent(task, 1);
    expect(agent.historical).toBe(true);
  });

  test("has a handle with correct sessionName", () => {
    const taskId = generateTaskId();
    const task = makeTask({ taskId, status: "running", completedAt: null });
    const agent = crossInstanceAgent(task, 1);
    expect(agent.handle).not.toBeNull();
    expect(agent.handle?.sessionName).toBe(`deer-${taskId}`);
  });

  test("handle taskId matches task taskId", () => {
    const taskId = generateTaskId();
    const task = makeTask({ taskId, status: "running", completedAt: null });
    const agent = crossInstanceAgent(task, 1);
    expect(agent.handle?.taskId).toBe(taskId);
  });

  test("preserves lastActivity from task", () => {
    const task = makeTask({ status: "running", completedAt: null, lastActivity: "Fixing bug..." });
    const agent = crossInstanceAgent(task, 1);
    expect(agent.lastActivity).toBe("Fixing bug...");
  });

  test("uses default lastActivity when empty", () => {
    const task = makeTask({ status: "running", completedAt: null, lastActivity: "" });
    const agent = crossInstanceAgent(task, 1);
    expect(agent.lastActivity.length).toBeGreaterThan(0);
  });

  test("elapsed matches task elapsed", () => {
    const task = makeTask({ status: "running", completedAt: null, elapsed: 42 });
    const agent = crossInstanceAgent(task, 1);
    expect(agent.elapsed).toBe(42);
  });

  test("idle defaults to false", () => {
    const task = makeTask({ status: "running", completedAt: null });
    const agent = crossInstanceAgent(task, 1);
    expect(agent.idle).toBe(false);
  });

  test("idle is set to true when passed", () => {
    const task = makeTask({ status: "running", completedAt: null });
    const agent = crossInstanceAgent(task, 1, true);
    expect(agent.idle).toBe(true);
  });

  test("lastActivity is idle message when idle=true", () => {
    const task = makeTask({ status: "running", completedAt: null, lastActivity: "Working..." });
    const agent = crossInstanceAgent(task, 1, true);
    expect(agent.lastActivity).toBe("Idle — press ⏎ to attach");
  });

  test("lastActivity preserved from task when not idle", () => {
    const task = makeTask({ status: "running", completedAt: null, lastActivity: "Working..." });
    const agent = crossInstanceAgent(task, 1, false);
    expect(agent.lastActivity).toBe("Working...");
  });
});
