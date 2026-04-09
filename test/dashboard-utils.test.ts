import { test, expect, describe } from "bun:test";
import {
  truncate,
  formatTime,
  appendLog,
  captureSnapshot,
  isActive,
} from "../src/dashboard-utils";
import { createAgentState } from "../src/agent-state";
import { MAX_LOG_LINES } from "../src/constants";

// ── truncate ─────────────────────────────────────────────────────────

describe("truncate", () => {
  test("returns string unchanged when shorter than max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("returns string unchanged when exactly at max", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  test("truncates and appends ellipsis when over max", () => {
    expect(truncate("abcdef", 5)).toBe("abcd\u2026");
  });

  test("truncated result has length equal to max", () => {
    const result = truncate("hello world", 7);
    expect(result.length).toBe(7);
    expect(result.endsWith("\u2026")).toBe(true);
  });

  test("returns empty string for max <= 0", () => {
    expect(truncate("anything", 0)).toBe("");
    expect(truncate("anything", -1)).toBe("");
  });

  test("returns empty string unchanged", () => {
    expect(truncate("", 10)).toBe("");
  });

  test("truncates to single ellipsis char when max is 1", () => {
    expect(truncate("ab", 1)).toBe("\u2026");
  });
});

// ── formatTime ───────────────────────────────────────────────────────

describe("formatTime", () => {
  test("formats zero seconds", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  test("formats seconds below one minute", () => {
    expect(formatTime(59)).toBe("0:59");
  });

  test("formats exactly one minute", () => {
    expect(formatTime(60)).toBe("1:00");
  });

  test("pads single-digit seconds with zero", () => {
    expect(formatTime(65)).toBe("1:05");
  });

  test("formats large values (hours expressed as minutes)", () => {
    expect(formatTime(3661)).toBe("61:01");
  });

  test("formats one hour as 60 minutes", () => {
    expect(formatTime(3600)).toBe("60:00");
  });
});

// ── appendLog ────────────────────────────────────────────────────────

describe("appendLog", () => {
  test("appends a log entry to an empty log list", () => {
    const agent = createAgentState({ taskId: "deer_test" });
    appendLog(agent, "hello");
    expect(agent.logs).toHaveLength(1);
    expect(agent.logs[0].text).toBe("hello");
    expect(agent.logs[0].verbose).toBe(false);
  });

  test("defaults verbose to false", () => {
    const agent = createAgentState({ taskId: "deer_test" });
    appendLog(agent, "msg");
    expect(agent.logs[0].verbose).toBe(false);
  });

  test("sets verbose to true when passed", () => {
    const agent = createAgentState({ taskId: "deer_test" });
    appendLog(agent, "verbose msg", true);
    expect(agent.logs[0].verbose).toBe(true);
  });

  test("appends multiple entries in order", () => {
    const agent = createAgentState({ taskId: "deer_test" });
    appendLog(agent, "first");
    appendLog(agent, "second");
    appendLog(agent, "third");
    expect(agent.logs.map(e => e.text)).toEqual(["first", "second", "third"]);
  });

  test("caps at MAX_LOG_LINES — oldest entry is dropped", () => {
    const agent = createAgentState({ taskId: "deer_test" });

    // Fill to capacity
    for (let i = 0; i < MAX_LOG_LINES; i++) {
      appendLog(agent, `entry-${i}`);
    }
    expect(agent.logs).toHaveLength(MAX_LOG_LINES);
    expect(agent.logs[0].text).toBe("entry-0");

    // One more entry should drop the oldest
    appendLog(agent, "overflow");
    expect(agent.logs).toHaveLength(MAX_LOG_LINES);
    expect(agent.logs[0].text).toBe("entry-1");
    expect(agent.logs[MAX_LOG_LINES - 1].text).toBe("overflow");
  });

  test("never exceeds MAX_LOG_LINES even after many appends", () => {
    const agent = createAgentState({ taskId: "deer_test" });
    for (let i = 0; i < MAX_LOG_LINES * 3; i++) {
      appendLog(agent, `entry-${i}`);
    }
    expect(agent.logs.length).toBeLessThanOrEqual(MAX_LOG_LINES);
  });
});

// ── captureSnapshot ───────────────────────────────────────────────────

describe("captureSnapshot", () => {
  test("returns empty string for empty array", () => {
    expect(captureSnapshot([])).toBe("");
  });

  test("strips ANSI escape codes", () => {
    expect(captureSnapshot(["\x1b[32mgreen text\x1b[0m"])).toBe("green text");
  });

  test("trims leading and trailing whitespace from each line", () => {
    expect(captureSnapshot(["  hello  ", "  world  "])).toBe("hello\nworld");
  });

  test("filters out lines that are empty after stripping and trimming", () => {
    expect(captureSnapshot(["line1", "", "   ", "line2"])).toBe("line1\nline2");
  });

  test("filters lines that are only ANSI codes", () => {
    expect(captureSnapshot(["\x1b[0m", "real content", "\x1b[2J"])).toBe("real content");
  });

  test("joins non-empty lines with newline", () => {
    expect(captureSnapshot(["a", "b", "c"])).toBe("a\nb\nc");
  });

  test("two identical inputs produce the same snapshot", () => {
    const lines = ["\x1b[1mfoo\x1b[0m", "  bar  ", "", "baz"];
    expect(captureSnapshot(lines)).toBe(captureSnapshot(lines));
  });

  test("different content produces different snapshots", () => {
    const a = captureSnapshot(["hello"]);
    const b = captureSnapshot(["world"]);
    expect(a).not.toBe(b);
  });
});

// ── isActive ─────────────────────────────────────────────────────────

describe("isActive", () => {
  test("setup is active", () => {
    expect(isActive(createAgentState({ status: "setup" }))).toBe(true);
  });

  test("running is active", () => {
    expect(isActive(createAgentState({ status: "running" }))).toBe(true);
  });

  test("teardown is active", () => {
    expect(isActive(createAgentState({ status: "teardown" }))).toBe(true);
  });

  test("failed is not active", () => {
    expect(isActive(createAgentState({ status: "failed" }))).toBe(false);
  });

  test("cancelled is not active", () => {
    expect(isActive(createAgentState({ status: "cancelled" }))).toBe(false);
  });

  test("interrupted is not active", () => {
    expect(isActive(createAgentState({ status: "interrupted" }))).toBe(false);
  });
});
