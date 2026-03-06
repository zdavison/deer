import type { AgentStatus } from "./state-machine";
import type { AgentState } from "./agent-state";
import {
  MAX_LOG_LINES,
  DASHBOARD_POLL_MS,
  IDLE_THRESHOLD,
  DEFAULT_MODEL,
  PR_MERGE_CHECK_INTERVAL_MS,
  MAX_VISIBLE_LOGS,
  LOG_LINES_PER_ENTRY,
  ENTRY_ROWS_BASE,
  ENTRY_ROWS_WITH_PR,
  UPLOAD_FRAMES,
} from "./constants";

// ── Re-exports from constants ───────────────────────────────────────
// Kept for backwards compatibility with existing imports in dashboard.tsx etc.

export {
  MAX_LOG_LINES,
  MAX_VISIBLE_LOGS,
  LOG_LINES_PER_ENTRY,
  ENTRY_ROWS_BASE,
  ENTRY_ROWS_WITH_PR,
  UPLOAD_FRAMES,
  PR_MERGE_CHECK_INTERVAL_MS,
  IDLE_THRESHOLD,
  DEFAULT_MODEL,
};

export const MODEL = DEFAULT_MODEL;
export const POLL_MS = DASHBOARD_POLL_MS;

// ── Constants ────────────────────────────────────────────────────────

export const STATUS_DISPLAY: Record<AgentStatus, { icon: string; color: string }> = {
  setup:       { icon: "\u23F3", color: "yellow" },
  running:     { icon: "\u25CF",  color: "cyan" },
  teardown:    { icon: "\u2B06",  color: "blue" },
  failed:      { icon: "\u2717",  color: "red" },
  cancelled:   { icon: "\u2298",  color: "gray" },
  interrupted: { icon: "!",  color: "yellow" },
};

// ── Helpers ──────────────────────────────────────────────────────────

export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
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

/**
 * Normalize pane lines into a single snapshot string for comparison.
 * Strips ANSI codes, trims whitespace, and drops empty lines.
 */
export function captureSnapshot(lines: string[]): string {
  return lines.map(stripAnsi).map((l) => l.trim()).filter(Boolean).join("\n");
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
