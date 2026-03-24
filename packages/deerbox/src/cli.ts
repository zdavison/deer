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
import { detectRepo } from "@deer/shared";
import { cleanupWorktree } from "./git/worktree";
import { loadConfig } from "./config";
import { runPreflight } from "./preflight";
import { resolveCredentials } from "@deer/shared";
import { killAuthProxy } from "./sandbox/auth-proxy";
import { VERSION } from "./constants";
import { DEFAULT_MODEL, setLang, detectLang, checkAndUpdate } from "@deer/shared";
import { dataDir } from "./task";
import { createPullRequest, updatePullRequest, hasChanges } from "./git/finalize";
import { runPostSession, interactivePromptChoice, defaultOpenShell, defaultMergeBranch } from "./post-session";
import { prune } from "./prune";
import { fetchPRComments } from "./pr-comments";

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

// ── Helpers ──────────────────────────────────────────────────────────

interface FromResolution {
  branch: string;
  prUrl: string | null;
  baseBranch: string;
}

/**
 * Resolve a --from value to a branch name, optional PR URL, and base branch.
 *
 * Accepts:
 * - A GitHub PR URL (https://github.com/owner/repo/pull/123)
 * - A PR number (123)
 * - A branch name (feature/my-branch)
 */
async function resolveFrom(from: string, repoPath: string, defaultBranch: string): Promise<FromResolution> {
  const isPrUrl = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(from);
  const isPrNumber = /^\d+$/.test(from);

  if (isPrUrl || isPrNumber) {
    const result = await Bun.$`gh pr view ${from} --json headRefName,url,baseRefName`.cwd(repoPath).quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new Error(`Could not find PR: ${from}`);
    }
    const data = JSON.parse(result.stdout.toString()) as { headRefName: string; url: string; baseRefName: string };
    return { branch: data.headRefName, prUrl: data.url, baseBranch: data.baseRefName };
  }

  // Branch name — check for an existing open PR
  const prResult = await Bun.$`gh pr list --head ${from} --state open --json url,baseRefName --limit 1`.cwd(repoPath).quiet().nothrow();
  if (prResult.exitCode === 0) {
    try {
      const prs = JSON.parse(prResult.stdout.toString()) as Array<{ url: string; baseRefName: string }>;
      if (prs.length > 0) {
        return { branch: from, prUrl: prs[0].url, baseBranch: prs[0].baseRefName };
      }
    } catch { /* ignore parse errors */ }
  }

  return { branch: from, prUrl: null, baseBranch: defaultBranch };
}

// ── Interactive mode (default) ───────────────────────────────────────

async function cmdRun(prompt: string | undefined, args: string[]) {
  const model = getArg(args, "--model");
  const baseBranch = getArg(args, "--base-branch") ?? getArg(args, "-b");
  const from = getArg(args, "--from") ?? getArg(args, "-f");
  const keep = hasFlag(args, "--keep") || hasFlag(args, "-k");

  const startDir = process.cwd();
  let repoPath: string;
  let defaultBranch: string;
  let originalBranch: string | undefined;
  try {
    const repo = await detectRepo(startDir);
    repoPath = repo.repoPath;
    defaultBranch = repo.defaultBranch;
    const branchResult = await Bun.$`git -C ${repoPath} rev-parse --abbrev-ref HEAD`.quiet().nothrow();
    const branch = branchResult.stdout.toString().trim();
    if (branch && branch !== "HEAD") originalBranch = branch;
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

  // Resolve --from to branch + optional existing PR URL
  let fromResolution: FromResolution | undefined;
  if (from) {
    try {
      fromResolution = await resolveFrom(from, repoPath, defaultBranch);
    } catch (err) {
      console.error(`Error resolving --from '${from}': ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // If --from resolved to a PR, fetch review comments and prepend as context
  let effectivePrompt = prompt;
  if (fromResolution?.prUrl) {
    const comments = await fetchPRComments(fromResolution.prUrl);
    if (comments) {
      effectivePrompt = prompt ? `${comments}\n\n${prompt}` : comments;
    }
  }

  const session = await prepare({
    repoPath,
    prompt: effectivePrompt,
    baseBranch: fromResolution?.baseBranch ?? effectiveBranch,
    fromBranch: fromResolution?.branch,
    config,
    model,
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

  const exitCode = await proc.exited;

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
      prompt: effectivePrompt ?? null,
      fromPrUrl: fromPrUrl ?? undefined,
      originalBranch,
    },
    {
      hasChanges: (wt, base) => hasChanges(wt, base, initialHeadSha),
      promptChoice: () => interactivePromptChoice(fromPrUrl ?? undefined, originalBranch),
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

Interactive options:
  -m, --model <model>           Claude model (default: ${DEFAULT_MODEL})
  -b, --base-branch <branch>    Branch to base the worktree on
  -f, --from <branch-or-PR>     Start from an existing branch or PR (URL or number)
  -k, --keep                    Keep worktree after Claude exits

Prune options:
  --force                       Kill all processes/sessions and wipe all task data

Examples:
  deerbox
  deerbox "fix the login redirect bug"
  deerbox --model opus "refactor the auth module"
  deerbox --from feature/my-branch "add more tests"
  deerbox --from 42 "address review comments"
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

  // Auto-update only in interactive mode
  await checkAndUpdate({ name: "deerbox", version: VERSION });

  // Interactive mode: collect prompt from positional args
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model" || arg === "-m" || arg === "--base-branch" || arg === "-b" || arg === "--from" || arg === "-f") {
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
