import { existsSync } from "node:fs";
import { join } from "node:path";

export interface NonoOptions {
  /** The worktree directory — mounted read-write */
  worktreePath: string;
  /**
   * Path to the main repo's `.git/` directory.
   * Mounted read-only so git worktree operations work inside the sandbox.
   * @example "/home/user/project/.git"
   */
  repoGitDir?: string;
  /** Hosts to allow through the network proxy */
  allowlist: string[];
  /** Additional paths to grant read-only access */
  extraReadPaths?: string[];
  /** Additional paths to grant read-write access */
  extraWritePaths?: string[];
}

/**
 * Path to the nono binary.
 * Looks for `nono` in PATH, falls back to /usr/local/bin/nono.
 */
const NONO_BIN = "nono";

/**
 * Build the argument array for a nono invocation.
 *
 * The sandbox:
 * - Grants read-write access to the worktree (the working directory)
 * - Uses the claude-code network profile as a base
 * - Adds custom allowlist entries via --proxy-allow
 * - Grants read access to the repo's .git/ directory
 * - Runs in silent mode (no banner) with --exec for TTY passthrough
 */
export function buildNonoArgs(options: NonoOptions): string[] {
  const { worktreePath, repoGitDir, allowlist, extraReadPaths, extraWritePaths } = options;

  const args: string[] = [
    NONO_BIN,
    "run",
    "--silent",
    // Use claude-code profile as base (includes system paths, dev tools,
    // ~/.claude rw, git config, etc.)
    "--profile", "claude-code",
    // Grant read-write to the worktree
    "--allow", worktreePath,
    // Required in --silent mode to avoid interactive CWD prompt
    "--allow-cwd",
  ];

  // Network allowlist — each host gets a --proxy-allow flag
  for (const host of allowlist) {
    args.push("--proxy-allow", host);
  }

  // Repo .git/ directory — needed for git worktree operations
  if (repoGitDir && existsSync(repoGitDir)) {
    args.push("--read", repoGitDir);
  }

  // Extra read-only paths
  if (extraReadPaths) {
    for (const path of extraReadPaths) {
      if (existsSync(path)) {
        args.push("--read", path);
      }
    }
  }

  // Extra read-write paths
  if (extraWritePaths) {
    for (const path of extraWritePaths) {
      if (existsSync(path)) {
        args.push("--allow", path);
      }
    }
  }

  // Separator between nono args and the command
  args.push("--");

  return args;
}
