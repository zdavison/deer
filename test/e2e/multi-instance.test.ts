/**
 * Multi-instance E2E tests.
 *
 * Verify that tasks from a second deer instance appear correctly in the first
 * instance's dashboard via the SQLite sync mechanism.
 */

import { describe, test, expect, setDefaultTimeout, afterEach } from "bun:test";

import { startDeerSession, createTestRepo, waitFor } from "./helpers";
import { insertTask, updateTask, deleteTaskRow, closeDb } from "../../src/db";
import { generateTaskId } from "../../src/task";

setDefaultTimeout(60_000);

const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("multi-instance sync", () => {
  test("task from another instance appears as running in the TUI", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    const taskId = generateTaskId();
    try {
      const deer = await startDeerSession(repoPath);
      try {
        await deer.waitForPane("deer");

        // Simulate a task from another instance by inserting into SQLite
        insertTask({
          taskId,
          repoPath,
          prompt: "cross-instance test task",
          baseBranch: "main",
          createdAt: Date.now(),
        });
        updateTask(taskId, {
          status: "running",
          lastActivity: "● Running in another instance",
          pollerPid: process.pid,
        });

        // The reconcile loop runs every 2s. Wait up to 15s for the task to appear.
        await deer.waitForPane("cross-instance test task", 15_000);

        const screen = await deer.getScreen();
        const taskLine = screen.find((l) => l.includes("cross-instance test task"));
        expect(taskLine).not.toBeUndefined();
      } finally {
        await deer.stop();
      }
    } finally {
      deleteTaskRow(taskId);
      await cleanup();
    }
  });

  test("task becomes interrupted when tmux session is dead", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    const taskId = generateTaskId();
    try {
      const deer = await startDeerSession(repoPath);
      try {
        await deer.waitForPane("deer");

        // Insert a running task with no tmux session — should show as interrupted
        insertTask({
          taskId,
          repoPath,
          prompt: "interrupted instance task",
          baseBranch: "main",
          createdAt: Date.now(),
        });
        updateTask(taskId, {
          status: "running",
          lastActivity: "● Doing work",
        });

        // Wait for the task to appear — it should show as interrupted
        // since there is no tmux session for it
        await waitFor(
          async () => {
            const screen = await deer.getScreen();
            return (
              screen.some((l) => l.includes("interrupted instance task")) ||
              screen.some((l) => l.includes("interrupted"))
            );
          },
          { timeout: 15_000, label: "interrupted task appears in TUI" },
        );
      } finally {
        await deer.stop();
      }
    } finally {
      deleteTaskRow(taskId);
      await cleanup();
    }
  });
});
