import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";
import { HOME } from "../constants";

/**
 * Resolve the srt binary path from the installed @anthropic-ai/sandbox-runtime package.
 * Falls back to bare "srt" (assumes it's in PATH, e.g. globally installed).
 */
function resolveSrtBin(): string {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@anthropic-ai/sandbox-runtime/dist/cli.js");
  } catch {
    return "srt";
  }
}

/**
 * Build an SRT settings JSON object from deer's sandbox options.
 */
function buildSrtSettings(options: SandboxRuntimeOptions): Record<string, unknown> {
  const claudeDir = join(HOME, ".claude");

  return {
    network: {
      allowedDomains: options.allowlist,
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [
        join(HOME, ".ssh"),
        join(HOME, ".aws"),
        join(HOME, ".azure"),
        join(HOME, ".config/gcloud"),
        join(HOME, ".docker/config.json"),
        join(HOME, ".kube/config"),
        join(HOME, ".npmrc"),
        join(HOME, ".pypirc"),
        join(HOME, ".git-credentials"),
      ],
      allowWrite: [
        options.worktreePath,
        claudeDir,
        join(HOME, ".claude.json"),
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
  let settingsPath = "";

  return {
    name: "srt",

    async prepare(options: SandboxRuntimeOptions): Promise<SandboxCleanup> {
      const settings = buildSrtSettings(options);

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
