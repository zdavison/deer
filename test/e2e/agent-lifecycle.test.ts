/**
 * Agent lifecycle E2E tests.
 *
 * Verify the full path from prompt submission through agent completion.
 */

import { describe, test, expect, setDefaultTimeout, afterEach } from "bun:test";
import { join } from "node:path";

import { startDeerSession, createTestRepo, withFakeClaude, waitFor, waitForNewTaskDir } from "./helpers";
import { isTmuxSessionDead } from "../../src/sandbox/index";
import { getTask, getTasksByRepo, closeDb } from "../../src/db";

setDefaultTimeout(120_000);

const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("agent lifecycle", () => {
  test("submitting a prompt creates a worktree and tmux session", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForReady();

          const before = Date.now();
          deer.sendKeys("fix the bug\r");

          const taskId = await waitForNewTaskDir(before);

          // Verify the agent is running in DB
          await waitFor(
            async () => {
              const row = getTask(taskId);
              return row?.status === "running";
            },
            { timeout: 15_000, label: "DB has status running" },
          );

          // Verify agent tmux session exists
          const sessionName = `deer-${taskId}`;
          await waitFor(
            async () => !(await isTmuxSessionDead(sessionName)),
            { timeout: 10_000, label: "agent tmux session is alive" },
          );

          // Wait for fake claude to finish
          await waitFor(
            async () => isTmuxSessionDead(sessionName),
            { timeout: 15_000, label: "agent tmux session dies (fake claude finished)" },
          );

          // Wait for deer to persist the final state to DB
          await waitFor(
            async () => {
              const row = getTask(taskId);
              return row !== null && row.status !== "running" && row.status !== "setup";
            },
            { timeout: 15_000, label: "task finalized in DB" },
          );

          // The task should be idle (agent process exited, awaiting user PR action)
          const row = getTask(taskId);
          expect(row).not.toBeNull();
          expect(row!.idle).toBe(1);
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });

  test("long agent startup is not marked interrupted by reconcile", async () => {
    // Regression: if runtimeTaskIdsRef was not populated before startAgent(),
    // reconcile() would fire during the 2-8s setup window, find tmux dead,
    // and incorrectly mark the task as "interrupted".
    const { repoPath, cleanup } = await createTestRepo();
    try {
      // Add a deer.toml with a slow setup_command so that startAgent() blocks
      // for several reconcile cycles (2s each) before the tmux session exists.
      await Bun.write(join(repoPath, "deer.toml"), 'setup_command = "sleep 4"\n');

      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForReady();

          const before = Date.now();
          deer.sendKeys("slow startup test\r");

          const taskId = await waitForNewTaskDir(before);

          // Wait for the task to appear in DB (setup phase begins)
          await waitFor(
            async () => getTask(taskId) !== null,
            { timeout: 10_000, label: "task appears in DB" },
          );

          // Let 1+ reconcile cycles pass (reconcile runs every 2s).
          // The setup_command sleeps for 4s, so tmux won't exist yet.
          // Without the fix, reconcile would mark the task interrupted here.
          await Bun.sleep(3_000);

          const row = getTask(taskId);
          expect(row).not.toBeNull();
          expect(row!.status).not.toBe("interrupted");

          // Verify it eventually transitions to running
          await waitFor(
            async () => getTask(taskId)?.status === "running",
            { timeout: 15_000, label: "task reaches running status" },
          );
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });

  test("worktree directory exists while agent is running", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForReady();

          const before = Date.now();
          deer.sendKeys("add some tests\r");

          const taskId = await waitForNewTaskDir(before);

          // Check the worktree exists while the agent is running
          await waitFor(
            async () => {
              const row = getTask(taskId);
              if (!row?.worktree_path) return false;
              const gitDir = join(row.worktree_path, ".git");
              return Bun.file(gitDir).exists();
            },
            { timeout: 15_000, label: "worktree/.git exists" },
          );

          // Let the agent finish
          await waitFor(
            async () => isTmuxSessionDead(`deer-${taskId}`),
            { timeout: 15_000, label: "agent session dies" },
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
