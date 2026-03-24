/**
 * Subprocess wrapper for invoking deerbox CLI.
 *
 * deer treats deerbox as a black box — all interaction happens through
 * CLI subcommands that output JSON to stdout.
 */

import { join, dirname } from "node:path";
import type { DeerConfig, PreflightResult, PrepareResult } from "./types";

export interface DeerboxBinOptions {
  /**
   * Override dev mode detection. In dev mode, TypeScript script fallbacks are tried.
   * In compiled binary mode, `process.execPath` is the compiled deer binary — NOT bun —
   * so running `.ts` scripts with it would launch the TUI instead of the CLI.
   * @default detected from process.argv[1] (true when argv[1] ends with .ts/.tsx)
   */
  isDevMode?: boolean;
  /**
   * Override process.argv[0] for testing.
   * @default process.argv[0]
   */
  argv0?: string;
}

/**
 * Resolve the deerbox binary/script path.
 *
 * Search order:
 * 1. Sibling binary (compiled: deer and deerbox in same directory)
 * 2. Workspace source (dev mode only: packages/deerbox/src/cli.ts via bun)
 * 3. cwd-relative source (dev mode only: for tests run from repo root)
 * 4. PATH lookup
 *
 * TypeScript script fallbacks (2, 3) are skipped in compiled binary mode because
 * `process.execPath` is the compiled deer binary there, not bun. Spawning the deer
 * binary with a `.ts` argument would silently launch the TUI instead of the CLI.
 */
export function deerboxBin(opts: DeerboxBinOptions = {}): string[] {
  const { accessSync, constants } = require("node:fs") as typeof import("node:fs");

  const argv0 = opts.argv0 ?? process.argv[0];
  const devMode = opts.isDevMode ?? (
    (process.argv[1] ?? "").endsWith(".ts") ||
    (process.argv[1] ?? "").endsWith(".tsx")
  );

  // 1. Sibling binary (production: deer and deerbox compiled to same dir)
  const selfDir = dirname(argv0);
  const sibling = join(selfDir, "deerbox");
  try {
    accessSync(sibling, constants.X_OK);
    return [sibling];
  } catch { /* not found */ }

  // 2–3. TypeScript script fallbacks — dev mode only.
  // In compiled binary mode, process.execPath is the compiled deer binary, not bun.
  if (devMode) {
    // 2. Workspace source relative to this module (dev)
    const moduleDir = typeof import.meta.dir === "string" ? import.meta.dir : selfDir;
    const workspaceScript = join(moduleDir, "..", "packages", "deerbox", "src", "cli.ts");
    try {
      accessSync(workspaceScript);
      return [process.execPath, workspaceScript];
    } catch { /* not found */ }

    // 3. Try relative to cwd (tests)
    const cwdScript = join(process.cwd(), "packages", "deerbox", "src", "cli.ts");
    try {
      accessSync(cwdScript);
      return [process.execPath, cwdScript];
    } catch { /* not found */ }
  }

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
