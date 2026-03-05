import { Box, Text, useInput, useApp, useStdout } from "ink";
import { Spinner } from "@inkjs/ui";
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { loadHistory, upsertHistory, removeFromHistory } from "./task";
import type { PersistedTask } from "./task";
import { loadConfig } from "./config";
import type { DeerConfig } from "./config";
import { transition, availableActions, resolveKeypress, ACTION_BINDINGS } from "./state-machine";
import type { AgentState as AgentStatus } from "./state-machine";
import { startAgent, destroyAgent, createAgentPR } from "./agent";
import { isTmuxSessionDead, captureTmuxPane } from "./sandbox/index";
import { detectRepo } from "./git/worktree";
import { AgentState, createAgentState, historicalAgent, crossInstanceAgent } from "./agent-state";

// ── Constants ────────────────────────────────────────────────────────

const STATUS_DISPLAY: Record<AgentStatus, { icon: string; color: string }> = {
  setup:       { icon: "⏳", color: "yellow" },
  running:     { icon: "●",  color: "cyan" },
  teardown:    { icon: "⬆",  color: "blue" },
  completed:   { icon: "✓",  color: "green" },
  failed:      { icon: "✗",  color: "red" },
  cancelled:   { icon: "⊘",  color: "gray" },
  interrupted: { icon: "!",  color: "yellow" },
};

const UPLOAD_FRAMES = ["⬆", "⇧"];

const MAX_LOG_LINES = 200;
const MAX_VISIBLE_LOGS = 5;
const LOG_LINES_PER_ENTRY = 2;
const ENTRY_ROWS_BASE = 1 + LOG_LINES_PER_ENTRY;
const ENTRY_ROWS_WITH_PR = ENTRY_ROWS_BASE + 1;
const MODEL = "sonnet";
const PR_MERGE_CHECK_INTERVAL_MS = 60_000;
const POLL_MS = 1_000;
/** Number of consecutive unchanged pane captures before considering Claude idle */
const IDLE_THRESHOLD = 3;

// ── Helpers ──────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function appendLog(agent: AgentState, line: string) {
  agent.logs.push(line);
  if (agent.logs.length > MAX_LOG_LINES) {
    agent.logs.splice(0, agent.logs.length - MAX_LOG_LINES);
  }
}

function isActive(a: AgentState): boolean {
  return a.status === "setup" || a.status === "running" || a.status === "teardown";
}

/** Strip ANSI escape sequences from terminal output */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** Suspend the ink alternate screen, run fn, then restore. */
async function withSuspendedTerminal(
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

function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawn([cmd, url], { stdout: "pipe", stderr: "pipe" });
}

function prStateColor(state: "open" | "merged" | "closed" | null): string {
  if (state === "merged") return "magenta";
  if (state === "closed") return "red";
  return "green";
}

// ── Preflight ────────────────────────────────────────────────────────

interface PreflightResult {
  ok: boolean;
  errors: string[];
}

async function runPreflight(): Promise<PreflightResult> {
  const errors: string[] = [];

  // Check bwrap
  try {
    const p = Bun.spawn(["bwrap", "--version"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("bubblewrap (bwrap) not available — install it with your package manager");
  } catch {
    errors.push("bubblewrap (bwrap) not available — install it with your package manager");
  }

  // Check tmux
  try {
    const p = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("tmux not available");
  } catch {
    errors.push("tmux not available");
  }

  // Check claude
  try {
    const p = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("claude CLI not available");
  } catch {
    errors.push("claude CLI not available");
  }

  // Check gh auth
  try {
    const p = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("gh auth not configured — run 'gh auth login'");
  } catch {
    errors.push("gh CLI not available");
  }

  // Check OAuth token
  const tokenFile = `${process.env.HOME ?? ""}/.claude/agent-oauth-token`;
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      const f = Bun.file(tokenFile);
      if (await f.exists()) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = (await f.text()).trim();
      }
    } catch { /* ignore */ }
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    errors.push("No OAuth token — set CLAUDE_CODE_OAUTH_TOKEN or create ~/.claude/agent-oauth-token");
  }

  return { ok: errors.length === 0, errors };
}

// ── History helpers ──────────────────────────────────────────────────

/** Save a finished agent to the repo's history file. */
async function saveToHistory(agent: AgentState, repoPath: string): Promise<void> {
  if (agent.historical) return;
  const status = agent.status as "completed" | "failed" | "cancelled";
  const task: PersistedTask = {
    taskId: agent.taskId,
    prompt: agent.prompt,
    status,
    createdAt: new Date(Date.now() - agent.elapsed * 1000).toISOString(),
    completedAt: new Date().toISOString(),
    elapsed: agent.elapsed,
    prUrl: agent.result?.prUrl ?? null,
    finalBranch: agent.result?.finalBranch ?? null,
    error: agent.error || null,
    lastActivity: agent.lastActivity,
  };
  await upsertHistory(repoPath, task);
}

/** Check the current state of a PR via `gh pr view`. */
async function checkPrState(prUrl: string): Promise<"open" | "merged" | "closed" | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "view", prUrl, "--json", "state", "-q", ".state"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) return null;
    const state = (await new Response(proc.stdout).text()).trim();
    if (state === "MERGED") return "merged";
    if (state === "CLOSED") return "closed";
    return "open";
  } catch {
    return null;
  }
}

// ── Prompt Input ─────────────────────────────────────────────────────

/** Text input that supports Shift+Enter to insert newlines and Enter to submit. */
function PromptInput({
  defaultValue = "",
  placeholder = "",
  isDisabled = false,
  onSubmit,
}: {
  defaultValue?: string;
  placeholder?: string;
  isDisabled?: boolean;
  onSubmit?: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [cursorOffset, setCursorOffset] = useState(defaultValue.length);

  // Refs kept in sync with state for use in event handlers to avoid stale closures.
  const valueRef = useRef(value);
  const cursorOffsetRef = useRef(cursorOffset);
  valueRef.current = value;
  cursorOffsetRef.current = cursorOffset;

  // Handle Shift+Enter via the Kitty keyboard protocol escape sequence (\x1b[13;2u).
  // Standard terminals send the same \r byte for Enter and Shift+Enter, so Ink's
  // useInput cannot distinguish them. Terminals supporting the Kitty protocol
  // (kitty, WezTerm, foot, etc.) send a distinct sequence that we intercept here.
  useEffect(() => {
    if (isDisabled) return;
    const handleData = (data: Buffer) => {
      if (data.toString() === "\x1b[13;2u") {
        const cur = cursorOffsetRef.current;
        const val = valueRef.current;
        const newValue = val.slice(0, cur) + "\n" + val.slice(cur);
        const newCursor = cur + 1;
        valueRef.current = newValue;
        cursorOffsetRef.current = newCursor;
        setValue(newValue);
        setCursorOffset(newCursor);
      }
    };
    process.stdin.on("data", handleData);
    return () => { process.stdin.off("data", handleData); };
  }, [isDisabled]);

  useInput(
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      if (key.return) {
        if (key.shift) {
          const cur = cursorOffsetRef.current;
          const val = valueRef.current;
          const newValue = val.slice(0, cur) + "\n" + val.slice(cur);
          const newCursor = cur + 1;
          valueRef.current = newValue;
          cursorOffsetRef.current = newCursor;
          setValue(newValue);
          setCursorOffset(newCursor);
        } else {
          onSubmit?.(valueRef.current);
        }
        return;
      }

      if (key.leftArrow) {
        const newCursor = Math.max(0, cursorOffsetRef.current - 1);
        cursorOffsetRef.current = newCursor;
        setCursorOffset(newCursor);
      } else if (key.rightArrow) {
        const newCursor = Math.min(valueRef.current.length, cursorOffsetRef.current + 1);
        cursorOffsetRef.current = newCursor;
        setCursorOffset(newCursor);
      } else if (key.backspace || key.delete) {
        const cur = cursorOffsetRef.current;
        if (cur > 0) {
          const val = valueRef.current;
          const newValue = val.slice(0, cur - 1) + val.slice(cur);
          const newCursor = cur - 1;
          valueRef.current = newValue;
          cursorOffsetRef.current = newCursor;
          setValue(newValue);
          setCursorOffset(newCursor);
        }
      } else if (input) {
        const cur = cursorOffsetRef.current;
        const val = valueRef.current;
        const newValue = val.slice(0, cur) + input + val.slice(cur);
        const newCursor = cur + input.length;
        valueRef.current = newValue;
        cursorOffsetRef.current = newCursor;
        setValue(newValue);
        setCursorOffset(newCursor);
      }
    },
    { isActive: !isDisabled },
  );

  const parts = useMemo(() => {
    if (isDisabled) {
      return [<Text key="val" dimColor>{placeholder}</Text>];
    }
    if (value.length === 0) {
      if (!placeholder) {
        return [<Text key="cursor" inverse> </Text>];
      }
      return [
        <Text key="cursor" inverse>{placeholder[0]}</Text>,
        <Text key="rest" dimColor>{placeholder.slice(1)}</Text>,
      ];
    }
    const result: React.ReactNode[] = [];
    let i = 0;
    for (const char of value) {
      const displayChar = char === "\n" ? "↵" : char;
      if (i === cursorOffset) {
        result.push(<Text key={i} inverse>{displayChar}</Text>);
      } else {
        result.push(displayChar);
      }
      i++;
    }
    if (cursorOffset === value.length) {
      result.push(<Text key="end-cursor" inverse> </Text>);
    }
    return result;
  }, [value, cursorOffset, placeholder, isDisabled]);

  return <Text>{parts}</Text>;
}

// ── Main Component ───────────────────────────────────────────────────

export default function Dashboard({ cwd }: { cwd: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 80;
  const termHeight = stdout?.rows || 24;

  const [agents, setAgents] = useState<AgentState[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [inputFocused, setInputFocused] = useState(true);
  const [logExpanded, setLogExpanded] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [inputDefault, setInputDefault] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [animTick, setAnimTick] = useState(0);

  const nextId = useRef(1);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const configRef = useRef<DeerConfig | null>(null);
  const baseBranchRef = useRef("main");

  // ── Detect base branch on mount ────────────────────────────────────

  useEffect(() => {
    detectRepo(cwd).then((info) => {
      baseBranchRef.current = info.defaultBranch;
    }).catch(() => {});
  }, [cwd]);

  // ── Sync state from history file ──────────────────────────────────

  const syncWithHistory = useCallback(async () => {
    const fileTasks = await loadHistory(cwd);
    const currentAgents = agentsRef.current;
    const agentByTaskId = new Map(currentAgents.map(a => [a.taskId, a]));
    const fileTaskIds = new Set(fileTasks.map(t => t.taskId));

    const newAgents: AgentState[] = await Promise.all(fileTasks.map(async task => {
      const existing = agentByTaskId.get(task.taskId);
      if (existing && !existing.historical) {
        return existing;
      }
      const id = existing?.id ?? nextId.current++;

      // For running tasks not managed by this instance, check if the tmux
      // session is still alive to distinguish cross-instance tasks from
      // truly interrupted ones.
      if (task.status === "running") {
        const isDead = await isTmuxSessionDead(`deer-${task.taskId}`);
        if (!isDead) {
          return crossInstanceAgent(task, id);
        }
        // Session is dead — fall through to historicalAgent (shows as interrupted)
      }

      return historicalAgent(task, id);
    }));

    for (const agent of currentAgents) {
      if (!agent.historical && !fileTaskIds.has(agent.taskId)) {
        newAgents.push(agent);
      }
    }

    const changed =
      newAgents.length !== currentAgents.length ||
      newAgents.some((a, i) => {
        const cur = currentAgents[i];
        return !cur || a.taskId !== cur.taskId || a.status !== cur.status || a.lastActivity !== cur.lastActivity;
      });

    if (changed) setAgents(newAgents);
  }, [cwd]);

  // ── Load history + preflight on mount ─────────────────────────────

  useEffect(() => {
    runPreflight().then(setPreflight);
    loadConfig(cwd).then((cfg) => { configRef.current = cfg; });
    syncWithHistory();
  }, [cwd, syncWithHistory]);

  // ── Poll history file for changes from other deer instances ────────

  useEffect(() => {
    const interval = setInterval(syncWithHistory, 2_000);
    return () => clearInterval(interval);
  }, [syncWithHistory]);

  // ── Animate upload icon when creating PR ─────────────────────────

  useEffect(() => {
    const anyCreating = agents.some((a) => a.creatingPr);
    if (!anyCreating) return;
    const interval = setInterval(() => setAnimTick((t) => t + 1), 200);
    return () => clearInterval(interval);
  }, [agents]);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    const cleanup = () => {
      for (const agent of agentsRef.current) {
        if (isActive(agent) && agent.handle) {
          agent.abortController?.abort();
          agent.handle.kill().catch(() => {});
        }
      }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });

    return () => {
      process.removeListener("exit", cleanup);
    };
  }, [cwd]);

  // ── Check PR merge status periodically ────────────────────────────

  useEffect(() => {
    const check = async () => {
      const toCheck = agentsRef.current.filter(
        (a) => a.result?.prUrl && (a.prState === null || a.prState === "open"),
      );
      if (toCheck.length === 0) return;

      const results = await Promise.all(
        toCheck.map((agent) => checkPrState(agent.result!.prUrl)),
      );
      let changed = false;
      for (let i = 0; i < toCheck.length; i++) {
        const state = results[i];
        if (state !== toCheck[i].prState) {
          toCheck[i].prState = state;
          changed = true;
        }
      }
      if (changed) setAgents((prev) => [...prev]);
    };

    check();
    const interval = setInterval(check, PR_MERGE_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // ── Spawn agent ───────────────────────────────────────────────────

  const spawnAgent = useCallback(async (prompt: string, baseBranch?: string) => {
    if (!prompt.trim()) return;
    if (preflight && !preflight.ok) return;

    const config = configRef.current;
    if (!config) return;

    const id = nextId.current++;
    const effectiveBranch = baseBranch ?? baseBranchRef.current;
    const agent = createAgentState({
      id,
      prompt: prompt.trim(),
      baseBranch: effectiveBranch,
    });

    const abortController = new AbortController();
    agent.abortController = abortController;

    // Start elapsed timer
    agent.timer = setInterval(() => {
      agent.elapsed++;
      setAgents((prev) => [...prev]);
    }, 1000);

    setAgents((prev) => [...prev, agent]);

    try {
      // Phase 1: Start the sandboxed agent
      appendLog(agent, "[setup] Creating worktree and sandbox...");
      agent.lastActivity = "Setting up sandbox...";
      setAgents((prev) => [...prev]);

      const handle = await startAgent({
        repoPath: cwd,
        prompt: prompt.trim(),
        baseBranch: effectiveBranch,
        config,
        model: MODEL,
        onStatus: (status) => {
          const detail = "message" in status ? status.message : status.phase;
          appendLog(agent, `[setup] ${detail}`);
          agent.lastActivity = detail;
          setAgents((prev) => [...prev]);
        },
      });

      agent.handle = handle;
      agent.taskId = handle.taskId;

      // Persist immediately so the task survives if deer closes
      await upsertHistory(cwd, {
        taskId: agent.taskId,
        prompt: agent.prompt,
        status: "running",
        createdAt: new Date().toISOString(),
        completedAt: null,
        elapsed: 0,
        prUrl: null,
        finalBranch: null,
        error: null,
            lastActivity: "",
      });

      agent.status = transition(agent.status, "SETUP_COMPLETE") ?? agent.status;
      appendLog(agent, `[running] Claude started in tmux session: ${handle.sessionName}`);
      agent.lastActivity = "Claude running...";
      setAgents((prev) => [...prev]);

      // Phase 2: Poll for completion (process exit or idle detection)
      let lastPaneSnapshot = "";
      let unchangedCount = 0;
      while (true) {
        await Bun.sleep(POLL_MS);
        if (abortController.signal.aborted) return;

        const dead = await isTmuxSessionDead(handle.sessionName);
        if (dead) {
          appendLog(agent, "[tmux] Claude process exited");
          break;
        }

        // Capture visible pane content and diff against previous frame
        const lines = await captureTmuxPane(handle.sessionName);
        if (lines) {
          const snapshot = lines.map(stripAnsi).map((l) => l.trim()).filter(Boolean).join("\n");

          if (snapshot === lastPaneSnapshot) {
            unchangedCount++;
          } else {
            unchangedCount = 0;
            lastPaneSnapshot = snapshot;

            // Update lastActivity with the latest ● line (Claude's text output)
            const lastOutput = lines
              .map(stripAnsi)
              .map((l) => l.trim())
              .filter((l) => l.startsWith("●"))
              .pop();
            if (lastOutput) {
              const activity = truncate(lastOutput, 120);
              if (activity !== agent.lastActivity) {
                agent.lastActivity = activity;
                appendLog(agent, `[tmux] ${truncate(lastOutput, 200)}`);
                // Persist progress so other deer instances see the current activity
                await upsertHistory(cwd, {
                  taskId: agent.taskId,
                  prompt: agent.prompt,
                  status: "running",
                  createdAt: new Date(Date.now() - agent.elapsed * 1000).toISOString(),
                  completedAt: null,
                  elapsed: agent.elapsed,
                  prUrl: null,
                  finalBranch: null,
                  error: null,
                  lastActivity: agent.lastActivity,
                });
                setAgents((prev) => [...prev]);
              }
            }
          }

          // Claude is idle when the pane hasn't changed for several consecutive polls
          if (unchangedCount >= IDLE_THRESHOLD && !agent.idle) {
            agent.idle = true;
            agent.lastActivity = "Idle — press ⏎ to attach";
            appendLog(agent, "[deer] Claude is idle");
            setAgents((prev) => [...prev]);
          } else if (unchangedCount === 0 && agent.idle) {
            agent.idle = false;
            setAgents((prev) => [...prev]);
          }
        }
      }

      if (abortController.signal.aborted) return;

      // Process exited — mark completed, user decides what to do next
      agent.idle = false;
      agent.status = "completed";
      agent.result = { finalBranch: handle.branch, prUrl: "" };
      agent.lastActivity = "Task complete — press p to create PR, ⏎ to attach";
    } catch (err) {
      if (!abortController.signal.aborted) {
        agent.status = transition(agent.status, "ERROR") ?? "failed";
        agent.error = err instanceof Error ? err.message : String(err);
        agent.lastActivity = truncate(agent.error, 120);
      }
    } finally {
      if (agent.timer) clearInterval(agent.timer);
      agent.timer = null;
      await saveToHistory(agent, cwd);
      setAgents((prev) => [...prev]);
    }
  }, [cwd, preflight]);

  // ── Kill agent ────────────────────────────────────────────────────

  const killAgent = useCallback((agent: AgentState) => {
    if (!isActive(agent)) return;
    agent.status = transition(agent.status, "USER_KILL") ?? "cancelled";
    agent.lastActivity = "Cancelled by user";
    agent.abortController?.abort();
    if (agent.handle) {
      agent.handle.kill().catch(() => {});
    }
    if (agent.timer) clearInterval(agent.timer);
    agent.timer = null;
    saveToHistory(agent, cwd);
    setAgents((prev) => [...prev]);
  }, [cwd]);

  // ── Attach to running agent (just tmux attach) ────────────────────

  const attachToAgent = useCallback(async (agent: AgentState) => {
    if (!agent.handle) return;

    await withSuspendedTerminal(setSuspended, async () => {
      // Small delay to let any pending keypress (e.g. the Enter that triggered
      // attach) flush through before tmux takes over stdin.
      await Bun.sleep(50);
      const { spawnSync } = await import("node:child_process");
      spawnSync("tmux", ["attach", "-t", agent.handle!.sessionName], {
        stdio: "inherit",
      });
    });

    // Update lastActivity after detach
    if (agent.handle && agent.status === "running") {
      const lines = await captureTmuxPane(agent.handle.sessionName);
      if (lines) {
        const lastLine = lines.map(stripAnsi).map((l) => l.trim()).filter(Boolean).pop();
        if (lastLine) {
          agent.lastActivity = truncate(lastLine, 120);
        }
      }
      setAgents((prev) => [...prev]);
    }
  }, []);

  // ── Continue: focus input to spawn a new agent off a PR branch ────

  const createPr = useCallback(async (agent: AgentState) => {
    if (!agent.handle || agent.result?.prUrl) return;

    agent.creatingPr = true;
    agent.lastActivity = "Creating PR...";
    setAgents((prev) => [...prev]);

    try {
      const result = await createAgentPR(
        agent.handle,
        cwd,
        agent.baseBranch,
        agent.prompt,
      );
      agent.result = { finalBranch: result.finalBranch, prUrl: result.prUrl };
      agent.lastActivity = "PR created";
    } catch (err) {
      agent.lastActivity = `PR failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      agent.creatingPr = false;
    }
    await saveToHistory(agent, cwd);
    setAgents((prev) => [...prev]);
  }, [cwd]);


  // ── Keyboard input ────────────────────────────────────────────────

  useInput((input, key) => {
    if (suspended) return;

    const visible = agents;
    const clampedIdx = Math.min(selectedIdx, Math.max(visible.length - 1, 0));

    // Quit handling
    if (input === "q" && !inputFocused) {
      const running = agents.filter(isActive);
      if (running.length > 0 && !confirmQuit) {
        setConfirmQuit(true);
        return;
      }
      for (const a of running) killAgent(a);
      exit();
      return;
    }

    // Confirm quit
    if (confirmQuit) {
      if (input === "y" || input === "Y") {
        const running = agents.filter(isActive);
        for (const a of running) killAgent(a);
        exit();
      } else {
        setConfirmQuit(false);
      }
      return;
    }

    // Prompt history navigation (when input focused)
    if (inputFocused && promptHistory.length > 0) {
      if (key.upArrow) {
        const nextIdx = historyIdx < promptHistory.length - 1 ? historyIdx + 1 : historyIdx;
        setHistoryIdx(nextIdx);
        setInputDefault(promptHistory[promptHistory.length - 1 - nextIdx]);
        setInputKey((k) => k + 1);
        return;
      }
      if (key.downArrow) {
        const nextIdx = historyIdx > 0 ? historyIdx - 1 : -1;
        setHistoryIdx(nextIdx);
        setInputDefault(nextIdx === -1 ? "" : promptHistory[promptHistory.length - 1 - nextIdx]);
        setInputKey((k) => k + 1);
        return;
      }
    }

    // Tab to toggle focus
    if (key.tab) {
      setInputFocused((prev) => !prev);
      return;
    }

    // List navigation (when list focused)
    if (!inputFocused && visible.length > 0) {
      if (input === "j" || key.downArrow) {
        setSelectedIdx((prev) => Math.min(prev + 1, visible.length - 1));
      }
      if (input === "k" || key.upArrow) {
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      }

      // Resolve agent-specific actions via state machine
      const agent = visible[clampedIdx];
      if (agent) {
        const ctx = {
          status: agent.status,
          hasPrUrl: !!agent.result?.prUrl,
          hasFinalBranch: !!agent.result?.finalBranch || !!agent.handle?.branch,
          hasHandle: !!agent.handle,
          isIdle: agent.idle,
          prState: agent.prState,
        };
        const actions = availableActions(ctx);
        const action = resolveKeypress(input, key, actions);

        switch (action) {
          case "attach":
            attachToAgent(agent);
            break;
          case "create_pr":
            createPr(agent);
            break;
          case "open_pr":
            if (agent.result?.prUrl) openUrl(agent.result.prUrl);
            break;
          case "kill":
            killAgent(agent);
            break;
          case "delete":
            if (agent.handle) {
              destroyAgent(agent.handle, cwd).catch(() => {});
            }
            setAgents((prev) => prev.filter((a) => a !== agent));
            setSelectedIdx((prev) => Math.min(prev, Math.max(visible.length - 2, 0)));
            removeFromHistory(cwd, agent.taskId);
            break;
          case "toggle_logs":
            setLogExpanded((prev) => !prev);
            break;
          case "retry":
            spawnAgent(agent.prompt);
            break;
        }
      }
    }
  });

  // ── Render nothing when suspended ─────────────────────────────────

  if (suspended) return null;

  // ── Derived state ─────────────────────────────────────────────────

  const clampedIdx = Math.min(selectedIdx, Math.max(agents.length - 1, 0));
  const activeCount = agents.filter(isActive).length;
  const selected = agents[clampedIdx] || null;
  const preflightOk = preflight?.ok ?? false;

  const chromeHeight = 5;
  const detailHeight = logExpanded && selected ? Math.min(MAX_VISIBLE_LOGS + 1, 6) : 0;
  const listHeight = Math.max(termHeight - chromeHeight - detailHeight, 3);
  const hasPrEntries = agents.some((a) => a.result?.prUrl);
  const entryRows = hasPrEntries ? ENTRY_ROWS_WITH_PR : ENTRY_ROWS_BASE;
  const maxVisibleEntries = Math.max(Math.floor(listHeight / entryRows), 1);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight}>
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold>deer</Text>
        <Text dimColor>{activeCount > 0 ? `${activeCount} active` : "idle"}</Text>
      </Box>
      <Text>{"─".repeat(termWidth)}</Text>

      {/* Preflight errors */}
      {preflight && !preflight.ok && (
        <Box flexDirection="column" paddingX={1}>
          {preflight.errors.map((e) => (
            <Text key={e} color="red">✗ {e}</Text>
          ))}
        </Box>
      )}

      {/* Agent list */}
      <Box flexDirection="column" height={listHeight} paddingX={1}>
        {agents.length === 0 ? (
          <Box justifyContent="center" paddingY={1}>
            <Text dimColor>Type a prompt below and press Enter to launch an agent</Text>
          </Box>
        ) : (
          agents.slice(0, maxVisibleEntries).map((agent, i) => {
            const display = STATUS_DISPLAY[agent.status];
            const isSelected = i === clampedIdx && !inputFocused;
            const pointer = isSelected ? "▸" : " ";

            const recentLogs = agent.logs.slice(-LOG_LINES_PER_ENTRY);
            const titleOverhead = 11;
            const prBadge = agent.result?.prUrl && agent.prState
              ? {
                  icon: agent.prState === "merged" ? "🟣" : agent.prState === "closed" ? "🔴" : "🟢",
                  color: prStateColor(agent.prState),
                }
              : null;
            const titleWidth = Math.max(termWidth - titleOverhead - (prBadge ? 3 : 0), 5);
            const logWidth = Math.max(termWidth - 5, 5);

            return (
              <Box key={agent.id} flexDirection="column">
                {/* Title line */}
                <Box gap={1}>
                  <Text dimColor={!isSelected}>{pointer}</Text>
                  {agent.creatingPr ? (
                    <Text color="blue">{UPLOAD_FRAMES[animTick % UPLOAD_FRAMES.length]}</Text>
                  ) : agent.idle ? (
                    <Text>{agent.result?.prUrl ? "👀" : "👋"}</Text>
                  ) : agent.status === "running" ? (
                    <Spinner label="" />
                  ) : (
                    <Text color={display.color}>{display.icon}</Text>
                  )}
                  <Box flexGrow={1}>
                    <Text bold={isSelected} wrap="truncate">
                      {truncate(agent.prompt, titleWidth)}
                    </Text>
                  </Box>
                  {prBadge && <Text>{prBadge.icon}</Text>}
                  <Text dimColor>{formatTime(agent.elapsed)}</Text>
                </Box>
                {/* PR link line */}
                {agent.result?.prUrl && (
                  <Box paddingLeft={3}>
                    <Text
                      dimColor={!isSelected}
                      color={prStateColor(agent.prState)}
                      wrap="truncate"
                    >
                      {truncate(agent.result.prUrl, logWidth)}
                    </Text>
                  </Box>
                )}
                {/* Log lines */}
                {recentLogs.map((line, j) => (
                  <Box key={j} paddingLeft={3}>
                    <Text dimColor wrap="truncate">
                      {truncate(line, logWidth)}
                    </Text>
                  </Box>
                ))}
              </Box>
            );
          })
        )}
      </Box>

      {/* Log detail panel */}
      {logExpanded && selected && (() => {
        const extraLines = (selected.result?.prUrl ? 1 : 0) + (selected.error ? 1 : 0);
        const visibleLogs = Math.max(MAX_VISIBLE_LOGS - extraLines, 1);
        return (
          <Box flexDirection="column" paddingX={1} height={detailHeight} overflowY="hidden">
            <Text dimColor>{"╌".repeat(termWidth - 2)}</Text>
            {selected.logs.slice(-visibleLogs).map((line, i) => (
              <Text key={i} dimColor wrap="truncate">
                {truncate(line, termWidth - 4)}
              </Text>
            ))}
            {selected.result?.prUrl && (
              <Text color={prStateColor(selected.prState)} bold>
                PR ({selected.prState ?? "checking…"}): {selected.result.prUrl}
              </Text>
            )}
            {selected.error && (
              <Text color="red">{truncate(selected.error, termWidth - 4)}</Text>
            )}
          </Box>
        );
      })()}

      {/* Input divider + input bar */}
      <Text>{"─".repeat(termWidth)}</Text>
      <Box paddingX={1} gap={1}>
        <Text dimColor>{">"}</Text>
        {inputFocused ? (
          <PromptInput
            key={inputKey}
            placeholder={!preflightOk ? "preflight checks failed" : "type prompt and press Enter to launch agent (Shift+Enter for newline)"}
            isDisabled={!preflightOk}
            defaultValue={inputDefault}
            onSubmit={(value) => {
              if (value.trim()) {
                setPromptHistory((prev) => [...prev, value.trim()]);
                setHistoryIdx(-1);
                setInputDefault("");
                setInputKey((k) => k + 1);
                spawnAgent(value);
              }
            }}
          />
        ) : (
          <Text dimColor italic>press Tab to type a prompt</Text>
        )}
      </Box>

      {/* Footer / keybindings */}
      <Text>{"─".repeat(termWidth)}</Text>
      <Box paddingX={1} gap={2}>
        {confirmQuit ? (
          <Text color="yellow" bold>
            {activeCount} agent{activeCount !== 1 ? "s" : ""} running — quit? (y/n)
          </Text>
        ) : (
          <>
            <Text dimColor>Tab focus</Text>
            {inputFocused ? null : (
              <>
                <Text dimColor>j/k nav</Text>
                {selected && availableActions({
                  status: selected.status,
                  hasPrUrl: !!selected.result?.prUrl,
                  hasFinalBranch: !!selected.result?.finalBranch || !!selected.handle?.branch,
                  hasHandle: !!selected.handle,
                  isIdle: selected.idle,
                  prState: selected.prState,
                }).map((action) => (
                  <Text key={action} dimColor>
                    {ACTION_BINDINGS[action].keyDisplay} {ACTION_BINDINGS[action].label}
                  </Text>
                ))}
                <Text dimColor>q quit</Text>
              </>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
