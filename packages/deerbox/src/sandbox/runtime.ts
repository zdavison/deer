/**
 * Abstract sandbox runtime interface.
 *
 * The SRT runtime implements this to produce the command prefix that wraps
 * the inner command with sandbox capabilities.
 */

export interface SandboxRuntimeOptions {
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
  /** Extra environment variables to inject into the sandbox */
  env?: Record<string, string>;
  /**
   * Environment variable names to exclude from the sandbox.
   * Removed from the host-env spread before the explicit `env` overlay is applied,
   * so proxy-managed placeholders (e.g. ANTHROPIC_API_KEY=proxy-managed) are unaffected.
   */
  envBlocklist?: string[];
  /**
   * MITM proxy configuration for credential injection.
   * When set, SRT routes matching domains through this Unix socket proxy
   * which injects auth headers before forwarding to the real upstream.
   */
  mitmProxy?: {
    socketPath: string;
    domains: string[];
  };
  /**
   * Path to the per-task Claude config directory to use as CLAUDE_CONFIG_DIR.
   * If omitted, srt.ts falls back to `<dirname(worktreePath)>/claude-config`.
   * Always set this explicitly from session.ts to handle reuseWorktree correctly.
   * @example "/home/user/.local/share/deer/tasks/deer_abc123/claude-config"
   */
  claudeConfigDir?: string;
}

/** Cleanup function returned by prepare() to tear down runtime resources */
export type SandboxCleanup = () => void;

export interface SandboxRuntime {
  /** Human-readable name for logging/diagnostics */
  readonly name: string;

  /**
   * Build the full command array to launch a sandboxed process.
   *
   * The runtime wraps `innerCommand` with whatever sandbox mechanism it uses.
   * The returned array is the complete command to execute (sandbox wrapper + inner command).
   *
   * @param options - Sandbox capability options (paths, network, etc.)
   * @param innerCommand - The command + args to run inside the sandbox
   * @returns Full command array ready to exec
   */
  buildCommand(options: SandboxRuntimeOptions, innerCommand: string[]): string[];

  /**
   * Optional pre-launch hook for setup that must happen before the sandbox starts.
   * Returns a cleanup function that is called when the sandbox session is stopped.
   */
  prepare?(options: SandboxRuntimeOptions): Promise<SandboxCleanup>;

  /**
   * Restore runtime resources for a task that is already running (e.g. after
   * a deer restart). Returns a cleanup function, or null if restoration is not
   * applicable.
   *
   * @param worktreePath - Path to the task's git worktree
   * @param allowlist - Hosts to allow through the network proxy
   */
  restoreProxy?(worktreePath: string, allowlist: string[]): Promise<SandboxCleanup | null>;
}
