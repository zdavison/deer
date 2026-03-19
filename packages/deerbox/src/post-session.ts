/**
 * Post-session logic: detect changes, prompt user, and act on their choice.
 *
 * Extracted from cli.ts so it can be tested with injectable dependencies.
 */

import type { CreatePRResult, UpdatePROptions } from "./git/finalize";

// ── ANSI helpers ─────────────────────────────────────────────────────

const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;

// ── Types ────────────────────────────────────────────────────────────

export type PostSessionChoice = "p" | "k" | "s" | "d";

export type PostSessionOutcome =
  | { action: "no_changes" }
  | { action: "pr_created"; prUrl: string }
  | { action: "pr_updated"; prUrl: string }
  | { action: "pr_failed"; error: string }
  | { action: "keep"; worktreePath: string }
  | { action: "shell"; worktreePath: string }
  | { action: "discard" };

export interface PostSessionDeps {
  /** Check whether the worktree has changes relative to the base branch. */
  hasChanges: (worktreePath: string, baseBranch: string) => Promise<boolean>;
  /** Prompt the user for their choice. */
  promptChoice: () => Promise<PostSessionChoice>;
  /** Create a pull request. */
  createPR: (opts: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
    prompt: string;
    onLog?: (msg: string) => void;
  }) => Promise<CreatePRResult>;
  /** Update an existing pull request (called when ctx.fromPrUrl is set). */
  updatePR?: (opts: UpdatePROptions) => Promise<void>;
  /** Open a shell in the worktree. Resolves when the shell exits. */
  openShell: (worktreePath: string) => Promise<void>;
  /** Stop the auth proxy (no worktree removal). */
  cleanup: () => Promise<void>;
  /** Stop the auth proxy AND remove the worktree. */
  destroy: () => Promise<void>;
  /** Write a message (to stderr). */
  log: (msg: string) => void;
}

export interface PostSessionContext {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  prompt: string;
  /**
   * When set, the user started from an existing PR/branch. The 'p' menu
   * option becomes "Update existing PR" and calls updatePR instead of createPR.
   * @example "https://github.com/org/repo/pull/42"
   */
  fromPrUrl?: string;
}

// ── Prompt rendering ─────────────────────────────────────────────────

export function renderPromptMenu(fromPrUrl?: string): string {
  const prLine = fromPrUrl
    ? `  ${green(bold("p"))}  ${green(`Update existing PR: ${fromPrUrl}`)}`
    : `  ${green(bold("p"))}  ${green("Create a pull request")}`;
  return [
    "",
    bold("What would you like to do with this session's changes?"),
    "",
    prLine,
    `  ${cyan(bold("k"))}  ${cyan("Keep worktree")}  ${dim("(default)")}`,
    `  ${yellow(bold("s"))}  ${yellow("Open a shell in the worktree")}`,
    `  ${red(bold("d"))}  ${red("Discard")}`,
    "",
    `${bold("Choice:")} `,
  ].join("\n");
}

/**
 * Parse user input into a PostSessionChoice.
 * Defaults to "k" (keep) for empty or unrecognized input.
 */
export function parseChoice(input: string): PostSessionChoice {
  const ch = input.trim().toLowerCase();
  if (ch === "p") return "p";
  if (ch === "s") return "s";
  if (ch === "d") return "d";
  return "k";
}

// ── Core logic ───────────────────────────────────────────────────────

/**
 * Run the post-session flow: check for changes, prompt user, execute their choice.
 */
export async function runPostSession(
  ctx: PostSessionContext,
  deps: PostSessionDeps,
): Promise<PostSessionOutcome> {
  const changed = await deps.hasChanges(ctx.worktreePath, ctx.baseBranch);

  if (!changed) {
    deps.log("\nNo changes to save.");
    await deps.destroy();
    return { action: "no_changes" };
  }

  const choice = await deps.promptChoice();

  if (choice === "p") {
    if (ctx.fromPrUrl) {
      deps.log("\nUpdating pull request...");
      try {
        await deps.updatePR?.({
          repoPath: ctx.repoPath,
          worktreePath: ctx.worktreePath,
          finalBranch: ctx.branch,
          baseBranch: ctx.baseBranch,
          prompt: ctx.prompt,
          prUrl: ctx.fromPrUrl,
          onLog: (msg) => deps.log(`  ${msg}`),
        });
        deps.log(`\n${green("PR updated:")} ${ctx.fromPrUrl}`);
        await deps.destroy();
        return { action: "pr_updated", prUrl: ctx.fromPrUrl };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log(`\nPR update failed: ${message}`);
        deps.log(`Worktree kept at: ${ctx.worktreePath}`);
        await deps.cleanup();
        return { action: "pr_failed", error: message };
      }
    }

    deps.log("\nCreating pull request...");
    try {
      const result = await deps.createPR({
        repoPath: ctx.repoPath,
        worktreePath: ctx.worktreePath,
        branch: ctx.branch,
        baseBranch: ctx.baseBranch,
        prompt: ctx.prompt,
        onLog: (msg) => deps.log(`  ${msg}`),
      });
      deps.log(`\n${green("PR created:")} ${result.prUrl}`);
      await deps.destroy();
      return { action: "pr_created", prUrl: result.prUrl };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`\nPR creation failed: ${message}`);
      deps.log(`Worktree kept at: ${ctx.worktreePath}`);
      await deps.cleanup();
      return { action: "pr_failed", error: message };
    }
  }

  if (choice === "k") {
    await deps.cleanup();
    deps.log(`\n${cyan("Worktree kept.")} To enter it:\n\n  cd ${ctx.worktreePath}\n`);
    return { action: "keep", worktreePath: ctx.worktreePath };
  }

  if (choice === "s") {
    await deps.cleanup();
    deps.log(`\nOpening shell in ${ctx.worktreePath}...\n`);
    await deps.openShell(ctx.worktreePath);
    return { action: "shell", worktreePath: ctx.worktreePath };
  }

  // d = discard
  await deps.destroy();
  deps.log("\nWorktree discarded.");
  return { action: "discard" };
}

// ── Default implementations (used by CLI) ────────────────────────────

/**
 * Interactive prompt via readline. Reads one line from stdin.
 */
export async function interactivePromptChoice(fromPrUrl?: string): Promise<PostSessionChoice> {
  process.stderr.write(renderPromptMenu(fromPrUrl));

  const readline = await import("readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.once("line", (line: string) => {
      rl.close();
      resolve(parseChoice(line));
    });
  });
}

/**
 * Open the user's shell in the given directory. Resolves when the shell exits.
 */
export async function defaultOpenShell(worktreePath: string): Promise<void> {
  const shell = process.env.SHELL ?? "/bin/sh";
  const shellProc = Bun.spawn([shell], {
    cwd: worktreePath,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await shellProc.exited;
}
