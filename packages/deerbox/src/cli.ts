#!/usr/bin/env bun

/**
 * deerbox CLI — run Claude Code in a sandboxed worktree.
 *
 * Interactive:
 *   deerbox "fix the login bug"
 *
 * Non-interactive (used by deer):
 *   deerbox prepare --repo-path /path --prompt "fix" --base-branch main
 *   deerbox destroy --task-id deer_xxx --repo-path /path
 *   deerbox preflight
 *   deerbox config --repo-path /path
 */

import { join } from "node:path";
import { prepare, taskWorktreePath } from "./session";
import { detectRepo } from "./git/worktree";
import { cleanupWorktree } from "./git/worktree";
import { loadConfig } from "./config";
import { runPreflight, resolveCredentials } from "./preflight";
import { killAuthProxy } from "./sandbox/auth-proxy";
import { VERSION, DEFAULT_MODEL } from "./constants";
import { dataDir } from "./task";
import { setLang, detectLang } from "./i18n";
import { createPullRequest, hasChanges } from "./git/finalize";
import { runPostSession, interactivePromptChoice, defaultOpenShell } from "./post-session";
import { prune } from "./prune";

// ── Helpers ──────────────────────────────────────────────────────────

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ── Subcommand: prepare ──────────────────────────────────────────────

async function cmdPrepare(args: string[]) {
  const repoPath = getArg(args, "--repo-path");
  const prompt = getArg(args, "--prompt");
  const baseBranch = getArg(args, "--base-branch");
  const model = getArg(args, "--model");
  const taskId = getArg(args, "--task-id");
  const configJson = getArg(args, "--config-json");
  const continueTaskId = getArg(args, "--continue-task-id");
  const continueWorktree = getArg(args, "--continue-worktree");
  const continueBranch = getArg(args, "--continue-branch");

  if (!repoPath || !baseBranch) {
    console.error("Usage: deerbox prepare --repo-path <path> --base-branch <branch> [--prompt <prompt>]");
    process.exit(1);
  }

  await resolveCredentials();

  const config = configJson ? JSON.parse(configJson) : undefined;

  const continueSession = continueTaskId && continueWorktree && continueBranch
    ? { taskId: continueTaskId, worktreePath: continueWorktree, branch: continueBranch }
    : undefined;

  const session = await prepare({
    repoPath,
    prompt,
    baseBranch,
    config,
    model,
    taskId,
    continueSession,
    daemonize: true,
    onStatus: (msg) => console.error(msg),
  });

  const result = {
    taskId: session.taskId,
    worktreePath: session.worktreePath,
    branch: session.branch,
    command: session.command,
    authProxyPid: session.authProxyPid,
  };

  console.log(JSON.stringify(result));
}

// ── Subcommand: destroy ──────────────────────────────────────────────

async function cmdDestroy(args: string[]) {
  const taskId = getArg(args, "--task-id");
  const repoPath = getArg(args, "--repo-path");

  if (!taskId || !repoPath) {
    console.error("Usage: deerbox destroy --task-id <id> --repo-path <path>");
    process.exit(1);
  }

  const worktreePath = taskWorktreePath(taskId);
  const taskDir = join(dataDir(), "tasks", taskId);
  const branch = `deer/${taskId}`;

  // Kill auth proxy by PID file
  const pidFile = join(taskDir, `deer-auth-${taskId}.sock.pid`);
  try {
    const pid = parseInt(await Bun.file(pidFile).text(), 10);
    if (!isNaN(pid)) killAuthProxy(pid);
  } catch { /* no proxy running */ }

  // Remove worktree and branch
  await cleanupWorktree(repoPath, worktreePath, branch);

  // Remove task directory
  await Bun.$`rm -rf ${taskDir}`.quiet().nothrow();
}

// ── Subcommand: prune ────────────────────────────────────────────────

async function cmdPrune(args: string[]) {
  const force = hasFlag(args, "--force");
  const dryRun = hasFlag(args, "--dry-run");

  if (dryRun) {
    console.log("Running in dry-run mode (no changes will be made)\n");
  }

  const result = await prune({
    force,
    dryRun,
    log: console.log,
  });

  console.log("\nDone:");
  if (force) {
    console.log(`  sandbox processes killed: ${result.processesKilled}`);
    console.log(`  tmux sessions killed:     ${result.tmuxKilled}`);
  }
  console.log(`  worktrees removed:        ${result.worktreesRemoved}`);
  console.log(`  task dirs cleaned:        ${result.tasksRemoved}`);

  if (dryRun) {
    console.log("\nNo changes were made. Run without --dry-run to execute.");
  }
}

// ── Subcommand: preflight ────────────────────────────────────────────

async function cmdPreflight() {
  await resolveCredentials();
  const result = await runPreflight();
  console.log(JSON.stringify(result));
}

// ── Subcommand: config ───────────────────────────────────────────────

async function cmdConfig(args: string[]) {
  const repoPath = getArg(args, "--repo-path");
  if (!repoPath) {
    console.error("Usage: deerbox config --repo-path <path>");
    process.exit(1);
  }
  const config = await loadConfig(repoPath);
  console.log(JSON.stringify(config));
}

// ── Interactive mode (default) ───────────────────────────────────────

async function cmdRun(prompt: string | undefined, args: string[]) {
  const model = getArg(args, "--model");
  const baseBranch = getArg(args, "--base-branch") ?? getArg(args, "-b");
  const keep = hasFlag(args, "--keep") || hasFlag(args, "-k");

  const startDir = process.cwd();
  let repoPath: string;
  let defaultBranch: string;
  try {
    const repo = await detectRepo(startDir);
    repoPath = repo.repoPath;
    defaultBranch = repo.defaultBranch;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const preflight = await runPreflight();
  if (!preflight.ok) {
    console.error("Preflight checks failed:");
    for (const e of preflight.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  await resolveCredentials();

  const config = await loadConfig(repoPath);
  const effectiveBranch = baseBranch ?? config.defaults.baseBranch ?? defaultBranch;

  // Initialize language for PR metadata generation
  setLang(detectLang());

  const session = await prepare({
    repoPath,
    prompt,
    baseBranch: effectiveBranch,
    config,
    model,
    onStatus: (msg) => console.error(`  ${msg}`),
  });

  console.error(`Starting sandboxed Claude...\n`);

  const proc = Bun.spawn(session.command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: session.worktreePath,
  });

  const exitCode = await proc.exited;

  if (keep) {
    await session.cleanup();
    console.error(`\nWorktree kept at: ${session.worktreePath}`);
    console.error(`  Branch: ${session.branch}`);
    process.exit(exitCode);
  }

  const outcome = await runPostSession(
    {
      repoPath,
      worktreePath: session.worktreePath,
      branch: session.branch,
      baseBranch: effectiveBranch,
      prompt: prompt ?? "Interactive session",
    },
    {
      hasChanges,
      promptChoice: interactivePromptChoice,
      createPR: createPullRequest,
      openShell: defaultOpenShell,
      cleanup: () => session.cleanup(),
      destroy: () => session.destroy(),
      log: (msg) => console.error(msg),
    },
  );

  if (outcome.action === "pr_failed") {
    process.exit(1);
  }

  process.exit(exitCode);
}

// ── Main router ──────────────────────────────────────────────────────

const HELP = `deerbox v${VERSION} — run Claude Code in a sandboxed worktree

Usage:
  deerbox [prompt]              Run sandboxed Claude (prompt optional — omit for interactive)
  deerbox prepare [options]     Prepare a session (JSON output, used by deer)
  deerbox destroy [options]     Clean up a task's resources
  deerbox prune [options]       Remove dangling worktrees and task dirs
  deerbox preflight             Run preflight checks (JSON output)
  deerbox config [options]      Dump merged config (JSON output)

Interactive options:
  -m, --model <model>           Claude model (default: ${DEFAULT_MODEL})
  -b, --base-branch <branch>    Branch to base the worktree on
  -k, --keep                    Keep worktree after Claude exits

Prune options:
  --force                       Kill all processes/sessions and wipe all task data
  --dry-run                     Show what would be removed without making changes

Examples:
  deerbox
  deerbox "fix the login redirect bug"
  deerbox --model opus "refactor the auth module"
  deerbox prune
  deerbox prune --force --dry-run`;

async function main() {
  const args = process.argv.slice(2);
  const first = args[0];

  if (first === "--help" || first === "-h") {
    console.log(HELP);
    return;
  }
  if (first === "--version" || first === "-v") {
    console.log(`deerbox ${VERSION}`);
    return;
  }

  // Subcommands
  if (first === "prepare") return cmdPrepare(args.slice(1));
  if (first === "destroy") return cmdDestroy(args.slice(1));
  if (first === "prune") return cmdPrune(args.slice(1));
  if (first === "preflight") return cmdPreflight();
  if (first === "config") return cmdConfig(args.slice(1));

  // Interactive mode: collect prompt from positional args
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model" || arg === "-m" || arg === "--base-branch" || arg === "-b") {
      i++; // skip value
    } else if (arg === "--keep" || arg === "-k") {
      // flag
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  const prompt = positional.length > 0 ? positional.join(" ") : undefined;

  await cmdRun(prompt, args);
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
