/**
 * Keyboard action E2E tests.
 *
 * Verify that keyboard actions (kill, delete, retry) actually work end-to-end.
 * These tests catch silent action failures that unit tests miss.
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";

import {
  startDeerSession,
  createTestRepo,
  withFakeClaude,
  withSlowFakeClaude,
  waitFor,
  waitForNewTaskDir,
} from "./helpers";
import { isTmuxSessionDead } from "../../src/sandbox/index";
import { getTask, getTasksByRepo } from "../../src/db";

setDefaultTimeout(120_000);

const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("keyboard actions", () => {
  test("'x' kills a running agent after confirmation", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withSlowFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForReady();

          const before = Date.now();
          deer.sendKeys("kill this task\r");

          const taskId = await waitForNewTaskDir(before);

          // Wait for the agent tmux session to appear
          await waitFor(
            async () => !(await isTmuxSessionDead(`deer-${taskId}`)),
            { timeout: 15_000, label: "agent tmux session appears" },
          );

          // Tab to unfocus the prompt input, then send kill action
          deer.sendKeys("\t");
          await Bun.sleep(250);
          deer.sendKeys("x");

          // Confirmation prompt should appear
          await deer.waitForPane("(y/n)", 10_000);

          // Confirm the kill
          deer.sendKeys("y");

          // Agent tmux session should die and DB should record cancellation
          await waitFor(
            async () => {
              const row = getTask(taskId);
              return row?.status === "cancelled";
            },
            { timeout: 15_000, label: "DB shows cancelled" },
          );

          expect(await isTmuxSessionDead(`deer-${taskId}`)).toBe(true);
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });

  test("Backspace removes a completed task from the TUI and history", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForReady();

          const before = Date.now();
          deer.sendKeys("add logging\r");

          const taskId = await waitForNewTaskDir(before);

          // Wait for fake claude to finish
          await waitFor(
            async () => isTmuxSessionDead(`deer-${taskId}`),
            { timeout: 15_000, label: "agent session dies" },
          );

          // Wait for task to appear in DB (deer has processed completion)
          await waitFor(
            async () => {
              const row = getTask(taskId);
              return row !== null && row.status !== "running" && row.status !== "setup";
            },
            { timeout: 15_000, label: "task finalized in DB" },
          );

          // Tab to unfocus the prompt input, then press Backspace to delete
          deer.sendKeys("\t");
          await Bun.sleep(250);
          deer.sendKeys("\x7f");

          // Confirm deletion if prompted (task may still be in "running" status)
          await Bun.sleep(500);
          deer.sendKeys("y");

          // DB should no longer contain this task
          await waitFor(
            async () => {
              const row = getTask(taskId);
              return row === null;
            },
            { timeout: 15_000, label: "task removed from DB" },
          );

          // TUI should no longer show the taskId
          const screen = await deer.getScreen();
          expect(screen.some((l) => l.includes(taskId))).toBe(false);
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });

  test("'r' retries a completed task by reopening the same tmux session", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForReady();

          const before = Date.now();
          deer.sendKeys("refactor the parser\r");

          const taskId = await waitForNewTaskDir(before);

          // Wait for fake claude to finish
          await waitFor(
            async () => isTmuxSessionDead(`deer-${taskId}`),
            { timeout: 15_000, label: "agent session dies" },
          );

          // Wait for deer to register completion
          await waitFor(
            async () => {
              const row = getTask(taskId);
              return row !== null && row.status !== "running" && row.status !== "setup";
            },
            { timeout: 15_000, label: "task finalized in DB" },
          );

          // Tab to unfocus the prompt input, then retry
          deer.sendKeys("\t");
          await Bun.sleep(250);
          deer.sendKeys("r");

          // Confirm retry if prompted (task may still be in "running" status)
          await Bun.sleep(500);
          deer.sendKeys("y");

          // A new tmux session for the same taskId should appear
          await waitFor(
            async () => !(await isTmuxSessionDead(`deer-${taskId}`)),
            { timeout: 15_000, label: "retry tmux session appears" },
          );
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });
});
