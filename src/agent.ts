/**
 * Agent lifecycle: worktree → sandbox → poll → finalize.
 *
 * Each agent runs Claude Code interactively inside a nono sandbox
 * within a tmux session. The user can attach at any time via tmux.
 */

import { join, resolve } from "node:path";
import { createWorktree, removeWorktree } from "./git/worktree";
import { createPullRequest, cleanupWorktree } from "./git/finalize";
import type { CreatePRResult } from "./git/finalize";
import { launchSandbox, isTmuxSessionDead, captureTmuxPane } from "./sandbox/index";
import type { SandboxSession } from "./sandbox/index";
import { generateTaskId, dataDir } from "./task";
import type { DeerConfig } from "./config";

// ── Types ────────────────────────────────────────────────────────────

export interface AgentHandle {
  taskId: string;
  sessionName: string;
  worktreePath: string;
  branch: string;
  /** Kill the agent (stop sandbox, but don't clean up worktree) */
  kill: () => Promise<void>;
}

export interface AgentRunOptions {
  /** Path to the repository root */
  repoPath: string;
  /** The user's prompt / task description */
  prompt: string;
  /** Branch to base the worktree on */
  baseBranch: string;
  /** Loaded deer config (for network allowlist, env, etc.) */
  config: DeerConfig;
  /** Override the model (default: "sonnet") */
  model?: string;
  /** Callback for status updates */
  onStatus?: (status: AgentStatus) => void;
}

export type AgentStatus =
  | { phase: "setup"; message: string }
  | { phase: "running"; sessionName: string }
  | { phase: "failed"; error: string }
  | { phase: "cancelled" };

// ── Constants ────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_MODEL = "sonnet";

/**
 * Build an env object containing only the vars from the passthrough list.
 * Vars not set in the host environment are omitted.
 */
function buildPassthroughEnv(passthrough: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of passthrough) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * Poll the tmux pane for the bypass permissions confirmation dialog
 * and dismiss it by selecting "Yes, I accept".
 */
async function dismissBypassDialog(sessionName: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await Bun.sleep(500);
    const pane = await captureTmuxPane(sessionName);
    if (!pane) return;
    const text = pane.join("\n");
    if (text.includes("Yes, I accept")) {
      // Send Down and Enter separately with a delay to avoid the race
      // where Enter confirms option 1 before Down moves to option 2.
      await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "Down"], {
        stdout: "pipe", stderr: "pipe",
      }).exited;
      await Bun.sleep(200);
      await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "Enter"], {
        stdout: "pipe", stderr: "pipe",
      }).exited;
      return;
    }
    // Claude started without the dialog
    if (text.includes("$") || text.includes("❯") || text.includes("Claude")) {
      if (!text.includes("Bypass Permissions")) return;
    }
  }
}

// ── Agent Lifecycle ──────────────────────────────────────────────────

/**
 * Start an agent: create worktree, launch sandbox, return handle.
 *
 * The agent runs Claude Code interactively in a tmux session.
 * Call `waitForCompletion()` to block until the agent finishes,
 * or use the handle to kill it / attach to it.
 */
export async function startAgent(options: AgentRunOptions): Promise<AgentHandle> {
  const {
    repoPath,
    prompt,
    baseBranch,
    config,
    model = DEFAULT_MODEL,
    onStatus,
  } = options;

  const taskId = generateTaskId();
  const sessionName = `deer-${taskId}`;

  onStatus?.({ phase: "setup", message: "Creating worktree..." });

  // Create git worktree
  const worktree = await createWorktree(repoPath, taskId, baseBranch);

  onStatus?.({ phase: "setup", message: "Starting sandbox..." });

  // Configure git in the worktree
  await Bun.$`git -C ${worktree.worktreePath} config user.name "deer-agent"`.quiet();
  await Bun.$`git -C ${worktree.worktreePath} config user.email "deer@noreply"`.quiet();

  // Write the prompt to a file in the worktree so Claude can read it
  const promptPath = `${worktree.worktreePath}/.deer-prompt`;
  await Bun.write(promptPath, prompt);

  // Build the Claude command — interactive mode (no -p) so users can
  // attach to the tmux session and observe/intervene.
  const claudeCmd = [
    "claude",
    "--dangerously-skip-permissions",
    "--model", model,
    prompt,
  ];

  let sandbox: SandboxSession;
  try {
    sandbox = await launchSandbox({
      sessionName,
      worktreePath: worktree.worktreePath,
      repoGitDir: resolve(repoPath, ".git"),
      allowlist: config.network.allowlist,
      env: buildPassthroughEnv(config.sandbox.envPassthrough),
      command: claudeCmd,
    });
  } catch (err) {
    // Clean up worktree on sandbox failure
    await removeWorktree(repoPath, worktree.worktreePath).catch(() => {});
    throw err;
  }

  // Clean up the prompt file (it's already been passed to Claude)
  await Bun.$`rm -f ${promptPath}`.quiet().nothrow();

  // Dismiss the --dangerously-skip-permissions confirmation dialog.
  // The dialog defaults to "1. No, exit" — send Down then Enter
  // to select "2. Yes, I accept".
  await dismissBypassDialog(sessionName);

  onStatus?.({ phase: "running", sessionName });

  return {
    taskId,
    sessionName,
    worktreePath: worktree.worktreePath,
    branch: worktree.branch,
    async kill() {
      await sandbox.stop();
    },
  };
}

/**
 * Poll until the agent's tmux session exits.
 * Resolves when the sandboxed Claude process finishes.
 *
 * @param handle - The agent handle from `startAgent()`
 * @param signal - Optional AbortSignal to cancel polling (e.g. on user kill)
 */
export async function waitForCompletion(
  handle: AgentHandle,
  signal?: AbortSignal,
): Promise<void> {
  while (true) {
    if (signal?.aborted) return;

    const dead = await isTmuxSessionDead(handle.sessionName);
    if (dead) return;

    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Finalize an agent after it completes: commit, push, create PR.
 */
export async function createAgentPR(
  handle: AgentHandle,
  repoPath: string,
  baseBranch: string,
  prompt: string,
): Promise<CreatePRResult> {
  return createPullRequest({
    repoPath,
    worktreePath: handle.worktreePath,
    branch: handle.branch,
    baseBranch,
    prompt,
  });
}

/**
 * Get the last N lines of tmux output for an agent.
 */
export async function getAgentOutput(
  sessionName: string,
  fullScrollback = false,
): Promise<string[]> {
  const lines = await captureTmuxPane(sessionName, fullScrollback);
  return lines ?? [];
}

/**
 * Full cleanup: kill sandbox, remove worktree and branch.
 */
export async function destroyAgent(
  handle: AgentHandle,
  repoPath: string,
): Promise<void> {
  await handle.kill().catch(() => {});
  await cleanupWorktree(repoPath, handle.worktreePath, handle.branch);
}

/**
 * Delete a task and clean up all associated resources: tmux session,
 * sandbox process, git worktree, branch, and task directory on disk.
 *
 * Works regardless of whether a live handle is available, so it correctly
 * cleans up historical/interrupted tasks that have no active sandbox.
 */
export async function deleteTask(
  taskId: string,
  repoPath: string,
  handle?: AgentHandle | null,
): Promise<void> {
  const worktreePath = join(dataDir(), "tasks", taskId, "worktree");
  const taskDir = join(dataDir(), "tasks", taskId);
  const branch = handle?.branch ?? `deer/${taskId}`;

  if (handle) {
    // Kill the tmux session via the handle
    await handle.kill().catch(() => {});
  } else {
    // No handle — kill the tmux session by its conventional name
    await Bun.spawn(
      ["tmux", "kill-session", "-t", `deer-${taskId}`],
      { stdout: "pipe", stderr: "pipe" },
    ).exited;
  }

  // Remove the git worktree and branch
  await cleanupWorktree(repoPath, worktreePath, branch);

  // Remove the task directory (worktree subdir is gone; remove parent)
  await Bun.$`rm -rf ${taskDir}`.quiet().nothrow();
}
