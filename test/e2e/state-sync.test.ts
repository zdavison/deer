/**
 * State-sync E2E tests — no TUI required.
 *
 * These tests call the DB persistence and agent-state functions directly,
 * verifying that the SQLite-based pipeline behaves correctly.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";

import { generateTaskId } from "../../src/task";
import {
  getDb,
  closeDb,
  insertTask,
  updateTask,
  getTask,
  getTasksByRepo,
  deleteTaskRow,
  claimPoller,
  releasePoller,
} from "../../src/db";
import { agentFromDbRow } from "../../src/agent-state";
import { dataDir } from "../../src/task";

const e2e = process.env.DEER_E2E ? describe : describe.skip;

const dbPath = `${dataDir()}/deer.db`;

// ── Tests ─────────────────────────────────────────────────────────────

e2e("DB: insert + get task", () => {
  afterEach(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(`${dbPath}-wal`); } catch {}
    try { unlinkSync(`${dbPath}-shm`); } catch {}
  });

  test("inserted task is returned by getTask", () => {
    const taskId = generateTaskId();
    insertTask({
      taskId,
      repoPath: "/tmp/fake-repo",
      prompt: "fix the login bug",
      baseBranch: "main",
      createdAt: Date.now(),
    });

    const row = getTask(taskId);
    expect(row).not.toBeNull();
    expect(row!.task_id).toBe(taskId);
    expect(row!.prompt).toBe("fix the login bug");
  });

  test("getTasksByRepo returns tasks for the given repo", () => {
    const taskId = generateTaskId();
    insertTask({
      taskId,
      repoPath: "/tmp/fake-repo",
      prompt: "test task",
      baseBranch: "main",
      createdAt: Date.now(),
    });

    const rows = getTasksByRepo("/tmp/fake-repo");
    expect(rows.some((r) => r.task_id === taskId)).toBe(true);
  });

  test("deleteTaskRow removes the task", () => {
    const taskId = generateTaskId();
    insertTask({
      taskId,
      repoPath: "/tmp/fake-repo",
      prompt: "delete me",
      baseBranch: "main",
      createdAt: Date.now(),
    });

    deleteTaskRow(taskId);
    expect(getTask(taskId)).toBeNull();
  });
});

e2e("agentFromDbRow: running task with tmux dead → interrupted", () => {
  afterEach(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(`${dbPath}-wal`); } catch {}
    try { unlinkSync(`${dbPath}-shm`); } catch {}
  });

  test("sets status to interrupted when tmux is dead", () => {
    const taskId = generateTaskId();
    insertTask({
      taskId,
      repoPath: "/tmp/fake-repo",
      prompt: "fix the login bug",
      baseBranch: "main",
      createdAt: Date.now(),
    });
    updateTask(taskId, { status: "running" });

    const row = getTask(taskId)!;
    const agent = agentFromDbRow(row, false);
    expect(agent.status).toBe("interrupted");
    expect(agent.lastActivity).toBe("Interrupted — deer was closed");
  });

  test("preserves lastActivity when task was idle", () => {
    const taskId = generateTaskId();
    insertTask({
      taskId,
      repoPath: "/tmp/fake-repo",
      prompt: "fix",
      baseBranch: "main",
      createdAt: Date.now(),
    });
    updateTask(taskId, {
      status: "running",
      idle: true,
      lastActivity: "● Waiting for input",
    });

    const row = getTask(taskId)!;
    const agent = agentFromDbRow(row, false);
    expect(agent.status).toBe("interrupted");
    expect(agent.idle).toBe(true);
    expect(agent.lastActivity).toBe("● Waiting for input");
  });
});

e2e("claimPoller CAS", () => {
  afterEach(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(`${dbPath}-wal`); } catch {}
    try { unlinkSync(`${dbPath}-shm`); } catch {}
  });

  test("claim succeeds when poller_pid is null", () => {
    const taskId = generateTaskId();
    insertTask({ taskId, repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    expect(claimPoller(taskId, process.pid)).toBe(true);
    expect(getTask(taskId)!.poller_pid).toBe(process.pid);
  });

  test("release clears the poller", () => {
    const taskId = generateTaskId();
    insertTask({ taskId, repoPath: "/r", prompt: "t", baseBranch: "main", createdAt: Date.now() });
    claimPoller(taskId, process.pid);
    releasePoller(taskId, process.pid);
    expect(getTask(taskId)!.poller_pid).toBeNull();
  });
});
