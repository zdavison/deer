import type { AgentState as AgentStatus } from "./state-machine";
import type { AgentState } from "./agent-state";

// ── Constants ────────────────────────────────────────────────────────

export const STATUS_DISPLAY: Record<AgentStatus, { icon: string; color: string }> = {
  setup:       { icon: "⏳", color: "yellow" },
  running:     { icon: "●",  color: "cyan" },
  teardown:    { icon: "⬆",  color: "blue" },
  completed:   { icon: "✓",  color: "green" },
  failed:      { icon: "✗",  color: "red" },
  cancelled:   { icon: "⊘",  color: "gray" },
  interrupted: { icon: "!",  color: "yellow" },
};

export const UPLOAD_FRAMES = ["⬆", "⇧"];

export const MAX_LOG_LINES = 200;
export const MAX_VISIBLE_LOGS = 5;
export const LOG_LINES_PER_ENTRY = 2;
export const ENTRY_ROWS_BASE = 1 + LOG_LINES_PER_ENTRY;
export const ENTRY_ROWS_WITH_PR = ENTRY_ROWS_BASE + 1;
export const MODEL = "sonnet";
export const PR_MERGE_CHECK_INTERVAL_MS = 10_000;
export const POLL_MS = 1_000;
/** Number of consecutive unchanged pane captures before considering Claude idle */
export const IDLE_THRESHOLD = 3;

// ── Helpers ──────────────────────────────────────────────────────────

export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function appendLog(agent: AgentState, line: string) {
  agent.logs.push(line);
  if (agent.logs.length > MAX_LOG_LINES) {
    agent.logs.splice(0, agent.logs.length - MAX_LOG_LINES);
  }
}

export function isActive(a: AgentState): boolean {
  return a.status === "setup" || a.status === "running" || a.status === "teardown";
}

/** Strip ANSI escape sequences from terminal output */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** Suspend the ink alternate screen, run fn, then restore. */
export async function withSuspendedTerminal(
  setSuspended: (v: boolean) => void,
  fn: () => Promise<void>,
): Promise<void> {
  setSuspended(true);
  // Leave Ink's alternate screen
  process.stdout.write("\x1b[?1049l");
  // Fully release stdin so the child process gets exclusive access
  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  process.stdin.pause();
  try {
    await fn();
  } finally {
    process.stdin.resume();
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    setSuspended(false);
  }
}

export function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawn([cmd, url], { stdout: "pipe", stderr: "pipe" });
}

export function prStateColor(state: "open" | "merged" | "closed" | null): string {
  if (state === "merged") return "magenta";
  if (state === "closed") return "red";
  return "green";
}
