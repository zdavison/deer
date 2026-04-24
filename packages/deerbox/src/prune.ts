import { join, dirname, isAbsolute, basename } from "node:path";
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dataDir } from "./task";

// ── Types ────────────────────────────────────────────────────────────

export interface PruneResult {
  tasksRemoved: number;
  worktreesRemoved: number;
  tmuxKilled: number;
  processesKilled: number;
}

export interface PruneOptions {
  /** Wipe all deer resources (kill processes, tmux sessions, remove all task data). */
  force?: boolean;
  /** Called for each action taken. */
  log?: (msg: string) => void;
}

const PRUNE_MIN_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract the creation timestamp from a task ID.
 * Format: deer_<base36-ms-timestamp><8-char-random-suffix>
 */
function taskCreatedAt(taskId: string): Date | null {
  const withoutPrefix = taskId.slice("deer_".length);
  if (withoutPrefix.length <= 8) return null;
  const timestampPart = withoutPrefix.slice(0, -8);
  const ms = parseInt(timestampPart, 36);
  if (isNaN(ms) || ms <= 0) return null;
  return new Date(ms);
}

function emit(msg: string, opts: PruneOptions): void {
  opts.log?.(msg);
}

/**
 * Returns true if the tmux session with the given name is currently running.
 */
export async function isTmuxSessionAlive(session: string): Promise<boolean> {
  const result = await Bun.$`tmux has-session -t ${session}`.quiet().nothrow();
  return result.exitCode === 0;
}

/**
 * Resolve the main git repo root from a git worktree directory.
 * Returns null if the path doesn't exist or isn't a valid git worktree.
 */
export async function getRepoPathFromWorktree(worktreePath: string): Promise<string | null> {
  const gitFile = Bun.file(join(worktreePath, ".git"));
  if (!(await gitFile.exists())) return null;

  const result = await Bun.$`git -C ${worktreePath} rev-parse --git-common-dir`.quiet().nothrow();
  if (result.exitCode !== 0) return null;

  const gitCommonDir = result.stdout.toString().trim();
  const absGitDir = isAbsolute(gitCommonDir)
    ? gitCommonDir
    : join(worktreePath, gitCommonDir);

  return dirname(absGitDir);
}

/**
 * Enumerate all task directories across all repo slugs.
 * Layout: tasks/<repoSlug>/<taskId>/
 */
async function getTaskDirs(): Promise<string[]> {
  const tasksDir = join(dataDir(), "tasks");
  const dirs: string[] = [];
  try {
    const repoEntries = await readdir(tasksDir, { withFileTypes: true });
    for (const repo of repoEntries) {
      if (!repo.isDirectory()) continue;
      const repoDir = join(tasksDir, repo.name);
      try {
        const taskEntries = await readdir(repoDir, { withFileTypes: true });
        for (const task of taskEntries) {
          if (task.isDirectory()) dirs.push(join(repoDir, task.name));
        }
      } catch {
        // Unreadable repo dir — skip
      }
    }
  } catch {
    // No tasks dir at all
  }
  return dirs;
}

async function removeWorktreeAndBranch(
  repoPath: string,
  worktreePath: string,
  branch: string,
  opts: PruneOptions,
): Promise<void> {
  emit(`Removing worktree: ${worktreePath} (branch: ${branch})`, opts);
  // worktreePath is always inside ~/.local/share/deer/tasks/ (deer-owned).
  // Only delete the branch if it is a deer-created branch (deer/<taskId>).
  await Bun.$`git -C ${repoPath} worktree remove ${worktreePath} --force`.quiet().nothrow();
  if (branch.startsWith("deer/")) {
    await Bun.$`git -C ${repoPath} branch -D ${branch}`.quiet().nothrow();
  }
}

async function killSandboxProcesses(opts: PruneOptions): Promise<number> {
  const result = await Bun.$`pgrep -a srt`.quiet().nothrow();
  if (result.exitCode !== 0) return 0;

  let killed = 0;
  const lines = result.stdout.toString().trim().split("\n").filter(Boolean);
  for (const line of lines) {
    if (!line.includes("deer")) continue;
    const pid = line.split(/\s+/)[0];
    if (!pid) continue;
    emit(`Killing srt process ${pid}: ${line.slice(0, 120)}`, opts);
    await Bun.$`kill -9 ${pid}`.quiet().nothrow();
    killed++;
  }
  return killed;
}

async function killTmuxSessions(opts: PruneOptions): Promise<number> {
  const result = await Bun.$`tmux list-sessions -F #S`.quiet().nothrow();
  if (result.exitCode !== 0) return 0;

  const sessions = result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((s) => s.startsWith("deer-"));

  for (const session of sessions) {
    emit(`Killing tmux session: ${session}`, opts);
    await Bun.$`tmux kill-session -t ${session}`.quiet().nothrow();
  }
  return sessions.length;
}

/**
 * Check if the auth proxy for a task is still alive by reading its PID file.
 */
function isProxyAlive(taskDir: string): boolean {
  const pidFile = join(taskDir, "proxy.sock.pid");
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Prune deer resources.
 *
 * Normal mode: removes task dirs and git worktrees for tasks that have no
 * active tmux session (i.e. the agent is no longer running).
 *
 * Force mode: kills all deer-related sandbox processes and tmux sessions,
 * removes all deer git worktrees and branches, and wipes the tasks directory.
 */
export async function prune(opts: PruneOptions = {}): Promise<PruneResult> {
  const result: PruneResult = {
    tasksRemoved: 0,
    worktreesRemoved: 0,
    tmuxKilled: 0,
    processesKilled: 0,
  };

  const taskDirs = await getTaskDirs();

  if (opts.force) {
    result.processesKilled = await killSandboxProcesses(opts);
    result.tmuxKilled = await killTmuxSessions(opts);

    // Remove worktrees for all known task dirs before wiping the tasks directory
    for (const taskDir of taskDirs) {
      const taskId = basename(taskDir);
      const worktreePath = join(taskDir, "worktree");
      const repoPath = await getRepoPathFromWorktree(worktreePath);
      if (repoPath) {
        await removeWorktreeAndBranch(repoPath, worktreePath, `deer/${taskId}`, opts);
        result.worktreesRemoved++;
      }
    }

    // Wipe the entire tasks directory
    const tasksDir = join(dataDir(), "tasks");
    emit(`Removing tasks directory: ${tasksDir} (${taskDirs.length} entries)`, opts);
    await Bun.$`rm -rf ${tasksDir}`.quiet().nothrow();
    result.tasksRemoved = taskDirs.length;
  } else {
    // Normal mode: prune only dangling task dirs (no live tmux session
    // and no live auth proxy process)
    for (const taskDir of taskDirs) {
      const taskId = basename(taskDir);
      const sessionAlive = await isTmuxSessionAlive(`deer-${taskId}`);
      if (sessionAlive) continue;

      // Also check if the auth proxy is still alive — when deerbox runs
      // interactively (no tmux), the proxy PID file is the only signal
      // that the task is still in use.
      if (isProxyAlive(taskDir)) continue;

      const createdAt = taskCreatedAt(taskId);
      if (createdAt && Date.now() - createdAt.getTime() < PRUNE_MIN_AGE_MS) continue;

      emit(`Pruning dangling task: ${taskId}`, opts);

      const worktreePath = join(taskDir, "worktree");
      const repoPath = await getRepoPathFromWorktree(worktreePath);
      if (repoPath) {
        await removeWorktreeAndBranch(repoPath, worktreePath, `deer/${taskId}`, opts);
        result.worktreesRemoved++;
      }

      emit(`Removing task dir: ${taskDir}`, opts);
      await Bun.$`rm -rf ${taskDir}`.quiet().nothrow();
      result.tasksRemoved++;
    }
  }

  return result;
}
