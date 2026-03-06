import { join, dirname } from "node:path";
import { existsSync, lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { startProxy } from "./proxy";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";
import { HOME } from "../constants";

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

// ── buildBwrapArgs helpers ────────────────────────────────────────────

/** Mount system directories, replicating symlinks (e.g. /bin -> usr/bin). */
function addSystemMounts(args: string[]): void {
  for (const path of SYSTEM_PATHS) {
    if (!existsSync(path)) continue;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path, "utf-8");
        args.push("--symlink", target, path);
      } else {
        args.push("--ro-bind", path, path);
      }
    } catch {
      args.push("--ro-bind", path, path);
    }
  }
}

/**
 * Mount specific home-directory paths needed by the sandbox.
 * Includes Claude config (rw), tool config dirs (ro), and PATH dirs under HOME.
 */
function addHomeMounts(args: string[], home: string): void {
  const mounted = new Set<string>();

  const addRo = (path: string) => {
    if (mounted.has(path)) return;
    mounted.add(path);
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
    mounted.add(claudeDir);
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
    addRo(join(home, ".config", sub));
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
      addRo(dir);

      try {
        for (const entry of readdirSync(dir)) {
          const entryPath = join(dir, entry);
          try {
            const stat = lstatSync(entryPath);
            if (stat.isSymbolicLink()) {
              const realPath = realpathSync(entryPath);
              if (realPath.startsWith(homePrefix)) {
                addRo(dirname(realPath));
              }
            }
          } catch { /* skip broken symlinks */ }
        }
      } catch { /* skip unreadable dirs */ }
    }
  }
}

/** Mount extra read-only and read-write paths from config. */
function addExtraMounts(args: string[], extraReadPaths?: string[], extraWritePaths?: string[]): void {
  if (extraReadPaths) {
    for (const path of extraReadPaths) {
      if (existsSync(path)) args.push("--ro-bind", path, path);
    }
  }
  if (extraWritePaths) {
    for (const path of extraWritePaths) {
      if (existsSync(path)) args.push("--bind", path, path);
    }
  }
}

/** Set environment variables inside the bwrap sandbox. */
function addBwrapEnv(
  args: string[],
  home: string,
  proxyPort: number,
  env?: Record<string, string>,
): void {
  if (proxyPort > 0) {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    args.push("--setenv", "HTTPS_PROXY", proxyUrl);
    args.push("--setenv", "HTTP_PROXY", proxyUrl);
  }
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      args.push("--setenv", key, value);
    }
  }
  args.push("--setenv", "HOME", home);
  args.push("--unsetenv", "CLAUDECODE");
  if (process.env.PATH) {
    args.push("--setenv", "PATH", process.env.PATH);
  }
  args.push("--setenv", "TERM", process.env.TERM ?? "xterm-256color");
}

// ── buildBwrapArgs ───────────────────────────────────────────────────

/**
 * Build the bwrap argument array for a given proxy port and options.
 */
function buildBwrapArgs(
  options: SandboxRuntimeOptions,
  innerCommand: string[],
  proxyPort: number,
): string[] {
  const { worktreePath, repoGitDir, extraReadPaths, extraWritePaths, env } = options;
  const home = HOME;
  const args: string[] = ["bwrap"];

  // Filesystem mounts
  addSystemMounts(args);
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--unshare-pid");
  args.push("--unshare-ipc");
  args.push("--tmpfs", "/tmp");
  addHomeMounts(args, home);
  addExtraMounts(args, extraReadPaths, extraWritePaths);

  // Main repo's .git/ directory — needed for git worktree operations.
  if (repoGitDir && existsSync(repoGitDir)) {
    args.push("--ro-bind", repoGitDir, repoGitDir);
  }

  // Worktree: the only persistent writable mount.
  // Must come after all read-only mounts so it overlays any parent ro-bind.
  args.push("--bind", worktreePath, worktreePath);

  // Process isolation
  args.push("--die-with-parent");
  args.push("--clearenv");
  args.push("--chdir", worktreePath);

  // Environment
  addBwrapEnv(args, home, proxyPort, env);

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
