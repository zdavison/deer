import { join, dirname } from "node:path";
import { existsSync, lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { startProxy } from "./proxy";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";

/**
 * Paths that need to be available in the sandbox.
 *
 * On many distros /bin, /lib, /sbin are symlinks to /usr/*.
 * We detect this and use --symlink instead of --ro-bind to replicate
 * the host layout correctly.
 */
const SYSTEM_PATHS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/lib32",
  "/sbin",
  "/etc",
];

/**
 * Build the bwrap argument array for a given proxy port and options.
 */
function buildBwrapArgs(
  options: SandboxRuntimeOptions,
  innerCommand: string[],
  proxyPort: number,
): string[] {
  const { worktreePath, repoGitDir, extraReadPaths, extraWritePaths, env } = options;
  const home = process.env.HOME ?? "/root";

  const args: string[] = ["bwrap"];

  // System directories — ro-bind or symlink depending on host layout
  for (const path of SYSTEM_PATHS) {
    if (!existsSync(path)) continue;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        // e.g. /bin -> usr/bin: replicate as a symlink inside the sandbox
        const target = readlinkSync(path, "utf-8");
        args.push("--symlink", target, path);
      } else {
        args.push("--ro-bind", path, path);
      }
    } catch {
      args.push("--ro-bind", path, path);
    }
  }

  // Proc and dev
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");

  // Namespace isolation
  args.push("--unshare-pid");
  args.push("--unshare-ipc");

  // Tmpfs for /tmp (writable but ephemeral, not the host's /tmp)
  args.push("--tmpfs", "/tmp");

  // Home directory read-only mounts — only specific paths, not all of $HOME
  const homeMounts = new Set<string>();

  const addHomeMount = (path: string) => {
    if (homeMounts.has(path)) return;
    homeMounts.add(path);
    if (existsSync(path)) {
      args.push("--ro-bind", path, path);
    }
  };

  // Claude Code config — needs read-write for session state, conversations,
  // hooks, and config saves. This is a known security tradeoff: a compromised
  // agent could inject hooks or modify settings. The claude-config-guard
  // module monitors for such tampering at the dashboard level.
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) {
    homeMounts.add(claudeDir);
    args.push("--bind", claudeDir, claudeDir);
  }

  // ~/.claude.json — Claude Code writes config and backup files here.
  const claudeJson = join(home, ".claude.json");
  if (existsSync(claudeJson)) {
    args.push("--bind", claudeJson, claudeJson);
  }

  // Specific ~/.config sub-paths needed by tools (git, gh, deer).
  // Avoids exposing the entire ~/.config which contains unrelated secrets.
  for (const sub of ["git", "gh", "deer"]) {
    addHomeMount(join(home, ".config", sub));
  }

  // Mount PATH directories under HOME so sandboxed tools are found.
  // Mounts the specific directory (e.g. ~/.local/bin) rather than the
  // top-level parent (e.g. ~/.local) to avoid exposing unrelated data.
  // Also resolves symlinks in those dirs and mounts their real targets,
  // since binaries like `claude` may be symlinks to versioned paths
  // (e.g. ~/.local/bin/claude -> ~/.local/share/claude/versions/X).
  if (process.env.PATH) {
    const homePrefix = home + "/";
    for (const dir of process.env.PATH.split(":")) {
      if (!dir.startsWith(homePrefix)) continue;
      addHomeMount(dir);

      // Resolve symlink targets in this PATH dir
      try {
        for (const entry of readdirSync(dir)) {
          const entryPath = join(dir, entry);
          try {
            const stat = lstatSync(entryPath);
            if (stat.isSymbolicLink()) {
              const realPath = realpathSync(entryPath);
              if (realPath.startsWith(homePrefix)) {
                // Mount the directory containing the real binary
                addHomeMount(dirname(realPath));
              }
            }
          } catch { /* skip broken symlinks */ }
        }
      } catch { /* skip unreadable dirs */ }
    }
  }

  // Extra read-only paths
  if (extraReadPaths) {
    for (const path of extraReadPaths) {
      if (existsSync(path)) {
        args.push("--ro-bind", path, path);
      }
    }
  }

  // Extra read-write paths
  if (extraWritePaths) {
    for (const path of extraWritePaths) {
      if (existsSync(path)) {
        args.push("--bind", path, path);
      }
    }
  }

  // Main repo's .git/ directory — needed for git worktree operations.
  if (repoGitDir && existsSync(repoGitDir)) {
    args.push("--ro-bind", repoGitDir, repoGitDir);
  }

  // Worktree: the only persistent writable mount.
  // Must come after all read-only mounts so it overlays any parent ro-bind
  // (e.g. worktree under ~/.local/share/deer is inside the ~/.local ro-bind).
  args.push("--bind", worktreePath, worktreePath);

  // Process isolation
  args.push("--die-with-parent");
  args.push("--chdir", worktreePath);

  // Environment: proxy settings
  if (proxyPort > 0) {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    args.push("--setenv", "HTTPS_PROXY", proxyUrl);
    args.push("--setenv", "HTTP_PROXY", proxyUrl);
  }

  // Custom environment variables (e.g. CLAUDE_CODE_OAUTH_TOKEN)
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      args.push("--setenv", key, value);
    }
  }

  // Preserve HOME so Claude Code finds its config
  args.push("--setenv", "HOME", home);

  // Unset CLAUDECODE so nested Claude instances don't refuse to start
  args.push("--unsetenv", "CLAUDECODE");

  // Preserve PATH so sandboxed tools (claude, git, gh, etc.) are found
  if (process.env.PATH) {
    args.push("--setenv", "PATH", process.env.PATH);
  }

  // Preserve TERM so interactive TUI applications render correctly
  args.push("--setenv", "TERM", process.env.TERM ?? "xterm-256color");

  // Separator + inner command
  args.push("--");
  args.push(...innerCommand);

  return args;
}

/**
 * Create a bwrap sandbox runtime instance.
 *
 * Each call creates a fresh runtime with its own proxy lifecycle.
 * The proxy starts in prepare() and stops when the returned cleanup runs.
 *
 * Uses mount namespaces for filesystem isolation and a CONNECT proxy
 * for network allowlisting. The proxy runs host-side; the sandbox only
 * sees HTTP_PROXY/HTTPS_PROXY pointing at 127.0.0.1:<port>.
 *
 * Advantages over nono/Landlock:
 * - Path-based (no inode issues with atomic writes or backup files)
 * - Isolated /tmp (tmpfs, not shared with host)
 * - Works on kernel 3.8+ (vs 5.13+ for Landlock)
 *
 * Requires: bwrap binary in PATH.
 */
export function createBwrapRuntime(): SandboxRuntime {
  let proxyPort = 0;

  return {
    name: "bwrap",

    async prepare(options: SandboxRuntimeOptions): Promise<SandboxCleanup> {
      const proxy = await startProxy({ allowlist: options.allowlist });
      proxyPort = proxy.port;
      // Persist port so it can be restored if deer restarts while this task runs
      const portFile = join(dirname(options.worktreePath), "proxy-port");
      await Bun.write(portFile, String(proxyPort));
      return () => {
        proxy.stop();
        proxyPort = 0;
      };
    },

    async restoreProxy(worktreePath: string, allowlist: string[]): Promise<SandboxCleanup | null> {
      const portFile = join(dirname(worktreePath), "proxy-port");
      let savedPort: number;
      try {
        const contents = await readFile(portFile, "utf-8");
        savedPort = parseInt(contents.trim(), 10);
        if (!Number.isFinite(savedPort) || savedPort <= 0) return null;
      } catch {
        return null;
      }
      try {
        const proxy = await startProxy({ allowlist, port: savedPort });
        proxyPort = proxy.port;
        return () => {
          proxy.stop();
          proxyPort = 0;
        };
      } catch {
        // Port may be in use or otherwise unavailable; can't recover
        return null;
      }
    },

    buildCommand(options: SandboxRuntimeOptions, innerCommand: string[]): string[] {
      return buildBwrapArgs(options, innerCommand, proxyPort);
    },
  };
}
