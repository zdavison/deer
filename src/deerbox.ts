/**
 * Subprocess wrapper for invoking deerbox CLI.
 *
 * deer treats deerbox as a black box — all interaction happens through
 * CLI subcommands that output JSON to stdout.
 */

import { join, dirname } from "node:path";
import type { DeerConfig, PreflightResult, PrepareResult } from "./types";

/**
 * Resolve the deerbox binary/script path.
 *
 * Search order:
 * 1. Sibling binary (compiled: deer and deerbox in same directory)
 * 2. Workspace source (dev: packages/deerbox/src/cli.ts via bun)
 * 3. PATH lookup
 */
function deerboxBin(): string[] {
  const { accessSync, constants } = require("node:fs") as typeof import("node:fs");

  // 1. Sibling binary (production)
  const selfDir = dirname(process.argv[0]);
  const sibling = join(selfDir, "deerbox");
  try {
    accessSync(sibling, constants.X_OK);
    return [sibling];
  } catch { /* not found */ }

  // 2. Workspace source (dev)
  const workspaceScript = join(selfDir, "..", "packages", "deerbox", "src", "cli.ts");
  try {
    accessSync(workspaceScript);
    return ["bun", workspaceScript];
  } catch { /* not found */ }

  // 3. Try relative to cwd (tests)
  const cwdScript = join(process.cwd(), "packages", "deerbox", "src", "cli.ts");
  try {
    accessSync(cwdScript);
    return ["bun", cwdScript];
  } catch { /* not found */ }

  // 4. Fall back to PATH
  return ["deerbox"];
}

/**
 * Run a deerbox subcommand and parse JSON output.
 */
async function runDeerbox<T>(args: string[]): Promise<T> {
  const cmd = deerboxBin();
  const proc = Bun.spawn([...cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`deerbox ${args[0]} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }

  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`deerbox ${args[0]} returned invalid JSON: ${stdout.slice(0, 200)}`);
  }
}

/**
 * Run deerbox preflight checks.
 */
export async function deerboxPreflight(): Promise<PreflightResult> {
  return runDeerbox<PreflightResult>(["preflight"]);
}

/**
 * Load merged config from deerbox.
 */
export async function deerboxConfig(repoPath: string): Promise<DeerConfig> {
  return runDeerbox<DeerConfig>(["config", "--repo-path", repoPath]);
}

export interface DeerboxPrepareOptions {
  repoPath: string;
  prompt?: string;
  baseBranch: string;
  config?: DeerConfig;
  model?: string;
  taskId?: string;
  continueSession?: {
    taskId: string;
    worktreePath: string;
    branch: string;
  };
}

/**
 * Prepare a sandboxed Claude session via deerbox.
 */
export async function deerboxPrepare(opts: DeerboxPrepareOptions): Promise<PrepareResult> {
  const args = [
    "prepare",
    "--repo-path", opts.repoPath,
    "--base-branch", opts.baseBranch,
  ];
  if (opts.prompt) args.push("--prompt", opts.prompt);
  if (opts.config) args.push("--config-json", JSON.stringify(opts.config));
  if (opts.model) args.push("--model", opts.model);
  if (opts.taskId) args.push("--task-id", opts.taskId);
  if (opts.continueSession) {
    args.push(
      "--continue-task-id", opts.continueSession.taskId,
      "--continue-worktree", opts.continueSession.worktreePath,
      "--continue-branch", opts.continueSession.branch,
    );
  }

  return runDeerbox<PrepareResult>(args);
}

/**
 * Destroy a task's resources via deerbox (worktree, branch, auth proxy, task dir).
 */
export async function deerboxDestroy(taskId: string, repoPath: string): Promise<void> {
  const cmd = deerboxBin();
  const proc = Bun.spawn(
    [...cmd, "destroy", "--task-id", taskId, "--repo-path", repoPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}
