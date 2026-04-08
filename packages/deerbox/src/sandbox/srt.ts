import { join, dirname, basename } from "node:path";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";
import { HOME } from "@deer/shared";

/**
 * Resolve the srt binary path from the installed @anthropic-ai/sandbox-runtime package.
 *
 * Search order:
 * 1. Local node_modules (dev / bun run dev)
 * 2. deer data dir (~/.local/share/deer/node_modules) — installed by install.sh
 * 3. Bare "srt" on PATH (globally installed)
 */
function resolveSrtBin(): string {
  const candidates = [
    // 1. Local node_modules (works in dev)
    () => {
      const require = createRequire(import.meta.url);
      return require.resolve("@anthropic-ai/sandbox-runtime/dist/cli.js");
    },
    // 2. deer data dir (works for compiled binary)
    () => {
      const dataDir = join(HOME, ".local", "share", "deer");
      const cliPath = join(dataDir, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js");
      require("node:fs").accessSync(cliPath);
      return cliPath;
    },
  ];

  for (const candidate of candidates) {
    try {
      return candidate();
    } catch {
      continue;
    }
  }

  return "srt";
}

/**
 * Enumerate $HOME entries and return denyRead paths for everything
 * except entries that are ancestors of required paths
 * (worktree, claude binary, deer data dir, etc.).
 *
 * @param requiredPaths - Absolute paths that must remain readable.
 *   Any HOME entry that is an ancestor of a required path is excluded
 *   from the deny list.
 */
function buildHomeDenyList(requiredPaths: string[], home: string): string[] {
  // Extract the first path component under home for each required path
  const homePrefix = home.endsWith("/") ? home : home + "/";
  const requiredRoots = new Set<string>();
  for (const p of requiredPaths) {
    if (p.startsWith(homePrefix)) {
      const rel = p.slice(homePrefix.length);
      const root = rel.split("/")[0];
      if (root) requiredRoots.add(root);
    }
  }

  try {
    const entries = readdirSync(home);
    return entries
      .filter((name) => name !== ".mcp.json" && !requiredRoots.has(name))
      .map((name) => join(home, name));
  } catch {
    // Fallback to known sensitive paths if home is unreadable
    return [
      join(home, ".ssh"),
      join(home, ".aws"),
      join(home, ".azure"),
      join(home, ".config"),
      join(home, ".docker"),
      join(home, ".kube"),
      join(home, ".npmrc"),
      join(home, ".pypirc"),
      join(home, ".git-credentials"),
    ].filter((p) => {
      const name = p.slice(homePrefix.length).split("/")[0];
      return !requiredRoots.has(name ?? "");
    });
  }
}

/**
 * Resolve the git worktree's gitdir from its .git file.
 *
 * In git worktrees, the worktree directory contains a .git FILE (not a
 * directory) with a `gitdir: <path>` line pointing to the real metadata
 * directory inside the main repo's .git/worktrees/<name>/. The sandbox must
 * allow writes to this path so git operations (add, commit, etc.) succeed.
 *
 * Returns null if the .git file is absent or not a worktree .git file.
 */
function resolveWorktreeGitDir(worktreePath: string): string | null {
  try {
    const content = readFileSync(join(worktreePath, ".git"), "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // No .git file or unreadable — not a worktree
  }
  return null;
}

/**
 * Resolve real filesystem paths behind symlinks within a directory tree.
 *
 * Scans `dir` and all of its immediate subdirectories for symlinks and
 * returns their resolved real paths. This ensures symlinked tools
 * (skills, agents, commands, or any other extension) are included in
 * the sandbox's allowed paths.
 *
 * @param dir - Root directory to scan
 */
export function resolveSymlinkTargets(dir: string): string[] {
  const paths: string[] = [];

  function scanDir(scanPath: string, recurse: boolean): void {
    try {
      const entries = readdirSync(scanPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          try {
            paths.push(realpathSync(join(scanPath, entry.name)));
          } catch {
            // Unresolvable symlink — skip
          }
        } else if (recurse && entry.isDirectory()) {
          scanDir(join(scanPath, entry.name), false);
        }
      }
    } catch {
      // Unreadable or nonexistent directory — skip
    }
  }

  scanDir(dir, true);
  return paths;
}

/**
 * Enumerate sibling repo directories under the tasks root and return their
 * paths. With repo-scoped task layout (`tasks/<repoSlug>/<taskId>/`), denying
 * sibling repo dirs prevents cross-repo task access while keeping the current
 * repo's tasks visible.
 *
 * KNOWN LIMITATION: This only denies repo dirs that exist at sandbox creation
 * time. Repo dirs created after this sandbox starts will NOT be denied. SRT
 * does not support `allowRead` (only `denyRead`), so we cannot deny the
 * entire tasks root and re-allow the current repo — that would make the
 * worktree invisible. Denying siblings at creation time is the best we can
 * do without upstream SRT changes.
 *
 * @param worktreePath - The current task's worktree path, e.g.
 *   `~/.local/share/deer/tasks/my-repo/deer_abc/worktree`
 */
function buildSiblingRepoDenyList(worktreePath: string): string[] {
  // worktreePath = tasks/<repoSlug>/<taskId>/worktree
  const taskDir = dirname(worktreePath);       // tasks/<repoSlug>/<taskId>
  const repoDir = dirname(taskDir);            // tasks/<repoSlug>
  const tasksRoot = dirname(repoDir);          // tasks/
  const currentRepoSlug = basename(repoDir);

  try {
    const entries = readdirSync(tasksRoot);
    return entries
      .filter((name) => name !== currentRepoSlug)
      .map((name) => join(tasksRoot, name));
  } catch {
    return [];
  }
}

/**
 * Build an SRT settings JSON object from deer's sandbox options.
 */
function buildSrtSettings(options: SandboxRuntimeOptions, srtBinDir: string | null, home: string): Record<string, unknown> {
  const claudeConfigDir = options.claudeConfigDir ?? join(dirname(options.worktreePath), "claude-config");

  const network: Record<string, unknown> = {
    allowedDomains: options.allowlist,
    deniedDomains: [],
    // Allow binding to local ports so Claude Code features like voice mode
    // (which starts a local WebSocket server) work inside the sandbox.
    allowLocalBinding: true,
  };

  if (options.mitmProxy) {
    network.mitmProxy = {
      socketPath: options.mitmProxy.socketPath,
      domains: options.mitmProxy.domains,
    };
    // The Unix socket must be accessible from inside the sandbox
    network.allowUnixSockets = [dirname(options.mitmProxy.socketPath)];
  }

  // Resolve writable git paths: the worktree's own metadata dir, plus the
  // shared object store and refs that git add/commit need to write to.
  // Scoped tightly to avoid exposing .git/config, .git/hooks, or other
  // worktrees' metadata.
  const worktreeGitDir = resolveWorktreeGitDir(options.worktreePath);
  const gitWritePaths: string[] = [];
  if (worktreeGitDir) gitWritePaths.push(worktreeGitDir);
  if (options.repoGitDir) {
    gitWritePaths.push(
      join(options.repoGitDir, "objects"),
      join(options.repoGitDir, "refs"),
      join(options.repoGitDir, "logs"),
    );
  }

  // Collect paths that must stay readable: worktree, repo .git dir,
  // PATH entries under home, and the deer data dir (worktree parent).
  const requiredPaths = [
    options.worktreePath,
    dirname(options.worktreePath),
    ...(options.repoGitDir ? [options.repoGitDir] : []),
    ...(process.env.PATH?.split(":").filter((p) => p.startsWith(home)) ?? []),
    ...(srtBinDir ? [srtBinDir] : []),
    ...(options.extraReadPaths ?? []),
    ...resolveSymlinkTargets(claudeConfigDir),
  ];

  // Deny read access to all home entries except required roots.
  // Dynamically enumerated so new dotfiles/dirs are automatically blocked.
  const denyRead = [
    ...buildHomeDenyList(requiredPaths, home),
    // Credential files inside the per-task claude-config dir must be explicitly
    // denied. The sandbox must never see real tokens — all auth is handled by
    // the host-side MITM proxy.
    join(claudeConfigDir, ".credentials.json"),
    join(claudeConfigDir, "agent-oauth-token"),
    // Block sibling repo directories. With repo-scoped layout
    // (tasks/<repoSlug>/<taskId>/), we deny other repo slugs so tasks
    // from different repos can't read each other. Tasks within the same
    // repo remain visible to each other.
    ...buildSiblingRepoDenyList(options.worktreePath),
    // System credential files and root's home directory
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/sudoers.d",
    "/root",
    // Password manager dirs under .local/share
    join(home, ".local", "share", "keyrings"),
    join(home, ".local", "share", "gnome-keyring"),
    join(home, ".local", "share", "pass"),
    join(home, ".local", "share", "org.keepassxc.KeePassXC"),
    // Other users' home directories
    ...(() => {
      const homeParent = dirname(home);
      const currentUsername = basename(home);
      if (homeParent === home) return [];
      try {
        return readdirSync(homeParent)
          .filter(name => name !== currentUsername)
          .map(name => join(homeParent, name));
      } catch { return []; }
    })(),
  ];

  return {
    network,
    filesystem: {
      denyRead,
      allowWrite: [
        options.worktreePath,
        // Per-worktree gitdir (.git/worktrees/<name>/) and shared git
        // subdirectories needed for git add (objects) and commit (refs).
        ...gitWritePaths,
        claudeConfigDir,
        "/tmp",
        "/private/tmp",
        ...(options.extraWritePaths ?? []),
      ],
      denyWrite: [
        join(home, ".claude"),
        join(home, ".claude.json"),
        join(claudeConfigDir, ".credentials.json"),
        join(claudeConfigDir, "agent-oauth-token"),
      ],
    },
    // Claude Code runs interactively and needs setRawMode (tcsetattr)
    // on PTY devices for its terminal UI.
    allowPty: true,
  };
}

/** Shell-quote a string for use inside single quotes. */
function shellq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Create a sandbox runtime backed by Anthropic's Sandbox Runtime (srt).
 *
 * SRT handles cross-platform sandboxing automatically:
 * - macOS: sandbox-exec with dynamic Seatbelt profiles
 * - Linux: bubblewrap with mount namespaces + seccomp
 * - Network: built-in HTTP/SOCKS5 proxy with domain allowlisting
 *
 * This replaces the hand-rolled bwrap, seatbelt, and proxy implementations
 * with a single maintained library.
 */
export function createSrtRuntime(opts?: { home?: string }): SandboxRuntime {
  const home = opts?.home ?? HOME;
  const srtBin = resolveSrtBin();
  const srtBinDir = srtBin === "srt" ? null : dirname(dirname(srtBin));
  let settingsPath = "";

  return {
    name: "srt",

    async prepare(options: SandboxRuntimeOptions): Promise<SandboxCleanup> {
      const settings = buildSrtSettings(options, srtBinDir, home);
      settingsPath = join(dirname(options.worktreePath), "srt-settings.json");
      await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
      return () => {};
    },

    buildCommand(options: SandboxRuntimeOptions, innerCommand: string[]): string[] {
      const { worktreePath, env } = options;

      // Build the sandbox env overlay. SRT injects proxy env vars
      // (HTTP_PROXY, HTTPS_PROXY, etc.) before sandbox-exec, so we must NOT
      // use `env -i` which would wipe them. Instead we overlay our vars and
      // explicitly unset sensitive ones that shouldn't leak into the sandbox.
      const overlay: Record<string, string> = {};
      overlay.HOME = home;
      overlay.PATH = process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin";
      overlay.TERM = process.env.TERM ?? "xterm-256color";
      Object.assign(overlay, env ?? {});

      // Vars to explicitly remove from the sandbox environment.
      // CLAUDECODE must never be set (prevents nested deer detection).
      // User-blocked vars are removed via the env policy blocklist.
      const unsafeVars = new Set<string>(["CLAUDECODE"]);
      for (const key of options.envBlocklist ?? []) {
        unsafeVars.add(key);
      }
      // Don't unset vars that the overlay explicitly sets (e.g. placeholder values)
      const unsets = [...unsafeVars]
        .filter((k) => !(k in (env ?? {})))
        .map((k) => `-u ${k}`);

      const envAssigns = Object.entries(overlay).map(([k, v]) => `${k}=${shellq(v)}`);
      const escapedInner = innerCommand.map(shellq).join(" ");
      const shellCmd = `cd ${shellq(worktreePath)} && exec env ${unsets.join(" ")} ${envAssigns.join(" ")} ${escapedInner}`;

      return [srtBin, "-s", settingsPath, "-c", shellCmd];
    },
  };
}
