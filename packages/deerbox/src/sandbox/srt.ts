import { join, dirname } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
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
 * except .claude* and entries that are ancestors of required paths
 * (worktree, claude binary, deer data dir, etc.).
 *
 * @param requiredPaths - Absolute paths that must remain readable.
 *   Any HOME entry that is an ancestor of a required path is excluded
 *   from the deny list.
 */
function buildHomeDenyList(requiredPaths: string[]): string[] {
  // Extract the first path component under HOME for each required path
  const homePrefix = HOME.endsWith("/") ? HOME : HOME + "/";
  const requiredRoots = new Set<string>();
  for (const p of requiredPaths) {
    if (p.startsWith(homePrefix)) {
      const rel = p.slice(homePrefix.length);
      const root = rel.split("/")[0];
      if (root) requiredRoots.add(root);
    }
  }

  try {
    const entries = readdirSync(HOME);
    return entries
      .filter((name) => !name.startsWith(".claude") && name !== ".mcp.json" && !requiredRoots.has(name))
      .map((name) => join(HOME, name));
  } catch {
    // Fallback to known sensitive paths if HOME is unreadable
    return [
      join(HOME, ".ssh"),
      join(HOME, ".aws"),
      join(HOME, ".azure"),
      join(HOME, ".config"),
      join(HOME, ".docker"),
      join(HOME, ".kube"),
      join(HOME, ".npmrc"),
      join(HOME, ".pypirc"),
      join(HOME, ".git-credentials"),
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
 * Build an SRT settings JSON object from deer's sandbox options.
 */
function buildSrtSettings(options: SandboxRuntimeOptions, srtBinDir: string | null): Record<string, unknown> {
  const claudeDir = join(HOME, ".claude");

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
  // PATH entries under HOME, and the deer data dir (worktree parent).
  const requiredPaths = [
    options.worktreePath,
    dirname(options.worktreePath),
    ...(options.repoGitDir ? [options.repoGitDir] : []),
    ...(process.env.PATH?.split(":").filter((p) => p.startsWith(HOME)) ?? []),
    ...(srtBinDir ? [srtBinDir] : []),
    ...(options.extraReadPaths ?? []),
  ];

  // Deny read access to all HOME entries except .claude* and required roots.
  // Dynamically enumerated so new dotfiles/dirs are automatically blocked.
  const denyRead = buildHomeDenyList(requiredPaths);

  return {
    network,
    filesystem: {
      denyRead,
      allowWrite: [
        options.worktreePath,
        // Per-worktree gitdir (.git/worktrees/<name>/) and shared git
        // subdirectories needed for git add (objects) and commit (refs).
        ...gitWritePaths,
        claudeDir,
        join(HOME, ".claude.json"),
        "/tmp",
        "/private/tmp",
        ...(options.extraWritePaths ?? []),
      ],
      denyWrite: [],
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
export function createSrtRuntime(): SandboxRuntime {
  const srtBin = resolveSrtBin();
  const srtBinDir = srtBin === "srt" ? null : dirname(dirname(srtBin)); // package root
  let settingsPath = "";

  return {
    name: "srt",

    async prepare(options: SandboxRuntimeOptions): Promise<SandboxCleanup> {
      const settings = buildSrtSettings(options, srtBinDir);

      // Write settings file next to the worktree
      settingsPath = join(dirname(options.worktreePath), "srt-settings.json");
      await Bun.write(settingsPath, JSON.stringify(settings, null, 2));

      // srt manages its own proxy lifecycle — no host-side cleanup needed
      return () => {};
    },

    buildCommand(options: SandboxRuntimeOptions, innerCommand: string[]): string[] {
      const { worktreePath, env } = options;

      // Build env exports + cd + exec
      const envExports: string[] = [];

      if (env) {
        for (const [key, value] of Object.entries(env)) {
          envExports.push(`export ${key}=${shellq(value)}`);
        }
      }

      envExports.push(`export HOME=${shellq(HOME)}`);
      envExports.push("unset CLAUDECODE");

      if (process.env.PATH) {
        envExports.push(`export PATH=${shellq(process.env.PATH)}`);
      }
      envExports.push(`export TERM=${shellq(process.env.TERM ?? "xterm-256color")}`);

      const escapedInner = innerCommand.map(shellq).join(" ");

      const shellCmd = `${envExports.join("; ")}; cd ${shellq(worktreePath)} && exec ${escapedInner}`;

      return [
        srtBin, "-s", settingsPath,
        "-c", shellCmd,
      ];
    },
  };
}
