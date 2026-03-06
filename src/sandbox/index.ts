import type { SandboxRuntime, SandboxCleanup } from "./runtime";

export type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";
export { nonoRuntime } from "./nono";
export { createBwrapRuntime } from "./bwrap";

export interface SandboxSession {
  /** The tmux session name */
  sessionName: string;
  /** The worktree path (only writable dir in the sandbox) */
  worktreePath: string;
  /** Stop the sandbox and kill the tmux session */
  stop: () => Promise<void>;
}

export interface SandboxOptions {
  /** Unique session identifier (used as tmux session name) */
  sessionName: string;
  /** Path to the git worktree */
  worktreePath: string;
  /**
   * Path to the main repo's `.git/` directory.
   * Mounted read-only so git worktree operations work inside the sandbox.
   * @example "/home/user/project/.git"
   */
  repoGitDir?: string;
  /** Domain allowlist for the network proxy */
  allowlist: string[];
  /** Extra environment variables */
  env?: Record<string, string>;
  /** Additional paths to grant read-only access */
  extraReadPaths?: string[];
  /** Additional paths to grant read-write access */
  extraWritePaths?: string[];
  /** Command + args to run inside the sandbox (default: interactive shell) */
  command: string[];
  /** Sandbox runtime to use */
  runtime: SandboxRuntime;
}

/**
 * Launch a sandboxed process inside a tmux session.
 *
 * 1. Runs the runtime's prepare hook (if any)
 * 2. Builds the sandboxed command via the runtime
 * 3. Starts a tmux session running the command
 *
 * The caller gets back a handle to stop everything.
 */
export async function launchSandbox(options: SandboxOptions): Promise<SandboxSession> {
  const {
    sessionName,
    worktreePath,
    repoGitDir,
    allowlist,
    env = {},
    extraReadPaths,
    extraWritePaths,
    command,
    runtime,
  } = options;

  // Run runtime-specific pre-launch setup (e.g. start a proxy)
  const runtimeOpts = { worktreePath, repoGitDir, allowlist, extraReadPaths, extraWritePaths, env };
  const cleanup: SandboxCleanup = await runtime.prepare?.(runtimeOpts) ?? (() => {});

  // Build the full sandboxed command via the runtime
  const fullCommand = runtime.buildCommand(runtimeOpts, command);

  const escapedCmd = fullCommand
    .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
    .join(" ");

  // Build a minimal environment for the tmux session.
  // Only system essentials + explicitly passthrough'd vars reach the sandbox.
  // This prevents leaking host secrets (AWS keys, DB URLs, etc.) into the
  // sandboxed process via /proc/self/environ.
  const sandboxEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    TERM: process.env.TERM ?? "xterm-256color",
    // tmux needs TMUX/TMUX_PANE unset to create new sessions,
    // so we intentionally do NOT propagate them.
    ...env,
  };

  // Build env exports for the shell preamble
  const envExports = Object.entries(sandboxEnv)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
    .join("; ");

  const preamble = `${envExports}; unset CLAUDECODE; exec ${escapedCmd}`;

  // Create tmux session with a clean environment (env -i).
  // The preamble re-exports only the allowed vars.
  const createProc = Bun.spawn([
    "env", "-i",
    // tmux itself needs minimal env to function
    `PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    `HOME=${process.env.HOME ?? "/root"}`,
    `TERM=${process.env.TERM ?? "xterm-256color"}`,
    "tmux", "new-session", "-d", "-s", sessionName,
    "-x", "200", "-y", "50",
    "sh", "-c", preamble,
  ], { stdout: "pipe", stderr: "pipe" });
  const createCode = await createProc.exited;
  if (createCode !== 0) {
    const stderr = await new Response(createProc.stderr).text();
    throw new Error(`Failed to create tmux session: ${stderr.trim()}`);
  }

  // Configure the tmux session
  const tmuxSettings: [string, string][] = [
    // Keep pane alive after command exits so we can capture scrollback
    ["remain-on-exit", "on"],
    // Status bar with detach instructions
    ["status", "on"],
    ["status-position", "bottom"],
    ["status-style", "#{?client_prefix,bg=#4a4a6e fg=#ffffff,bg=#1a1a2e fg=#e0e0e0}"],
    ["status-left", ""],
    ["status-right", " 🦌 deer | Ctrl+b [ to scroll | Ctrl+b d to detach "],
    ["status-right-style", "#{?client_prefix,bg=#4a4a6e fg=#ffffff,bg=#1a1a2e fg=#888888}"],
    ["status-justify", "left"],
  ];
  for (const [key, value] of tmuxSettings) {
    await Bun.spawn([
      "tmux", "set", "-t", sessionName, key, value,
    ], { stdout: "pipe", stderr: "pipe" }).exited;
  }

  return {
    sessionName,
    worktreePath,
    async stop() {
      await Bun.spawn([
        "tmux", "kill-session", "-t", sessionName,
      ], { stdout: "pipe", stderr: "pipe" }).exited;
      cleanup();
    },
  };
}

/**
 * Check if a tmux session's pane command has exited.
 */
export async function isTmuxSessionDead(sessionName: string): Promise<boolean> {
  const proc = Bun.spawn([
    "tmux", "list-panes", "-t", sessionName, "-F", "#{pane_dead}",
  ], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) return true;
  const result = (await new Response(proc.stdout).text()).trim();
  return result === "1";
}

/**
 * Capture tmux pane content.
 * @param fullScrollback - If true, captures the entire scrollback buffer
 */
export async function captureTmuxPane(
  sessionName: string,
  fullScrollback = false,
): Promise<string[] | null> {
  const args = ["tmux", "capture-pane", "-t", sessionName, "-p"];
  if (fullScrollback) args.push("-S", "-");

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) return null;
  const text = await new Response(proc.stdout).text();
  return text.split("\n");
}
