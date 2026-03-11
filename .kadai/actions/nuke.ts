#!/usr/bin/env bun
// kadai:name Nuke
// kadai:emoji 💣
// kadai:description Kill all deer sandbox processes and remove all deer worktrees
// kadai:confirm true

import { $ } from "bun";

const DRY_RUN = process.argv.includes("--dry-run");

function log(msg: string) {
  console.log(DRY_RUN ? `[dry-run] ${msg}` : msg);
}

// ── Kill deer-related sandbox processes ──────────────────────────────

async function killSandboxProcesses(): Promise<number> {
  // Find srt processes whose command line references deer
  let killed = 0;

  for (const proc of ["srt"]) {
    const result = await $`pgrep -a ${proc}`.quiet().nothrow();
    if (result.exitCode !== 0) continue;

    const lines = result.stdout.toString().trim().split("\n").filter(Boolean);
    for (const line of lines) {
      if (!line.includes("deer")) continue;
      const pid = line.split(/\s+/)[0];
      if (!pid) continue;
      log(`Killing ${proc} process ${pid}: ${line.slice(0, 120)}`);
      if (!DRY_RUN) {
        await $`kill -9 ${pid}`.quiet().nothrow();
      }
      killed++;
    }
  }

  return killed;
}

// ── Kill deer tmux sessions ──────────────────────────────────────────

async function killTmuxSessions(): Promise<number> {
  const result = await $`tmux list-sessions -F #S`.quiet().nothrow();
  if (result.exitCode !== 0) return 0;

  const sessions = result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((s) => s.startsWith("deer-"));

  for (const session of sessions) {
    log(`Killing tmux session: ${session}`);
    if (!DRY_RUN) {
      await $`tmux kill-session -t ${session}`.quiet().nothrow();
    }
  }

  return sessions.length;
}

// ── Remove deer worktrees ────────────────────────────────────────────

async function removeWorktrees(): Promise<number> {
  const repoResult = await $`git rev-parse --show-toplevel`.quiet().nothrow();
  if (repoResult.exitCode !== 0) {
    console.error("Not inside a git repository.");
    return 0;
  }
  const repoPath = repoResult.stdout.toString().trim();
  // List all worktrees and find deer ones
  const wtResult = await $`git -C ${repoPath} worktree list --porcelain`.quiet().nothrow();
  if (wtResult.exitCode !== 0) return 0;

  const worktrees: Array<{ path: string; branch: string | null }> = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of wtResult.stdout.toString().split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath) {
        worktrees.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.slice("worktree ".length);
      currentBranch = null;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      currentBranch = ref.replace("refs/heads/", "");
    }
  }
  if (currentPath) {
    worktrees.push({ path: currentPath, branch: currentBranch });
  }

  const deerWorktrees = worktrees.filter(
    (wt) => wt.branch?.startsWith("deer/") || wt.path.includes("/deer/")
  );

  for (const wt of deerWorktrees) {
    log(`Removing worktree: ${wt.path} (branch: ${wt.branch ?? "none"})`);
    if (!DRY_RUN) {
      await $`git -C ${repoPath} worktree remove ${wt.path} --force`.quiet().nothrow();
      if (wt.branch) {
        await $`git -C ${repoPath} branch -D ${wt.branch}`.quiet().nothrow();
      }
    }
  }

  return deerWorktrees.length;
}

// ── Clean up deer data directory ─────────────────────────────────────

async function cleanDataDir(): Promise<number> {
  const home = process.env.HOME;
  const tasksDir = `${home}/.local/share/deer/tasks`;
  const result = await $`ls ${tasksDir}`.quiet().nothrow();
  if (result.exitCode !== 0) return 0;

  const entries = result.stdout.toString().trim().split("\n").filter(Boolean);
  if (entries.length === 0) return 0;

  log(`Removing deer tasks directory: ${tasksDir} (${entries.length} entries)`);
  if (!DRY_RUN) {
    await $`rm -rf ${tasksDir}`.quiet().nothrow();
  }

  return entries.length;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) {
    console.log("Running in dry-run mode (no changes will be made)\n");
  }

  console.log("Nuking all deer resources...\n");

  const sandboxCount = await killSandboxProcesses();
  const tmuxCount = await killTmuxSessions();
  const worktreeCount = await removeWorktrees();
  const taskCount = await cleanDataDir();

  console.log("\nDone:");
  console.log(`  sandbox processes killed: ${sandboxCount}`);
  console.log(`  tmux sessions killed:    ${tmuxCount}`);
  console.log(`  worktrees removed:       ${worktreeCount}`);
  console.log(`  task dirs cleaned:       ${taskCount}`);

  if (DRY_RUN) {
    console.log("\nNo changes were made. Run without --dry-run to execute.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
