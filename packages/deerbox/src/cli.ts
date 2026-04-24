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
import type { PrepareOptions } from "./session";
import { findMostRecentTask } from "./task";
import { detectRepo } from "@deer/shared";
import { detectWorktreeContext } from "./git/worktree";
import { cleanupWorktree } from "./git/worktree";
import { loadConfig } from "./config";
import { runPreflight } from "./preflight";
import { resolveCredentials } from "@deer/shared";
import { killAuthProxy } from "./sandbox/auth-proxy";
import { VERSION } from "./constants";
import { DEFAULT_MODEL, setLang, detectLang, checkAndUpdate } from "@deer/shared";
import { dataDir, repoSlug } from "./task";
import { createPullRequest, updatePullRequest, hasChanges } from "./git/finalize";
import { runPostSession, interactivePromptChoice, defaultOpenShell, defaultMergeBranch } from "./post-session";
import { prune } from "./prune";
import { resolveFrom } from "./from";
import type { FromResolution } from "./from";
import {
  detectRiskyEnvVars,
  loadEnvPolicy,
  saveEnvPolicy,
  runEnvReview,
  runEnvPreflight,
} from "@deer/shared";

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

  const worktreePath = taskWorktreePath(repoPath, taskId);
  const taskDir = join(dataDir(), "tasks", repoSlug(repoPath), taskId);
  const branch = `deer/${taskId}`;

  // Kill auth proxy by PID file
  const pidFile = join(taskDir, "proxy.sock.pid");
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

  const result = await prune({
    force,
    log: console.log,
  });

  console.log("\nDone:");
  if (force) {
    console.log(`  sandbox processes killed: ${result.processesKilled}`);
    console.log(`  tmux sessions killed:     ${result.tmuxKilled}`);
  }
  console.log(`  worktrees removed:        ${result.worktreesRemoved}`);
  console.log(`  task dirs cleaned:        ${result.tasksRemoved}`);
}

// ── Subcommand: env ──────────────────────────────────────────────────

async function cmdEnv() {
  const policy = loadEnvPolicy();
  const riskyVars = detectRiskyEnvVars();

  // Pass all risky vars (not just unreviewed) so the user can change existing decisions.
  // Already-approved vars will be pre-checked in the UI.
  if (riskyVars.length > 0) {
    const updatedPolicy = await runEnvReview(riskyVars, policy);
    await saveEnvPolicy(updatedPolicy);
    console.error("Environment variable policy saved.");
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

async function cmdRun(prompt: string | undefined, args: string[], continueMode: boolean = false) {
  const model = getArg(args, "--model");
  const baseBranch = getArg(args, "--base-branch") ?? getArg(args, "-b");
  const from = getArg(args, "--from") ?? getArg(args, "-f");
  const keep = hasFlag(args, "--keep") || hasFlag(args, "-k");

  const startDir = process.cwd();
  let repoPath: string;
  let defaultBranch: string;
  let originalBranch: string | undefined;
  let reuseWorktree: PrepareOptions["reuseWorktree"];
  try {
    const repo = await detectRepo(startDir);
    repoPath = repo.repoPath;
    defaultBranch = repo.defaultBranch;
    const branchResult = await Bun.$`git -C ${repoPath} rev-parse --abbrev-ref HEAD`.quiet().nothrow();
    const branch = branchResult.stdout.toString().trim();
    if (branch && branch !== "HEAD") originalBranch = branch;

    // If we're inside a linked git worktree, reuse it rather than creating
    // a new one. This supports users who already use worktrees and run
    // deerbox from within one.
    const wtCtx = await detectWorktreeContext(startDir);
    if (wtCtx) {
      const realRepo = await detectRepo(wtCtx.repoPath);
      repoPath = realRepo.repoPath;
      defaultBranch = realRepo.defaultBranch;
      reuseWorktree = {
        worktreePath: wtCtx.worktreePath,
        branch: wtCtx.branch,
        repoGitDir: wtCtx.repoGitDir,
      };
      // Don't attempt to check out back to the outer agent's branch post-session
      originalBranch = undefined;
    }
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
  for (const w of preflight.warnings) {
    console.error(`⚠ ${w}`);
  }

  // Env var review — only in interactive mode (not in prepare/preflight/etc.)
  await runEnvPreflight();

  await resolveCredentials();

  const config = await loadConfig(repoPath);
  const effectiveBranch = baseBranch ?? config.defaults.baseBranch ?? defaultBranch;

  // Initialize language for PR metadata generation
  setLang(detectLang());

  // Resolve --from to branch + optional existing PR URL + optional system prompt context
  let fromResolution: FromResolution | undefined;
  if (from) {
    try {
      fromResolution = await resolveFrom(from, repoPath, defaultBranch);
    } catch (err) {
      console.error(`Error resolving --from '${from}': ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  let continueSession: PrepareOptions["continueSession"] | undefined;
  if (continueMode) {
    const found = await findMostRecentTask(repoPath);
    if (!found) {
      console.error("No previous deerbox session found for this repository.");
      process.exit(1);
    }
    continueSession = found;
    console.error(`Resuming: ${found.taskId} (branch: ${found.branch})`);
  }

  const session = await prepare({
    repoPath,
    prompt: continueMode ? undefined : prompt,
    baseBranch: fromResolution?.baseBranch ?? effectiveBranch,
    fromBranch: fromResolution?.branch,
    config,
    model,
    reuseWorktree,
    continueSession,
    appendSystemPrompt: fromResolution?.appendSystemPrompt,
    onStatus: (msg) => console.error(`  ${msg}`),
  });

  // Capture HEAD before Claude runs so we can detect only new changes for --from
  let initialHeadSha: string | undefined;
  if (fromResolution) {
    const headResult = await Bun.$`git -C ${session.worktreePath} rev-parse HEAD`.quiet().nothrow();
    initialHeadSha = headResult.stdout.toString().trim() || undefined;
  }

  console.error(`Starting sandboxed Claude...\n`);

  const proc = Bun.spawn(session.command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: session.worktreePath,
  });

  // Handle Ctrl+C: clean up the session before exiting so the SRT process
  // runs cleanupBwrapMountPoints() and ghost files don't linger.
  const sigintHandler = () => {
    proc.kill("SIGINT");
  };
  process.on("SIGINT", sigintHandler);

  const exitCode = await proc.exited;

  process.off("SIGINT", sigintHandler);

  // Remove any ghost files left by SRT's bwrap mount-point creation.
  // bwrap creates empty files for DANGEROUS_FILES relative to the CWD
  // as bind-mount targets. If cleanup doesn't run (SIGKILL, crash),
  // these persist as empty untracked files.
  const SRT_GHOST_FILES = [
    ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile",
    ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json",
  ];
  for (const dir of [session.worktreePath, repoPath]) {
    for (const name of SRT_GHOST_FILES) {
      const ghost = join(dir, name);
      try {
        const file = Bun.file(ghost);
        if (await file.exists() && (await file.size) === 0) {
          await Bun.$`rm -f ${ghost}`.quiet().nothrow();
        }
      } catch { /* ignore */ }
    }
  }

  if (keep) {
    await session.cleanup();
    console.error(`\nWorktree kept at: ${session.worktreePath}`);
    console.error(`  Branch: ${session.branch}`);
    process.exit(exitCode);
  }

  const fromPrUrl = fromResolution?.prUrl ?? null;
  const postSessionBaseBranch = fromResolution?.baseBranch ?? effectiveBranch;

  const outcome = await runPostSession(
    {
      repoPath,
      worktreePath: session.worktreePath,
      branch: session.branch,
      baseBranch: postSessionBaseBranch,
      prompt: prompt ?? null,
      fromPrUrl: fromPrUrl ?? undefined,
      fromPrIsFork: fromResolution?.isCrossRepository,
      originalBranch,
      appendPRSystemPrompt: fromResolution?.appendPRSystemPrompt,
    },
    {
      hasChanges: (wt, base) => hasChanges(wt, base, initialHeadSha),
      promptChoice: () => interactivePromptChoice(fromPrUrl ?? undefined, originalBranch, fromResolution?.isCrossRepository),
      createPR: createPullRequest,
      updatePR: (opts) => updatePullRequest(opts),
      mergeBranch: defaultMergeBranch,
      openShell: defaultOpenShell,
      cleanup: () => session.cleanup(),
      destroy: () => session.destroy(),
      log: (msg) => console.error(msg),
    },
  );

  if (outcome.action === "pr_failed" || outcome.action === "merge_failed") {
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
  deerbox env                   Review and update the env var policy

Interactive options:
  -c, --continue                Resume the most recent session for this repository
  -m, --model <model>           Claude model (default: ${DEFAULT_MODEL})
  -b, --base-branch <branch>    Branch to base the worktree on
  -f, --from <source>           Start from a branch, PR (URL/#), GitHub issue URL, GitHub Actions URL, or worktree path
  -k, --keep                    Keep worktree after Claude exits

Prune options:
  --force                       Kill all processes/sessions and wipe all task data

Examples:
  deerbox
  deerbox "fix the login redirect bug"
  deerbox --model opus "refactor the auth module"
  deerbox --from feature/my-branch "add more tests"
  deerbox --from 42 "address review comments"
  deerbox --from https://github.com/org/repo/issues/276 "implement the feature"
  deerbox --from https://github.com/org/repo/actions/runs/123/job/456 "fix the CI failure"
  deerbox --from ./path/to/worktree "continue work on that branch"
  deerbox --from /absolute/path/to/worktree "continue work on that branch"
  deerbox prune
  deerbox prune --force`;

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
  if (first === "env") return cmdEnv();

  // Auto-update only in interactive mode
  await checkAndUpdate({ name: "deerbox", version: VERSION });

  // Prune dangling deer-created worktrees on startup — silent, fire and forget.
  prune({ force: false, log: () => {} }).catch(() => {});

  // Interactive mode: collect prompt from positional args
  const positional: string[] = [];
  let continueMode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model" || arg === "-m" || arg === "--base-branch" || arg === "-b" || arg === "--from" || arg === "-f") {
      i++; // skip value
    } else if (arg === "--keep" || arg === "-k") {
      // flag
    } else if (arg === "--continue" || arg === "-c") {
      continueMode = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  const prompt = positional.length > 0 ? positional.join(" ") : undefined;

  await cmdRun(prompt, args, continueMode);
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
