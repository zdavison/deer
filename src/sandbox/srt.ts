import { join, dirname } from "node:path";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";
import { HOME } from "../constants";

/**
 * Resolve the srt binary path from the installed @anthropic-ai/sandbox-runtime package.
 *
 * Search order:
 * 1. Local node_modules (dev / bun run dev)
 * 2. deer data dir (~/.local/share/deer/node_modules) — installed by `bunx @zdavison/deer install`
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
 * Build an SRT settings JSON object from deer's sandbox options.
 */
function buildSrtSettings(options: SandboxRuntimeOptions, srtBinDir: string | null): Record<string, unknown> {
  const claudeDir = join(HOME, ".claude");

  const network: Record<string, unknown> = {
    allowedDomains: options.allowlist,
    deniedDomains: [],
  };

  if (options.mitmProxy) {
    network.mitmProxy = {
      socketPath: options.mitmProxy.socketPath,
      domains: options.mitmProxy.domains,
    };
    // The Unix socket must be accessible from inside the sandbox
    network.allowUnixSockets = [dirname(options.mitmProxy.socketPath)];
  }

  // Collect paths that must stay readable: worktree, repo .git dir,
  // PATH entries under HOME, and the deer data dir (worktree parent).
  const requiredPaths = [
    options.worktreePath,
    dirname(options.worktreePath),
    ...(options.repoGitDir ? [options.repoGitDir] : []),
    ...(process.env.PATH?.split(":").filter((p) => p.startsWith(HOME)) ?? []),
    ...(srtBinDir ? [srtBinDir] : []),
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
        claudeDir,
        join(HOME, ".claude.json"),
        "/tmp",
        "/private/tmp",
        ...(options.extraWritePaths ?? []),
      ],
      denyWrite: [],
    },
    // Claude Code runs interactively in tmux and needs setRawMode (tcsetattr)
    // on PTY devices for its terminal UI.
    allowPty: true,
  };
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
          envExports.push(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
        }
      }

      envExports.push(`export HOME='${HOME.replace(/'/g, "'\\''")}'`);
      envExports.push("unset CLAUDECODE");

      if (process.env.PATH) {
        envExports.push(`export PATH='${process.env.PATH.replace(/'/g, "'\\''")}'`);
      }
      envExports.push(`export TERM='${(process.env.TERM ?? "xterm-256color").replace(/'/g, "'\\''")}'`);

      const escapedInner = innerCommand
        .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(" ");

      const shellCmd = `${envExports.join("; ")}; cd '${worktreePath.replace(/'/g, "'\\''")}' && exec ${escapedInner}`;

      return [
        srtBin, "-s", settingsPath,
        "-c", shellCmd,
      ];
    },
  };
}
