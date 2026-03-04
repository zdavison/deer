import { test, expect, describe } from "bun:test";
import { parseNdjsonLine, type AgentState } from "../src/dashboard";

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    taskId: "deer_test",
    prompt: "test",
    status: "running",
    elapsed: 0,
    lastActivity: "",
    currentTool: "",
    logs: [],
    meta: null,
    result: null,
    error: "",
    proc: null,
    timer: null,
    prState: null,
    userAttached: false,
    needsAttention: false,
    sessionId: null,
    tmuxWatched: false,
    transcript: [],
    transcriptPath: null,
    historical: false,
    ...overrides,
  };
}

// ── session_id capture ──────────────────────────────────────────────

describe("parseNdjsonLine - session_id capture", () => {
  test("captures session_id from the first event", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "system",
      message: "Claude started",
      session_id: "abc-123-def",
    });

    parseNdjsonLine(line, agent);
    expect(agent.sessionId).toBe("abc-123-def");
  });

  test("captures session_id from assistant event", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "assistant",
      session_id: "sess-456",
      message: {
        content: [{ type: "text", text: "Hello" }],
      },
    });

    parseNdjsonLine(line, agent);
    expect(agent.sessionId).toBe("sess-456");
  });

  test("does not overwrite session_id once captured", () => {
    const agent = makeAgent({ sessionId: "first-session" });
    const line = JSON.stringify({
      type: "system",
      message: "Another event",
      session_id: "second-session",
    });

    parseNdjsonLine(line, agent);
    expect(agent.sessionId).toBe("first-session");
  });

  test("handles events without session_id", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "system",
      message: "No session id here",
    });

    parseNdjsonLine(line, agent);
    expect(agent.sessionId).toBeNull();
  });
});

// ── existing parsing behavior ───────────────────────────────────────

describe("parseNdjsonLine - event parsing", () => {
  test("returns false for empty lines", () => {
    const agent = makeAgent();
    expect(parseNdjsonLine("", agent)).toBe(false);
    expect(parseNdjsonLine("   ", agent)).toBe(false);
  });

  test("parses assistant text content", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Working on it" }],
      },
    });

    const changed = parseNdjsonLine(line, agent);
    expect(changed).toBe(true);
    expect(agent.lastActivity).toContain("Working on it");
    expect(agent.transcript).toContain("Working on it");
  });

  test("parses tool_use blocks", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/tmp/test.ts" },
        }],
      },
    });

    const changed = parseNdjsonLine(line, agent);
    expect(changed).toBe(true);
    expect(agent.currentTool).toContain("Read");
  });

  test("sets needsAttention for AskUserQuestion tool", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "AskUserQuestion",
          input: { question: "Which approach?" },
        }],
      },
    });

    parseNdjsonLine(line, agent);
    expect(agent.needsAttention).toBe(true);
  });

  test("parses content_block_delta", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "streaming chunk" },
    });

    const changed = parseNdjsonLine(line, agent);
    expect(changed).toBe(true);
    expect(agent.lastActivity).toContain("streaming chunk");
  });

  test("handles invalid JSON gracefully", () => {
    const agent = makeAgent();
    const changed = parseNdjsonLine("not valid json {{{", agent);
    expect(changed).toBe(true); // treated as plain text log
    expect(agent.logs.length).toBeGreaterThan(0);
  });
});
