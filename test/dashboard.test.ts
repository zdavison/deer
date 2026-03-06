import { test, expect, describe } from "bun:test";
import { historicalAgent, liveTaskFromStateFile, historicalAgentFromStateFile, createAgentState } from "../src/agent-state";
import { generateTaskId } from "../src/task";
import type { PersistedTask } from "../src/task";
import type { TaskStateFile } from "../src/task-state";
import { fuzzyMatch } from "../src/fuzzy";

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
    const agent = historicalAgent(task);
    expect(agent.status).toBe("interrupted");
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
  });

  test("preserves cancelled status", () => {
    const task = makeTask({ status: "cancelled" });
    const agent = historicalAgent(task);
    expect(agent.status).toBe("cancelled");
  });

  test("preserves failed status with error", () => {
    const task = makeTask({ status: "failed", error: "Claude exited with code 1", prUrl: null });
    const agent = historicalAgent(task);
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("Claude exited with code 1");
  });

  test("is marked as historical", () => {
    const task = makeTask();
    const agent = historicalAgent(task);
    expect(agent.historical).toBe(true);
  });

  test("populates result from prUrl", () => {
    const task = makeTask({ prUrl: "https://github.com/org/repo/pull/1", finalBranch: "deer/my-task" });
    const agent = historicalAgent(task);
    expect(agent.result?.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(agent.result?.finalBranch).toBe("deer/my-task");
  });

  test("has no worktreePath (historical tasks are not live)", () => {
    const task = makeTask();
    const agent = historicalAgent(task);
    expect(agent.worktreePath).toBe("");
  });

  test("preserves createdAt from task", () => {
    const createdAt = "2024-01-15T10:00:00.000Z";
    const task = makeTask({ createdAt });
    const agent = historicalAgent(task);
    expect(agent.createdAt).toBe(createdAt);
  });
});

function makeStateFile(overrides?: Partial<TaskStateFile>): TaskStateFile {
  return {
    taskId: generateTaskId(),
    prompt: "fix the bug",
    status: "running",
    elapsed: 60,
    lastActivity: "done",
    finalBranch: null,
    prUrl: null,
    error: null,
    logs: [],
    idle: false,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    worktreePath: "/home/user/.local/share/deer/tasks/deer_xxx/worktree",
    ...overrides,
  };
}

describe("liveTaskFromStateFile", () => {
  test("status is running", () => {
    const agent = liveTaskFromStateFile(makeStateFile());
    expect(agent.status).toBe("running");
  });

  test("is marked as historical", () => {
    const agent = liveTaskFromStateFile(makeStateFile());
    expect(agent.historical).toBe(true);
  });

  test("taskId matches state file taskId", () => {
    const taskId = generateTaskId();
    const agent = liveTaskFromStateFile(makeStateFile({ taskId }));
    expect(agent.taskId).toBe(taskId);
  });

  test("worktreePath comes from state file", () => {
    const worktreePath = "/tmp/deer-test/worktree";
    const agent = liveTaskFromStateFile(makeStateFile({ worktreePath }));
    expect(agent.worktreePath).toBe(worktreePath);
  });

  test("preserves lastActivity from state file", () => {
    const agent = liveTaskFromStateFile(makeStateFile({ lastActivity: "Fixing bug..." }));
    expect(agent.lastActivity).toBe("Fixing bug...");
  });

  test("elapsed matches state file elapsed", () => {
    const agent = liveTaskFromStateFile(makeStateFile({ elapsed: 42 }));
    expect(agent.elapsed).toBe(42);
  });

  test("idle defaults to false", () => {
    const agent = liveTaskFromStateFile(makeStateFile({ idle: false }));
    expect(agent.idle).toBe(false);
  });

  test("idle is set to true when state file has idle=true", () => {
    const agent = liveTaskFromStateFile(makeStateFile({ idle: true }));
    expect(agent.idle).toBe(true);
  });

  test("carries over logs from state file", () => {
    const logs = ["[setup] Creating worktree...", "[running] Claude started", "● Fixing the issue"];
    const agent = liveTaskFromStateFile(makeStateFile({ logs }));
    expect(agent.logs).toEqual(logs);
  });

  test("populates result from prUrl in state file", () => {
    const agent = liveTaskFromStateFile(
      makeStateFile({ prUrl: "https://github.com/org/repo/pull/42", finalBranch: "deer/task" }),
    );
    expect(agent.result?.prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(agent.result?.finalBranch).toBe("deer/task");
  });
});

describe("historicalAgentFromStateFile", () => {
  test("status is interrupted", () => {
    const agent = historicalAgentFromStateFile(makeStateFile());
    expect(agent.status).toBe("interrupted");
  });

  test("is marked as historical", () => {
    const agent = historicalAgentFromStateFile(makeStateFile());
    expect(agent.historical).toBe(true);
  });

  test("has worktreePath from state file", () => {
    const worktreePath = "/tmp/deer-test/worktree";
    const agent = historicalAgentFromStateFile(makeStateFile({ worktreePath }));
    expect(agent.worktreePath).toBe(worktreePath);
  });

  test("shows interrupted lastActivity", () => {
    const agent = historicalAgentFromStateFile(makeStateFile({ lastActivity: "Working..." }));
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
  });

  test("carries over logs from state file", () => {
    const logs = ["[setup] Creating worktree...", "● Some progress"];
    const agent = historicalAgentFromStateFile(makeStateFile({ logs }));
    expect(agent.logs).toEqual(logs);
  });

  test("preserves elapsed from state file", () => {
    const agent = historicalAgentFromStateFile(makeStateFile({ elapsed: 99 }));
    expect(agent.elapsed).toBe(99);
  });

  test("preserves error from state file", () => {
    const agent = historicalAgentFromStateFile(makeStateFile({ error: "Claude exited with code 1" }));
    expect(agent.error).toBe("Claude exited with code 1");
  });
});
