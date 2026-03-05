import { startProxy, type ProxyHandle } from "./proxy";
import { buildBwrapArgs, type BwrapOptions } from "./bwrap";

export { startProxy, type ProxyHandle } from "./proxy";
export { buildBwrapArgs, type BwrapOptions } from "./bwrap";
export { matchesAllowlist } from "./proxy";

export interface SandboxSession {
  /** The tmux session name */
  sessionName: string;
  /** The worktree path (only writable dir in the sandbox) */
  worktreePath: string;
  /** The proxy handle (for cleanup) */
  proxy: ProxyHandle;
  /** Stop the proxy and kill the tmux session */
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
  /** Extra read-only bind mounts */
  extraRoBinds?: string[];
  /** Extra read-write bind mounts (overlays ro-binds for the same paths) */
  extraRwBinds?: string[];
  /** Command + args to run inside the sandbox (default: interactive shell) */
  command: string[];
}

/**
 * Launch a sandboxed process inside a tmux session.
 *
 * 1. Starts the filtering CONNECT proxy
 * 2. Builds the bwrap command with the worktree as the only writable mount
 * 3. Starts a tmux session running the bwrap'd command
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
    extraRoBinds,
    extraRwBinds,
    command,
  } = options;

  // Start the proxy
  const proxy = await startProxy({ allowlist });

  // Build the bwrap command
  const bwrapArgs = buildBwrapArgs({
    worktreePath,
    repoGitDir,
    proxyPort: proxy.port,
    env,
    extraRoBinds,
    extraRwBinds,
  });

  // The full command: bwrap [...] <command>
  const fullCommand = [...bwrapArgs, ...command];

  // Build a shell command string for tmux's initial command.
  // This runs bwrap directly as the session process — when it exits,
  // the tmux pane dies (with remain-on-exit keeping scrollback available).
  const shellCmd = fullCommand
    .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
    .join(" ");

  // Create tmux session with the bwrap command as the initial program.
  // remain-on-exit is set via environment so the session config takes
  // effect before the command runs.
  const createProc = Bun.spawn([
    "tmux", "new-session", "-d", "-s", sessionName,
    "-x", "200", "-y", "50",
    "sh", "-c", shellCmd,
  ], { stdout: "pipe", stderr: "pipe" });
  const createCode = await createProc.exited;
  if (createCode !== 0) {
    proxy.stop();
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
    ["status-style", "bg=#1a1a2e,fg=#e0e0e0"],
    ["status-left", ""],
    ["status-right", " 🦌 deer | Ctrl+b [ to scroll | Ctrl+b d to detach "],
    ["status-right-style", "bg=#1a1a2e,fg=#888888"],
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
    proxy,
    async stop() {
      proxy.stop();
      await Bun.spawn([
        "tmux", "kill-session", "-t", sessionName,
      ], { stdout: "pipe", stderr: "pipe" }).exited;
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
