import type { SandboxRuntime, SandboxCleanup } from "./runtime";
import { HOME } from "../constants";

export type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";
export { createSrtRuntime } from "./srt";

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
  /**
   * MITM proxy configuration for credential injection.
   * When set, SRT routes matching domains through this Unix socket proxy.
   */
  mitmProxy?: { socketPath: string; domains: string[] };
}

/**
 * Apply the deer status bar and mouse settings to a tmux session.
 * @param remainOnExit - Keep pane alive after command exits (for agent sessions)
 */
export async function applyTmuxStatusBar(
  sessionName: string,
  { remainOnExit = false }: { remainOnExit?: boolean } = {},
): Promise<void> {
  const settings: [string, string][] = [
    // Keep pane alive after command exits so we can capture scrollback
    ["remain-on-exit", "on"],
    // Enable mouse scroll wheel support (enters copy mode automatically)
    ["mouse", "on"],
    // Status bar with detach instructions
    ["status", "on"],
    ["status-position", "bottom"],
    ["status-style", "#{?client_prefix,bg=#4a4a6e fg=#ffffff,bg=#1a1a2e fg=#e0e0e0}"],
    ["status-left", ""],
    ["status-right", " 🦌 deer | Ctrl+b d to detach "],
    ["status-right-style", "#{?client_prefix,bg=#4a4a6e fg=#ffffff,bg=#1a1a2e fg=#888888}"],
    ["status-justify", "left"],
  ];
  if (remainOnExit) {
    // Keep pane alive after command exits so we can capture scrollback
    settings.unshift(["remain-on-exit", "on"]);
  }
  for (const [key, value] of settings) {
    await Bun.spawn([
      "tmux", "set", "-t", sessionName, key, value,
    ], { stdout: "pipe", stderr: "pipe" }).exited;
  }
}

/**
 * Build a minimal environment for the tmux session.
 * Only system essentials + explicitly passthrough'd vars reach the sandbox.
 * This prevents leaking host secrets (AWS keys, DB URLs, etc.) into the
 * sandboxed process via /proc/self/environ.
 */
function buildSandboxEnvironment(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: HOME,
    TERM: process.env.TERM ?? "xterm-256color",
    // tmux needs TMUX/TMUX_PANE unset to create new sessions,
    // so we intentionally do NOT propagate them.
    ...extra,
  };
}

/** Shell-escape an argument for use inside single quotes. */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the shell preamble that sets environment vars, disables flow control,
 * and exec's the sandboxed command.
 */
function buildShellPreamble(env: Record<string, string>, command: string[]): string {
  const envExports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
    .join("; ");
  const escapedCmd = command.map(shellEscape).join(" ");

  // Disable XON/XOFF flow control so attaching a terminal client cannot stall Claude's output.
  return `${envExports}; unset CLAUDECODE; stty -ixon 2>/dev/null || true; exec ${escapedCmd}`;
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
    mitmProxy,
  } = options;

  // Run runtime-specific pre-launch setup (e.g. start a proxy)
  const runtimeOpts = { worktreePath, repoGitDir, allowlist, extraReadPaths, extraWritePaths, env, mitmProxy };
  const cleanup: SandboxCleanup = await runtime.prepare?.(runtimeOpts) ?? (() => {});

  // Build the full sandboxed command via the runtime
  const fullCommand = runtime.buildCommand(runtimeOpts, command);

  const sandboxEnv = buildSandboxEnvironment(env);
  const preamble = buildShellPreamble(sandboxEnv, fullCommand);

  // Create tmux session with a clean environment (env -i).
  // The preamble re-exports only the allowed vars.
  const createProc = Bun.spawn([
    "env", "-i",
    // tmux itself needs minimal env to function
    `PATH=${sandboxEnv.PATH}`,
    `HOME=${sandboxEnv.HOME}`,
    `TERM=${sandboxEnv.TERM}`,
    "tmux", "new-session", "-d", "-s", sessionName,
    "-x", String(process.stdout.columns || 220), "-y", String(process.stdout.rows || 50),
    "sh", "-c", preamble,
  ], { stdout: "pipe", stderr: "pipe" });
  const createCode = await createProc.exited;
  if (createCode !== 0) {
    const stderr = await new Response(createProc.stderr).text();
    throw new Error(`Failed to create tmux session: ${stderr.trim()}`);
  }

  // Configure the tmux session
  await applyTmuxStatusBar(sessionName, { remainOnExit: true });

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
