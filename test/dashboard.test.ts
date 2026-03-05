import { test, expect, describe } from "bun:test";
import { historicalAgent, crossInstanceAgent, createAgentState } from "../src/agent-state";
import { generateTaskId } from "../src/task";
import type { PersistedTask } from "../src/task";

function makeTask(overrides?: Partial<PersistedTask>): PersistedTask {
  return {
    taskId: generateTaskId(),
    prompt: "fix the bug",
    status: "completed",
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

describe("historicalAgent", () => {
  test("converts running status to interrupted", () => {
    const task = makeTask({ status: "running", completedAt: null });
    const agent = historicalAgent(task, 1);
    expect(agent.status).toBe("interrupted");
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
  });

  test("preserves completed status", () => {
    const task = makeTask({ status: "completed" });
    const agent = historicalAgent(task, 1);
    expect(agent.status).toBe("completed");
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
});
