import type { AgentStatus } from "./state-machine";
import type { AgentState } from "./agent-state";
import { MAX_LOG_LINES } from "./constants";

// ── Constants ────────────────────────────────────────────────────────

export const STATUS_DISPLAY: Record<AgentStatus, { icon: string; color: string }> = {
  setup:       { icon: "\u23F3", color: "yellow" },
  running:     { icon: "\u25CF",  color: "cyan" },
  teardown:    { icon: "\u2B06",  color: "blue" },
  failed:      { icon: "\u2717",  color: "red" },
  cancelled:   { icon: "\u2298",  color: "gray" },
  interrupted: { icon: "!",  color: "yellow" },
  pr_failed:   { icon: "\u2717",  color: "red" },
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

export function formatCost(cost: number): string {
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/**
 * Scan tmux pane lines for a Claude Code cost output like "Cost: $0.0234".
 * Returns the last dollar amount found in a cost-bearing line, or null.
 */
export function parseCostFromPane(lines: string[]): number | null {
  let lastCost: number | null = null;
  for (const line of lines) {
    const cleaned = stripAnsi(line).trim();
    // Prefer lines explicitly mentioning cost
    if (/cost/i.test(cleaned)) {
      const match = cleaned.match(/\$(\d+\.\d+)/);
      if (match) {
        const val = parseFloat(match[1]);
        if (!isNaN(val)) lastCost = val;
      }
    }
  }
  return lastCost;
}

export function appendLog(agent: AgentState, line: string, verbose = false) {
  agent.logs.push({ text: line, verbose });
  if (agent.logs.length > MAX_LOG_LINES) {
    agent.logs.splice(0, agent.logs.length - MAX_LOG_LINES);
  }
}

export function isActive(a: AgentState): boolean {
  return a.status === "setup" || a.status === "running" || a.status === "teardown";
}

/** Strip ANSI escape sequences from terminal output */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          // eslint-disable-next-line no-control-regex
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
    // Drain any keystrokes buffered while the child process had stdin
    // (e.g. ctrl+c typed inside tmux), so they don't reach Ink's handlers.
    let chunk: Buffer | string | null;
    while ((chunk = process.stdin.read()) !== null) { /* discard */ }
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
