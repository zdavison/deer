/**
 * State-sync E2E tests — no TUI required.
 *
 * These tests call the state persistence and agent-state functions directly,
 * verifying that the state file / JSONL history pipeline behaves correctly.
 * They are the fastest E2E tests and catch the most common cross-instance bugs.
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  generateTaskId,
  loadHistory,
  upsertHistory,
  removeFromHistory,
  type PersistedTask,
} from "../../src/task";
import {
  writeTaskState,
  readTaskState,
  removeTaskState,
  scanLiveTaskIds,
  isOwnerAlive,
  type TaskStateFile,
} from "../../src/task-state";
import {
  liveTaskFromStateFile,
  historicalAgentFromStateFile,
  historicalAgent,
  liveAgentFromHistory,
} from "../../src/agent-state";

const e2e = process.env.DEER_E2E ? describe : describe.skip;

// ── Factories ─────────────────────────────────────────────────────────

function makeStateFile(overrides: Partial<TaskStateFile> = {}): TaskStateFile {
  return {
    taskId: generateTaskId(),
    prompt: "fix the login bug",
    status: "running",
    elapsed: 0,
    lastActivity: "● Running...",
    prUrl: null,
    finalBranch: null,
    error: null,
    cost: null,
    logs: [],
    idle: false,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    worktreePath: "/tmp/fake-worktree",
    baseBranch: "main",
    ...overrides,
  };
}

function makePersistedTask(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    taskId: generateTaskId(),
    prompt: "fix the login bug",
    status: "cancelled",
    elapsed: 1000,
    lastActivity: "Cancelled",
    prUrl: null,
    finalBranch: null,
    error: null,
    cost: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    baseBranch: "main",
    worktreePath: "/tmp/fake-worktree",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

e2e("state file: alive owner → liveTaskFromStateFile", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    for (const id of createdIds) {
      await removeTaskState(id).catch(() => {});
    }
    createdIds.length = 0;
  });

  test("live state file with alive owner is returned by scanLiveTaskIds", async () => {
    const taskId = generateTaskId();
    createdIds.push(taskId);
    const state = makeStateFile({ taskId, ownerPid: process.pid });

    await writeTaskState(state);
    const ids = await scanLiveTaskIds();

    expect(ids).toContain(taskId);
  });

  test("isOwnerAlive returns true for own pid", () => {
    expect(isOwnerAlive(process.pid)).toBe(true);
  });

  test("liveTaskFromStateFile builds running AgentState with historical=true", async () => {
    const taskId = generateTaskId();
    createdIds.push(taskId);
    const state = makeStateFile({ taskId, ownerPid: process.pid, status: "running" });

    await writeTaskState(state);
    const loaded = await readTaskState(taskId);
    expect(loaded).not.toBeNull();

    const agent = liveTaskFromStateFile(loaded!);
    expect(agent.status).toBe("running");
    expect(agent.historical).toBe(true);
    expect(agent.taskId).toBe(taskId);
  });

  test("removeTaskState removes file from scan results", async () => {
    const taskId = generateTaskId();
    // Don't push to createdIds — we're cleaning up manually in the test
    const state = makeStateFile({ taskId });
    await writeTaskState(state);

    let ids = await scanLiveTaskIds();
    expect(ids).toContain(taskId);

    await removeTaskState(taskId);
    ids = await scanLiveTaskIds();
    expect(ids).not.toContain(taskId);
  });
});

e2e("state file: dead owner → historicalAgentFromStateFile", () => {
  const DEAD_PID = 99999999;
  const createdIds: string[] = [];

  afterEach(async () => {
    for (const id of createdIds) {
      await removeTaskState(id).catch(() => {});
    }
    createdIds.length = 0;
  });

  test("isOwnerAlive returns false for a dead PID", () => {
    expect(isOwnerAlive(DEAD_PID)).toBe(false);
  });

  test("historicalAgentFromStateFile sets status to interrupted", async () => {
    const taskId = generateTaskId();
    createdIds.push(taskId);
    const state = makeStateFile({ taskId, ownerPid: DEAD_PID, status: "running" });

    await writeTaskState(state);
    const loaded = await readTaskState(taskId);
    expect(loaded).not.toBeNull();

    const agent = historicalAgentFromStateFile(loaded!);
    expect(agent.status).toBe("interrupted");
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
    expect(agent.historical).toBe(true);
  });

  test("historicalAgentFromStateFile preserves lastActivity when task was idle", async () => {
    const taskId = generateTaskId();
    createdIds.push(taskId);
    const state = makeStateFile({
      taskId,
      ownerPid: DEAD_PID,
      status: "running",
      idle: true,
      lastActivity: "● Waiting for input",
    });

    await writeTaskState(state);
    const loaded = await readTaskState(taskId);
    const agent = historicalAgentFromStateFile(loaded!);

    expect(agent.status).toBe("interrupted");
    expect(agent.idle).toBe(true);
    expect(agent.lastActivity).toBe("● Waiting for input");
  });
});

e2e("JSONL history", () => {
  let repoPath: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "deer-e2e-history-"));
    repoPath = dir;
    cleanup = () => rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await cleanup();
  });

  test("JSONL history entry is returned by loadHistory", async () => {
    const task = makePersistedTask({ status: "cancelled" });
    await upsertHistory(repoPath, task);

    const history = await loadHistory(repoPath);
    const found = history.find((t) => t.taskId === task.taskId);
    expect(found).not.toBeUndefined();
    expect(found!.status).toBe("cancelled");

    await removeFromHistory(repoPath, task.taskId);
  });

  test("historicalAgent converts cancelled task correctly", async () => {
    const task = makePersistedTask({ status: "cancelled" });
    const agent = historicalAgent(task);

    expect(agent.status).toBe("cancelled");
    expect(agent.historical).toBe(true);
    expect(agent.taskId).toBe(task.taskId);
  });

  test("historicalAgent converts running task to interrupted", async () => {
    const task = makePersistedTask({ status: "running" });
    const agent = historicalAgent(task);

    expect(agent.status).toBe("interrupted");
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
  });

  test("liveAgentFromHistory builds a running historical agent from a persisted task", async () => {
    const task = makePersistedTask({ status: "running", lastActivity: "● Doing work" });
    const agent = liveAgentFromHistory(task);

    expect(agent.status).toBe("running");
    expect(agent.historical).toBe(true);
    expect(agent.lastActivity).toBe("● Doing work");
    expect(agent.taskId).toBe(task.taskId);
  });

  test("removeFromHistory removes the task from loadHistory results", async () => {
    const task = makePersistedTask({ status: "failed" });
    await upsertHistory(repoPath, task);

    let history = await loadHistory(repoPath);
    expect(history.some((t) => t.taskId === task.taskId)).toBe(true);

    await removeFromHistory(repoPath, task.taskId);
    history = await loadHistory(repoPath);
    expect(history.some((t) => t.taskId === task.taskId)).toBe(false);
  });

  test("upsertHistory replaces an existing entry in-place", async () => {
    const task = makePersistedTask({ status: "running", prompt: "original" });
    await upsertHistory(repoPath, task);
    await upsertHistory(repoPath, { ...task, status: "cancelled", prompt: "updated" });

    const history = await loadHistory(repoPath);
    const entries = history.filter((t) => t.taskId === task.taskId);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("cancelled");
    expect(entries[0].prompt).toBe("updated");

    await removeFromHistory(repoPath, task.taskId);
  });
});

e2e("deleted taskId excluded from scan", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    for (const id of createdIds) {
      await removeTaskState(id).catch(() => {});
    }
    createdIds.length = 0;
  });

  test("filtering live task IDs by a deleted set excludes the deleted id", async () => {
    const taskId = generateTaskId();
    createdIds.push(taskId);
    await writeTaskState(makeStateFile({ taskId }));

    const liveIds = await scanLiveTaskIds();
    expect(liveIds).toContain(taskId);

    const deleted = new Set<string>([taskId]);
    const filtered = liveIds.filter((id) => !deleted.has(id));
    expect(filtered).not.toContain(taskId);
  });
});

e2e("state file takes priority over JSONL for running tasks", () => {
  let repoPath: string;
  let cleanup: () => Promise<void>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "deer-e2e-priority-"));
    repoPath = dir;
    cleanup = () => rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    for (const id of createdIds) {
      await removeTaskState(id).catch(() => {});
    }
    createdIds.length = 0;
  });

  test("live state file is authoritative when owner is alive", async () => {
    const taskId = generateTaskId();
    createdIds.push(taskId);

    // Stale JSONL entry with status "running"
    await upsertHistory(repoPath, makePersistedTask({ taskId, status: "running" }));

    // Live state file with ownerPid = this process (alive)
    const state = makeStateFile({ taskId, ownerPid: process.pid, status: "running" });
    await writeTaskState(state);

    // The correct approach: check owner alive → use liveTaskFromStateFile
    const loaded = await readTaskState(taskId);
    expect(loaded).not.toBeNull();
    expect(isOwnerAlive(loaded!.ownerPid)).toBe(true);

    const agent = liveTaskFromStateFile(loaded!);
    expect(agent.status).toBe("running");

    await removeFromHistory(repoPath, taskId);
  });
});
