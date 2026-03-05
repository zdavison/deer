import { join } from "node:path";
import { existsSync, lstatSync, readlinkSync } from "node:fs";

export interface BwrapOptions {
  /** The worktree directory — mounted read-write */
  worktreePath: string;
  /**
   * Path to the main repo's `.git/` directory.
   * Git worktrees need read access to the parent repo's gitdir
   * for operations like `rev-parse --show-toplevel` to work correctly.
   * @example "/home/user/project/.git"
   */
  repoGitDir?: string;
  /** Port of the filtering proxy on 127.0.0.1 (0 to skip proxy env) */
  proxyPort: number;
  /** Extra environment variables to inject */
  env: Record<string, string>;
  /** Additional paths to bind read-only */
  extraRoBinds?: string[];
  /** Additional paths to bind read-write */
  extraRwBinds?: string[];
}

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
 * Build the argument array for a bwrap invocation.
 *
 * The sandbox:
 * - Mounts the worktree read-write (only writable path besides /tmp)
 * - Mounts system directories read-only (or as symlinks)
 * - Mounts ~/.claude read-only for Claude Code config
 * - Sets proxy env vars for network allowlisting
 * - Dies with the parent process
 */
export function buildBwrapArgs(options: BwrapOptions): string[] {
  const { worktreePath, repoGitDir, proxyPort, env, extraRoBinds, extraRwBinds } = options;
  const home = process.env.HOME ?? "/root";

  const args: string[] = ["bwrap"];

  // System directories — must come before the worktree bind so that
  // --tmpfs /tmp is laid down before the worktree bind overlays it.
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

  // Tmpfs for /tmp (writable but ephemeral, not the host's /tmp)
  args.push("--tmpfs", "/tmp");

  // Home directory read-only mounts.
  // Includes Claude config, tool configs, and any PATH directories under HOME
  // (e.g. ~/.local/bin/claude, ~/.bun/bin/bun) — mounted at the top-level
  // so symlink targets are included.
  const homeMounts = new Set<string>();

  const addHomeMount = (path: string) => {
    if (homeMounts.has(path)) return;
    homeMounts.add(path);
    if (existsSync(path)) {
      args.push("--ro-bind", path, path);
    }
  };

  // Claude Code config
  addHomeMount(join(home, ".claude"));
  addHomeMount(join(home, ".config"));

  // ~/.claude.json (onboarding state — single file, not a directory)
  const claudeJson = join(home, ".claude.json");
  if (existsSync(claudeJson)) {
    args.push("--ro-bind", claudeJson, claudeJson);
  }

  // Mount PATH directories under HOME so sandboxed tools are found
  if (process.env.PATH) {
    const homePrefix = home + "/";
    for (const dir of process.env.PATH.split(":")) {
      if (!dir.startsWith(homePrefix)) continue;
      const rel = dir.slice(homePrefix.length);
      const topLevel = join(home, rel.split("/")[0]);
      addHomeMount(topLevel);
    }
  }

  // Extra read-only binds
  if (extraRoBinds) {
    for (const path of extraRoBinds) {
      if (existsSync(path)) {
        args.push("--ro-bind", path, path);
      }
    }
  }

  // Extra read-write binds (overlays earlier ro-binds for same paths).
  // Format: "path" or "source:dest" for bind-mounting source at dest.
  if (extraRwBinds) {
    for (const spec of extraRwBinds) {
      const colonIdx = spec.indexOf(":");
      const [src, dest] = colonIdx >= 0
        ? [spec.slice(0, colonIdx), spec.slice(colonIdx + 1)]
        : [spec, spec];
      if (existsSync(src)) {
        args.push("--bind", src, dest);
      }
    }
  }

  // Main repo's .git/ directory — needed for git worktree operations.
  // Without this, git can't follow the worktree's gitdir reference and
  // commands like `rev-parse --show-toplevel` fail or resolve incorrectly.
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

  // Environment: custom vars
  for (const [key, value] of Object.entries(env)) {
    args.push("--setenv", key, value);
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

  return args;
}
