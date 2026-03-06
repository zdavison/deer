/**
 * Abstract sandbox runtime interface.
 *
 * Each runtime (nono, bwrap, none) implements this to produce the
 * command prefix that wraps the inner command with sandbox capabilities.
 * The tmux session management in index.ts is runtime-agnostic.
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
   *
   * Use cases:
   * - Starting a CONNECT proxy (bwrap) — cleanup stops the proxy
   * - Pre-creating files for Landlock (nono) — cleanup is a no-op
   */
  prepare?(options: SandboxRuntimeOptions): Promise<SandboxCleanup>;

  /**
   * Restore runtime resources for a task that is already running (e.g. after
   * a deer restart). Returns a cleanup function, or null if restoration is not
   * applicable (no port file, wrong runtime, etc.).
   *
   * @param worktreePath - Path to the task's git worktree
   * @param allowlist - Hosts to allow through the network proxy
   */
  restoreProxy?(worktreePath: string, allowlist: string[]): Promise<SandboxCleanup | null>;
}
