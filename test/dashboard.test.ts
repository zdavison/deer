import { test, expect, describe } from "bun:test";
import { agentFromDbRow } from "../src/agent-state";
import { generateTaskId } from "../src/task";
import type { TaskRow } from "../src/db";
import { fuzzyMatch } from "../src/fuzzy";

function makeRow(overrides?: Partial<TaskRow>): TaskRow {
  return {
    task_id: generateTaskId(),
    repo_path: "/home/user/repo",
    repo_hash: "abcdef0123456789",
    prompt: "fix the bug",
    base_branch: "main",
    branch: "deer/test",
    worktree_path: "/home/user/.local/share/deer/tasks/deer_xxx/worktree",
    model: "sonnet",
    status: "cancelled",
    pr_url: null,
    pr_state: null,
    final_branch: null,
    cost: null,
    error: null,
    last_activity: "done",
    elapsed: 60,
    idle: 0,
    created_at: Date.now(),
    finished_at: Date.now(),
    poller_pid: null,
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

describe("agentFromDbRow — terminal statuses", () => {
  test("converts running status to interrupted when tmux is dead", () => {
    const row = makeRow({ status: "running" });
    const agent = agentFromDbRow(row, false);
    expect(agent.status).toBe("interrupted");
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
  });

  test("preserves cancelled status", () => {
    const row = makeRow({ status: "cancelled" });
    const agent = agentFromDbRow(row, false);
    expect(agent.status).toBe("cancelled");
  });

  test("preserves failed status with error", () => {
    const row = makeRow({ status: "failed", error: "Claude exited with code 1", pr_url: null });
    const agent = agentFromDbRow(row, false);
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("Claude exited with code 1");
  });

  test("populates result with both prUrl and finalBranch", () => {
    const row = makeRow({ pr_url: "https://github.com/org/repo/pull/1", final_branch: "deer/my-task" });
    const agent = agentFromDbRow(row, false);
    expect(agent.result?.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(agent.result?.finalBranch).toBe("deer/my-task");
  });

  test("has no worktreePath when not provided", () => {
    const row = makeRow({ worktree_path: "" });
    const agent = agentFromDbRow(row, false);
    expect(agent.worktreePath).toBe("");
  });

  test("restores worktreePath from row", () => {
    const row = makeRow({ worktree_path: "/home/user/.local/share/deer/tasks/deer_xxx/worktree" });
    const agent = agentFromDbRow(row, false);
    expect(agent.worktreePath).toBe("/home/user/.local/share/deer/tasks/deer_xxx/worktree");
  });

  test("restores baseBranch from row", () => {
    const row = makeRow({ base_branch: "develop" });
    const agent = agentFromDbRow(row, false);
    expect(agent.baseBranch).toBe("develop");
  });

  test("populates result from finalBranch even without prUrl", () => {
    const row = makeRow({ final_branch: "deer/my-task", pr_url: null });
    const agent = agentFromDbRow(row, false);
    expect(agent.result?.finalBranch).toBe("deer/my-task");
    expect(agent.result?.prUrl).toBe("");
  });

  test("preserves createdAt from row", () => {
    const createdAt = new Date("2024-01-15T10:00:00.000Z").getTime();
    const row = makeRow({ created_at: createdAt });
    const agent = agentFromDbRow(row, false);
    expect(agent.createdAt).toBe("2024-01-15T10:00:00.000Z");
  });
});

describe("agentFromDbRow — live tmux", () => {
  test("status is running when tmux is alive", () => {
    const row = makeRow({ status: "running" });
    const agent = agentFromDbRow(row, true);
    expect(agent.status).toBe("running");
  });

  test("taskId matches row task_id", () => {
    const taskId = generateTaskId();
    const row = makeRow({ task_id: taskId, status: "running" });
    const agent = agentFromDbRow(row, true);
    expect(agent.taskId).toBe(taskId);
  });

  test("preserves lastActivity from row", () => {
    const row = makeRow({ status: "running", last_activity: "Fixing bug..." });
    const agent = agentFromDbRow(row, true);
    expect(agent.lastActivity).toBe("Fixing bug...");
  });

  test("elapsed matches row elapsed", () => {
    const row = makeRow({ status: "running", elapsed: 42 });
    const agent = agentFromDbRow(row, true);
    expect(agent.elapsed).toBe(42);
  });

  test("idle defaults to false", () => {
    const row = makeRow({ status: "running", idle: 0 });
    const agent = agentFromDbRow(row, true);
    expect(agent.idle).toBe(false);
  });

  test("idle is set to true when row has idle=1", () => {
    const row = makeRow({ status: "running", idle: 1 });
    const agent = agentFromDbRow(row, true);
    expect(agent.idle).toBe(true);
  });

  test("logs are always empty (captured from tmux, not stored)", () => {
    const row = makeRow({ status: "running" });
    const agent = agentFromDbRow(row, true);
    expect(agent.logs).toEqual([]);
  });
});

describe("agentFromDbRow — dead owner interrupted", () => {
  test("status is interrupted when tmux is dead", () => {
    const row = makeRow({ status: "running" });
    const agent = agentFromDbRow(row, false);
    expect(agent.status).toBe("interrupted");
  });

  test("shows interrupted lastActivity when not idle", () => {
    const row = makeRow({ status: "running", idle: 0, last_activity: "Working..." });
    const agent = agentFromDbRow(row, false);
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
  });

  test("preserves lastActivity when idle (Claude had finished)", () => {
    const row = makeRow({ status: "running", idle: 1, last_activity: "Idle — press ⏎ to attach" });
    const agent = agentFromDbRow(row, false);
    expect(agent.lastActivity).toBe("Idle — press ⏎ to attach");
  });

  test("restores idle flag from row", () => {
    const row = makeRow({ status: "running", idle: 1 });
    const agent = agentFromDbRow(row, false);
    expect(agent.idle).toBe(true);
  });

  test("restores baseBranch from row", () => {
    const row = makeRow({ status: "running", base_branch: "develop" });
    const agent = agentFromDbRow(row, false);
    expect(agent.baseBranch).toBe("develop");
  });

  test("populates result from finalBranch even without prUrl", () => {
    const row = makeRow({ status: "running", final_branch: "deer/fix-bug", pr_url: null });
    const agent = agentFromDbRow(row, false);
    expect(agent.result?.finalBranch).toBe("deer/fix-bug");
    expect(agent.result?.prUrl).toBe("");
  });

  test("preserves elapsed from row", () => {
    const row = makeRow({ status: "running", elapsed: 99 });
    const agent = agentFromDbRow(row, false);
    expect(agent.elapsed).toBe(99);
  });

  test("preserves error from row", () => {
    const row = makeRow({ status: "running", error: "Claude exited with code 1" });
    const agent = agentFromDbRow(row, false);
    expect(agent.error).toBe("Claude exited with code 1");
  });
});
