/**
 * Tmux session management for deer's agent lifecycle.
 *
 * Launches pre-built sandboxed commands in tmux sessions, manages
 * session lifecycle, and captures pane output for the TUI.
 */

import { HOME } from "../constants";

export interface SandboxSession {
  /** The tmux session name */
  sessionName: string;
  /** The worktree path */
  worktreePath: string;
  /** Stop the sandbox and kill the tmux session */
  stop: () => Promise<void>;
}

export interface LaunchOptions {
  /** Unique tmux session name */
  sessionName: string;
  /** Path to the git worktree */
  worktreePath: string;
  /** Pre-built command array to run in tmux (already SRT-wrapped by deerbox) */
  command: string[];
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
    ["mouse", "on"],
    ["status", "on"],
    ["status-position", "bottom"],
    ["status-style", "#{?client_prefix,bg=#4a4a6e fg=#ffffff,bg=#1a1a2e fg=#e0e0e0}"],
    ["status-left", ""],
    ["status-right", " 🦌 deer | Ctrl+b d to detach "],
    ["status-right-style", "#{?client_prefix,bg=#4a4a6e fg=#ffffff,bg=#1a1a2e fg=#888888}"],
    ["status-justify", "left"],
  ];
  if (remainOnExit) {
    settings.unshift(["remain-on-exit", "on"]);
  }
  for (const [key, value] of settings) {
    await Bun.spawn([
      "tmux", "set", "-t", sessionName, key, value,
    ], { stdout: "pipe", stderr: "pipe" }).exited;
  }
}

/** Shell-escape an argument for use inside single quotes. */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Launch a pre-built sandboxed command inside a tmux session.
 */
export async function launchSandbox(options: LaunchOptions): Promise<SandboxSession> {
  const { sessionName, worktreePath, command } = options;

  const escapedCmd = command.map(shellEscape).join(" ");
  const preamble = `stty -ixon 2>/dev/null || true; exec ${escapedCmd}`;

  const createProc = Bun.spawn([
    "env", "-i",
    `PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    `HOME=${HOME}`,
    `TERM=${process.env.TERM ?? "xterm-256color"}`,
    "tmux", "new-session", "-d", "-s", sessionName,
    "-x", String(process.stdout.columns || 220), "-y", String(process.stdout.rows || 50),
    "sh", "-c", preamble,
  ], { stdout: "pipe", stderr: "pipe" });
  const createCode = await createProc.exited;
  if (createCode !== 0) {
    const stderr = await new Response(createProc.stderr).text();
    throw new Error(`Failed to create tmux session: ${stderr.trim()}`);
  }

  await applyTmuxStatusBar(sessionName, { remainOnExit: true });

  return {
    sessionName,
    worktreePath,
    async stop() {
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
