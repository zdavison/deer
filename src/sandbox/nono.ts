import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";
import { HOME } from "../constants";

/**
 * Path to the nono binary.
 * Looks for `nono` in PATH, falls back to /usr/local/bin/nono.
 */
const NONO_BIN = "nono";

/**
 * nono sandbox runtime (Landlock-based).
 *
 * Uses the claude-code profile as a base and adds per-task capabilities.
 * Requires Linux kernel 5.13+ for basic Landlock, 6.7+ for TCP filtering.
 *
 * Known limitation: Claude Code creates ~/.claude.json.backup.<timestamp>
 * files during config saves. Landlock's inode-based rules can't grant
 * MAKE_REG on $HOME for new files, causing intermittent EACCES errors.
 * Tracked upstream: https://github.com/always-further/nono/issues/220
 */
export const nonoRuntime: SandboxRuntime = {
  name: "nono",

  async prepare(): Promise<SandboxCleanup> {
    // Pre-create ~/.claude.json.lock so Landlock can attach a rule to it.
    // Claude Code's saveConfigWithLock creates this file; without it,
    // Landlock blocks creation (no MAKE_REG on ~/). See nono#220.
    const lockFile = join(HOME, ".claude.json.lock");
    await Bun.write(lockFile, "").catch(() => {});
    return () => {};
  },

  buildCommand(options: SandboxRuntimeOptions, innerCommand: string[]): string[] {
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

    // nono's --workdir only affects profile $WORKDIR expansion, not the actual CWD.
    // Wrap the command in a shell that cd's into the worktree first.
    const escapedInner = innerCommand
      .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
      .join(" ");
    args.push("sh", "-c", `cd '${worktreePath.replace(/'/g, "'\\''")}' && exec ${escapedInner}`);

    return args;
  },
};
