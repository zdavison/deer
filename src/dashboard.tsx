import { Box, Text, useInput, useApp, useStdout } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { join } from "node:path";
import { mkdir, access } from "node:fs/promises";
import { generateTaskId, transcriptsDir, loadHistory, upsertHistory, removeFromHistory } from "./task";
import type { PersistedTask } from "./task";
import { loadConfig } from "./config";
import type { DeerConfig } from "./config";

// ── Types ────────────────────────────────────────────────────────────

type AgentStatus = "setup" | "running" | "teardown" | "completed" | "failed" | "cancelled" | "interrupted";

interface SandboxMeta {
  sandboxName: string;
  worktreePath: string;
  tempBranch: string;
  baseBranch: string;
  sandboxHome: string;
  model: string;
  /** Temp dir for deer artifacts (inside GIT_DIR, not tracked by git) */
  deerTmpDir: string;
}

interface TeardownResult {
  finalBranch: string;
  prUrl: string;
}

interface AgentState {
  id: number;
  /** Persistent task ID (deer_xxx format) for history storage */
  taskId: string;
  prompt: string;
  status: AgentStatus;
  /** Elapsed seconds */
  elapsed: number;
  /** Last activity from NDJSON stream */
  lastActivity: string;
  /** Current tool being used */
  currentTool: string;
  /** Log lines (capped) */
  logs: string[];
  /** Sandbox metadata from setup */
  meta: SandboxMeta | null;
  /** Teardown result */
  result: TeardownResult | null;
  /** Error message on failure */
  error: string;
  /** Running process handle */
  proc: { kill(): void } | null;
  /** Timer handle */
  timer: ReturnType<typeof setInterval> | null;
  /** PR state on GitHub: null = unchecked, "open" = open, "merged" = merged, "closed" = closed */
  prState: "open" | "merged" | "closed" | null;
  /** User attached interactively — headless process killed, attach handler owns teardown */
  userAttached: boolean;
  /** Agent is waiting for user input (e.g. AskUserQuestion tool) */
  needsAttention: boolean;
  /** Background tmux watcher is running for this agent */
  tmuxWatched: boolean;
  /** Human-readable conversation transcript (markdown blocks) */
  transcript: string[];
  /** Path to persisted transcript file (set when completed with no code changes) */
  transcriptPath: string | null;
  /** True if this agent was loaded from history (not spawned this session) */
  historical: boolean;
}

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

const MAX_LOG_LINES = 200;
const MAX_VISIBLE_LOGS = 5;
const LOG_LINES_PER_ENTRY = 2;
const ENTRY_ROWS = 1 + LOG_LINES_PER_ENTRY;
const MODEL = "sonnet";
const PR_MERGE_CHECK_INTERVAL_MS = 60_000;

/** Tool names that indicate the agent is blocked waiting for user input */
const ATTENTION_TOOLS = new Set([
  "AskUserQuestion",
  "AskFollowupQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

/** Timeout for the metadata extraction follow-up invocation */
const METADATA_TIMEOUT_MS = 60_000;

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");

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

function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawn([cmd, url], { stdout: "pipe", stderr: "pipe" });
}

/** Timeout for the needs-input classification invocation */
const NEEDS_INPUT_TIMEOUT_MS = 15_000;

/**
 * Use a fast LLM call to determine if the agent's last transcript message
 * is asking the user for input/clarification/decisions — works across
 * all languages.
 *
 * Returns true if the agent appears to be blocked on human intervention.
 */
export async function needsHumanInput(transcript: string[]): Promise<boolean> {
  if (transcript.length === 0) return false;
  const last = transcript[transcript.length - 1].trim();
  if (!last) return false;

  const prompt = [
    "You are a classifier. The following message is the final output from an AI coding agent.",
    "Is a response from the user expected after this message?",
    "For example: the agent asked a question, presented options to choose from,",
    "requested clarification, asked the user to do something, or is otherwise",
    "waiting for input before it can continue.",
    "",
    "Respond with exactly YES or NO. Nothing else.",
    "",
    "<agent-message>",
    last.length > 2000 ? last.slice(-2000) : last,
    "</agent-message>",
  ].join("\n");

  try {
    const { CLAUDECODE: _, ANTHROPIC_API_KEY: __, ...env } = process.env;
    const proc = Bun.spawn([
      "claude", "-p", "--output-format", "text", "--model", "haiku",
    ], {
      stdin: new Response(prompt),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error("needs-input classification timed out"));
      }, NEEDS_INPUT_TIMEOUT_MS),
    );

    const result = await Promise.race([
      proc.exited.then(async (code) => {
        if (code !== 0) return false;
        const text = (await new Response(proc.stdout).text()).trim().toUpperCase();
        return text === "YES";
      }),
      timeout,
    ]);

    return result;
  } catch {
    // On any failure, assume no — don't block the normal flow
    return false;
  }
}

function buildTranscriptMarkdown(agent: AgentState): string {
  const date = new Date().toISOString().replace("T", " ").slice(0, 16);
  const heading = agent.prompt.length > 80 ? agent.prompt.slice(0, 80) + "…" : agent.prompt;

  const sections: string[] = [
    `# deer — ${heading}`,
    "",
    `**Date:** ${date}`,
    "",
    "---",
    "",
    "## User",
    "",
    agent.prompt,
    "",
    "## Assistant",
    "",
    agent.transcript.join("\n\n"),
  ];

  return sections.join("\n") + "\n";
}

async function persistTranscript(agent: AgentState): Promise<string> {
  const dir = transcriptsDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${agent.taskId}.md`);
  await Bun.write(filePath, buildTranscriptMarkdown(agent));
  return filePath;
}

// ── Preflight ────────────────────────────────────────────────────────

interface PreflightResult {
  ok: boolean;
  errors: string[];
}

async function runPreflight(): Promise<PreflightResult> {
  const errors: string[] = [];

  // Check docker sandbox
  try {
    const p = Bun.spawn(["docker", "sandbox", "version"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("docker sandbox not available (Docker Desktop 4.58+ required)");
  } catch {
    errors.push("docker sandbox not available");
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
  const tokenFile = join(process.env.HOME || "", ".claude/agent-oauth-token");
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

// ── Agent Lifecycle ──────────────────────────────────────────────────

async function setupAgent(cwd: string): Promise<SandboxMeta> {
  const proc = Bun.spawn(["bash", join(SCRIPTS_DIR, "setup-sandbox.sh"), cwd, MODEL], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Setup failed (exit ${code}): ${stderr.trim().split("\n").pop()}`);
  }

  const stdout = await new Response(proc.stdout).text();
  const lines = stdout.trim().split("\n").filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  if (!jsonLine) throw new Error("Setup produced no output");
  return JSON.parse(jsonLine) as SandboxMeta;
}

/**
 * Apply a deny-by-default network policy to the sandbox, allowing only the
 * domains in the config allowlist. Called after sandbox creation but before
 * the agent starts, so tmux/apt installs during setup are unaffected.
 */
async function applyNetworkPolicy(sandboxName: string, allowlist: string[]): Promise<void> {
  const args = [
    "docker", "sandbox", "network", "proxy", sandboxName,
    "--policy", "deny",
    ...allowlist.flatMap((host) => ["--allow-host", host]),
  ];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Network policy failed (exit ${code}): ${stderr.trim()}`);
  }
}

/**
 * Run claude -p inside the sandbox. Returns the spawned process.
 * The caller should read stdout for NDJSON events.
 */
async function startClaude(meta: SandboxMeta, prompt: string): Promise<ReturnType<typeof Bun.spawn>> {
  // Write prompt to temp dir outside worktree to avoid polluting the git working tree
  const promptPath = join(meta.deerTmpDir, ".agent-prompt");
  await Bun.write(promptPath, prompt);

  const proc = Bun.spawn([
    "docker", "sandbox", "exec", "--privileged", meta.sandboxName,
    "env", "-u", "ANTHROPIC_API_KEY",
    `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
    "sh", "-c",
    `cd ${meta.worktreePath} && cat ${meta.deerTmpDir}/.agent-prompt | claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model ${MODEL}`,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  return proc;
}

/**
 * Build the follow-up prompt that asks the agent to write metadata files.
 * Includes the repo's PR template if one exists.
 */
async function buildMetadataPrompt(worktreePath: string, deerTmpDir: string): Promise<string> {
  let prTemplate = "";

  const templatePaths = [
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
  ];

  for (const rel of templatePaths) {
    const f = Bun.file(join(worktreePath, rel));
    if (await f.exists()) {
      prTemplate = await f.text();
      break;
    }
  }

  const prSection = prTemplate
    ? `A pull request description following this template:\n\n<pr-template>\n${prTemplate}\n</pr-template>`
    : `A pull request description with a summary of the changes.`;

  return [
    "Your task is complete. Now write these three files:",
    "",
    `1. \`${deerTmpDir}/.agent-branch-name\``,
    "   A short kebab-case name for a git branch describing your changes.",
    "   No prefix. Examples: fix-login-validation, add-user-avatar-upload",
    "",
    `2. \`${deerTmpDir}/.agent-commit-message\``,
    "   A conventional git commit message. First line is the subject (<72 chars),",
    "   then a blank line, then an optional body.",
    "",
    `3. \`${deerTmpDir}/.agent-pr-body\``,
    `   ${prSection}`,
    "",
    "Write these three files now. Do nothing else.",
  ].join("\n");
}

/**
 * Run a follow-up `claude -p --continue` to extract metadata (branch name,
 * commit message, PR body) after the main task finishes.
 *
 * Non-fatal — if this fails or times out, teardown has fallbacks.
 */
async function startClaudeMetadata(meta: SandboxMeta, agent: AgentState): Promise<void> {
  const prompt = await buildMetadataPrompt(meta.worktreePath, meta.deerTmpDir);
  const promptPath = join(meta.deerTmpDir, ".agent-metadata-prompt");
  await Bun.write(promptPath, prompt);

  const proc = Bun.spawn([
    "docker", "sandbox", "exec", "--privileged", meta.sandboxName,
    "env", "-u", "ANTHROPIC_API_KEY",
    `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
    "sh", "-c",
    `cd ${meta.worktreePath} && cat ${meta.deerTmpDir}/.agent-metadata-prompt | claude -p --continue --output-format stream-json --verbose --dangerously-skip-permissions --model ${MODEL}`,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Drain stdout/stderr to prevent backpressure
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text().then((text) => {
    if (text.trim()) appendLog(agent, `[metadata stderr] ${text.trim()}`);
  });

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error("Metadata extraction timed out"));
    }, METADATA_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      proc.exited.then(async (code) => {
        await stdoutPromise;
        await stderrPromise;
        if (code !== 0) throw new Error(`Metadata extraction exited with code ${code}`);
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

async function teardownAgent(meta: SandboxMeta, cwd: string): Promise<TeardownResult> {
  const proc = Bun.spawn([
    "bash", join(SCRIPTS_DIR, "teardown-sandbox.sh"),
    cwd, meta.worktreePath, meta.sandboxName, meta.tempBranch, meta.baseBranch, meta.model, meta.deerTmpDir,
  ], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Teardown failed (exit ${code}): ${stderr.trim().split("\n").pop()}`);
  }

  const lines = stdout.trim().split("\n").filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  if (!jsonLine) throw new Error("Teardown produced no output");
  return JSON.parse(jsonLine) as TeardownResult;
}

function cleanupAgent(agent: AgentState, repoRoot: string) {
  if (agent.proc) {
    try { agent.proc.kill(); } catch { /* ignore */ }
  }
  if (agent.timer) clearInterval(agent.timer);
  if (agent.meta) {
    // Best-effort cleanup — fire-and-forget to avoid blocking the UI
    const { sandboxName, worktreePath, tempBranch } = agent.meta;
    (async () => {
      try { await Bun.spawn(["docker", "sandbox", "rm", sandboxName]).exited; } catch { /* ignore */ }
      try { await Bun.spawn(["git", "-C", repoRoot, "worktree", "remove", "--force", worktreePath]).exited; } catch { /* ignore */ }
      try { await Bun.spawn(["git", "-C", repoRoot, "branch", "-D", tempBranch]).exited; } catch { /* ignore */ }
    })();
  }
}

/**
 * Run metadata extraction + teardown for an agent.
 * Handles its own errors — sets agent status to completed or failed.
 */
async function finalizeAgent(
  agent: AgentState,
  cwd: string,
  setAgents: (updater: (prev: AgentState[]) => AgentState[]) => void,
): Promise<void> {
  if (!agent.meta) return;

  // Metadata extraction (non-fatal)
  agent.lastActivity = "Generating PR metadata...";
  setAgents((prev) => [...prev]);

  try {
    await startClaudeMetadata(agent.meta, agent);
  } catch (err) {
    appendLog(agent, `[warn] Metadata extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Teardown
  agent.status = "teardown";
  agent.lastActivity = "Committing and creating PR...";
  setAgents((prev) => [...prev]);

  try {
    agent.result = await teardownAgent(agent.meta, cwd);
    agent.status = "completed";

    if (agent.result.prUrl) {
      agent.lastActivity = "PR ready";
    } else if (agent.transcript.length > 0) {
      agent.transcriptPath = await persistTranscript(agent);
      agent.lastActivity = "Answer ready — Enter to continue";
    } else {
      agent.lastActivity = "No changes";
    }
  } catch (err) {
    agent.status = "failed";
    agent.error = err instanceof Error ? err.message : String(err);
    agent.lastActivity = truncate(agent.error, 120);
  } finally {
    if (agent.timer) clearInterval(agent.timer);
    agent.timer = null;
    agent.proc = null;
    await saveToHistory(agent, cwd);
    setAgents((prev) => [...prev]);
  }
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

// ── NDJSON Parser ────────────────────────────────────────────────────

function parseNdjsonLine(line: string, agent: AgentState): boolean {
  if (!line.trim()) return false;
  let changed = false;

  try {
    const event = JSON.parse(line);

    // Assistant text content
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          agent.lastActivity = truncate(block.text.replace(/\n/g, " ").trim(), 120);
          appendLog(agent, block.text.trim());
          agent.transcript.push(block.text);
          changed = true;
        }
        if (block.type === "tool_use") {
          const name = block.name || "tool";
          const input = block.input ? JSON.stringify(block.input).slice(0, 100) : "";
          agent.currentTool = `${name} ${input}`;
          appendLog(agent, `[tool] ${name} ${input}`);
          if (ATTENTION_TOOLS.has(name)) {
            agent.needsAttention = true;
          }
          changed = true;
        }
      }
    }

    // Tool result
    if (event.type === "result" && event.result) {
      agent.lastActivity = truncate(String(event.result).replace(/\n/g, " ").trim(), 120);
      changed = true;
    }

    // Content block delta (streaming)
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && event.delta.text) {
        agent.lastActivity = truncate(event.delta.text.replace(/\n/g, " ").trim(), 120);
        changed = true;
      }
    }

    // System message
    if (event.type === "system" && event.message) {
      appendLog(agent, `[system] ${event.message}`);
    }
  } catch {
    // Not valid JSON — treat as plain text log
    if (line.trim()) {
      appendLog(agent, line.trim());
      changed = true;
    }
  }

  return changed;
}

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
    error: agent.error || null,
    transcriptPath: agent.transcriptPath,
    lastActivity: agent.lastActivity,
  };
  await upsertHistory(repoPath, task);
}

/** Convert a persisted task to a read-only AgentState for display. */
function historicalAgent(task: PersistedTask, id: number): AgentState {
  const wasInterrupted = task.status === "running";
  return {
    id,
    taskId: task.taskId,
    prompt: task.prompt,
    status: wasInterrupted ? "interrupted" : task.status,
    elapsed: task.elapsed,
    lastActivity: wasInterrupted ? "Interrupted — deer was closed" : task.lastActivity,
    currentTool: "",
    logs: [],
    meta: null,
    result: task.prUrl ? { finalBranch: "", prUrl: task.prUrl } : null,
    error: task.error || "",
    proc: null,
    timer: null,
    prState: null,
    userAttached: false,
    needsAttention: false,
    tmuxWatched: false,
    transcript: [],
    transcriptPath: task.transcriptPath,
    historical: true,
  };
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

  const nextId = useRef(1);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const configRef = useRef<DeerConfig | null>(null);

  // ── Sync state from history file (cross-instance source of truth) ──

  const syncWithHistory = useCallback(async () => {
    const fileTasks = await loadHistory(cwd);
    const currentAgents = agentsRef.current;
    const agentByTaskId = new Map(currentAgents.map(a => [a.taskId, a]));
    const fileTaskIds = new Set(fileTasks.map(t => t.taskId));

    const newAgents: AgentState[] = fileTasks.map(task => {
      const existing = agentByTaskId.get(task.taskId);
      if (existing && !existing.historical) {
        return existing; // keep live process handle and timer
      }
      const id = existing?.id ?? nextId.current++;
      return historicalAgent(task, id);
    });

    // Keep owned agents not yet written to the file (edge case: spawned but not yet persisted)
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

  // ── Cleanup on unmount ───────────────────────────────────────────

  useEffect(() => {
    const cleanup = () => {
      for (const agent of agentsRef.current) {
        if (isActive(agent)) cleanupAgent(agent, cwd);
      }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });

    return () => {
      process.removeListener("exit", cleanup);
    };
  }, [cwd]);

  // ── Check PR merge status periodically ───────────────────────────

  useEffect(() => {
    const check = async () => {
      // Check agents with a PR URL that are either unchecked or still open (merged/closed are terminal)
      const toCheck = agentsRef.current.filter(
        (a) => a.result?.prUrl && (a.prState === null || a.prState === "open"),
      );
      if (toCheck.length === 0) return;

      let changed = false;
      for (const agent of toCheck) {
        const state = await checkPrState(agent.result!.prUrl);
        if (state !== null && state !== agent.prState) {
          agent.prState = state;
          changed = true;
        }
      }
      if (changed) setAgents((prev) => [...prev]);
    };

    check(); // Run immediately on mount to populate state for historical agents
    const interval = setInterval(check, PR_MERGE_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // ── Spawn agent ──────────────────────────────────────────────────

  const spawnAgent = useCallback(async (prompt: string) => {
    if (!prompt.trim()) return;
    if (preflight && !preflight.ok) return;

    const id = nextId.current++;
    const agent: AgentState = {
      id,
      taskId: generateTaskId(),
      prompt: prompt.trim(),
      status: "setup",
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
      tmuxWatched: false,
      transcript: [],
      transcriptPath: null,
      historical: false,
    };

    // Start elapsed timer
    agent.timer = setInterval(() => {
      agent.elapsed++;
      setAgents((prev) => [...prev]);
    }, 1000);

    setAgents((prev) => [...prev, agent]);

    // Persist immediately so the task survives if deer closes unexpectedly.
    // The final state will overwrite this entry via upsertHistory.
    await upsertHistory(cwd, {
      taskId: agent.taskId,
      prompt: agent.prompt,
      status: "running",
      createdAt: new Date().toISOString(),
      completedAt: null,
      elapsed: 0,
      prUrl: null,
      error: null,
      transcriptPath: null,
      lastActivity: "",
    });

    try {
      // Phase 1: Setup
      agent.meta = await setupAgent(cwd);

      // Phase 1.5: Lock down network — deny all, allow only the configured list.
      // Applied after setup (tmux/apt installs are done) but before the agent runs.
      const allowlist = configRef.current?.network.allowlist ?? [];
      await applyNetworkPolicy(agent.meta.sandboxName, allowlist);

      agent.status = "running";
      setAgents((prev) => [...prev]);

      // Phase 2: Run Claude
      const proc = await startClaude(agent.meta, prompt.trim());
      agent.proc = proc;
      setAgents((prev) => [...prev]);

      // Drain stderr to prevent backpressure (fire-and-forget)
      new Response(proc.stderr as ReadableStream<Uint8Array>).text().then((text) => {
        if (text.trim()) appendLog(agent, `[stderr] ${text.trim()}`);
      });

      // Parse NDJSON stream from stdout
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastRender = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let changed = false;
        for (const line of lines) {
          if (parseNdjsonLine(line, agent)) changed = true;
        }

        // Throttle UI updates to ~200ms
        const now = Date.now();
        if (changed && now - lastRender > 200) {
          lastRender = now;
          setAgents((prev) => [...prev]);
        }
      }

      // Process remaining buffer
      if (buffer.trim()) parseNdjsonLine(buffer, agent);

      const exitCode = await proc.exited;
      if ((agent.status as AgentStatus) === "cancelled") return;
      // User attached interactively — attach handler owns teardown
      if (agent.userAttached) return;

      // Agent exited while waiting for user input — keep alive for attachment
      if (agent.needsAttention || await needsHumanInput(agent.transcript)) {
        agent.needsAttention = true;
        agent.lastActivity = "Needs input — Enter to assist";
        agent.proc = null;
        setAgents((prev) => [...prev]);
        return;
      }

      if (exitCode !== 0) {
        throw new Error(`Claude exited with code ${exitCode}`);
      }

      // Metadata extraction + teardown
      await finalizeAgent(agent, cwd, setAgents);
    } catch (err) {
      if (agent.status !== "cancelled" && !agent.userAttached) {
        agent.status = "failed";
        agent.error = err instanceof Error ? err.message : String(err);
        agent.lastActivity = truncate(agent.error, 120);
        await saveToHistory(agent, cwd);
      }
    } finally {
      // If user attached or agent awaiting input, keep timer running — attach handler cleans up
      if (!agent.userAttached && !agent.needsAttention) {
        if (agent.timer) clearInterval(agent.timer);
        agent.timer = null;
      }
      agent.proc = null;
      setAgents((prev) => [...prev]);
    }
  }, [cwd, preflight]);

  // ── Kill agent ───────────────────────────────────────────────────

  const killAgent = useCallback((agent: AgentState) => {
    if (!isActive(agent)) return;
    agent.status = "cancelled";
    agent.lastActivity = "Cancelled by user";
    cleanupAgent(agent, cwd);
    saveToHistory(agent, cwd);
    setAgents((prev) => [...prev]);
  }, [cwd]);

  // ── Shell into agent ─────────────────────────────────────────────

  const shellIntoAgent = useCallback(async (agent: AgentState) => {
    if (!agent.meta) return;

    setSuspended(true);

    // Leave alternate screen and release raw mode
    process.stdout.write("\x1b[?1049l");
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);

    const tmuxScript = [
      `export PATH="$PATH:/usr/bin:/usr/local/bin:/bin"`,
      `if command -v tmux >/dev/null 2>&1; then`,
      `  if ! tmux has-session -t deer-shell 2>/dev/null; then`,
      `    tmux new-session -d -s deer-shell -c ${agent.meta.worktreePath}`,
      `  fi`,
      `  tmux set -t deer-shell status on`,
      `  tmux set -t deer-shell status-position bottom`,
      `  tmux set -t deer-shell status-style 'bg=#1e1e2e,fg=#6c7086'`,
      `  tmux set -t deer-shell status-left ' 🦌 Ctrl+b d → detach (return to deer) '`,
      `  tmux set -t deer-shell status-left-length 50`,
      `  tmux set -t deer-shell status-right ''`,
      `  tmux set -t deer-shell focus-events off`,
      `  tmux attach -t deer-shell`,
      `else`,
      `  echo "Note: tmux not available — no background detach (exit shell to return)"`,
      `  cd ${agent.meta.worktreePath} && exec sh`,
      `fi`,
    ].join("\n");

    const proc = Bun.spawn([
      "docker", "sandbox", "exec", "-it", agent.meta.sandboxName,
      "sh", "-c", tmuxScript,
    ], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    await proc.exited;

    // Restore alternate screen and raw mode
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");

    setSuspended(false);
  }, []);

  // ── Open transcript in editor ───────────────────────────────────

  const openInEditor = useCallback(async (filePath: string) => {
    const editor = process.env.EDITOR || "vim";

    setSuspended(true);

    // Leave alternate screen and release raw mode
    process.stdout.write("\x1b[?1049l");
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);

    const proc = Bun.spawn([editor, filePath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;

    // Restore alternate screen and raw mode
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");

    setSuspended(false);
  }, []);

  // ── Continue Q&A conversation interactively ──────────────────────

  const continueConversation = useCallback(async (agent: AgentState) => {
    let dir = cwd;
    if (agent.meta?.worktreePath) {
      try {
        await access(agent.meta.worktreePath);
        dir = agent.meta.worktreePath;
      } catch {
        // Worktree was removed during teardown — fall back to main repo dir
      }
    }

    setSuspended(true);

    // Leave alternate screen and release raw mode
    process.stdout.write("\x1b[?1049l");
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);

    const proc = Bun.spawn(["claude"], {
      cwd: dir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;

    // Restore alternate screen and raw mode
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");

    setSuspended(false);
  }, [cwd]);

  // ── Attach to running agent (interactive Claude session) ────────

  const attachToAgent = useCallback(async (agent: AgentState) => {
    if (!agent.meta || agent.status !== "running") return;

    // First attach: kill headless process so Claude can start interactively
    if (!agent.userAttached) {
      agent.userAttached = true;
      agent.needsAttention = false;
      if (agent.proc) {
        try { agent.proc.kill(); } catch { /* ignore */ }
        agent.proc = null;
      }
    }

    setSuspended(true);

    // Leave alternate screen and release raw mode
    process.stdout.write("\x1b[?1049l");
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);

    const tmuxScript = [
      `export PATH="$PATH:/usr/bin:/usr/local/bin:/bin"`,
      `if command -v tmux >/dev/null 2>&1; then`,
      `  if ! tmux has-session -t deer 2>/dev/null; then`,
      `    tmux new-session -d -s deer`,
      `    tmux send-keys -t deer "export CLAUDE_CODE_OAUTH_TOKEN='$CLAUDE_CODE_OAUTH_TOKEN' && cd ${agent.meta.worktreePath} && claude --continue --dangerously-skip-permissions --model ${MODEL}" Enter`,
      `  fi`,
      `  tmux set -t deer status on`,
      `  tmux set -t deer status-position bottom`,
      `  tmux set -t deer status-style 'bg=#1e1e2e,fg=#6c7086'`,
      `  tmux set -t deer status-left ' 🦌 Ctrl+b d → detach (return to deer) | Ctrl+b [ → scroll (q exits) '`,
      `  tmux set -t deer status-left-length 80`,
      `  tmux set -t deer status-right ''`,
      `  tmux set -t deer focus-events off`,
      `  tmux attach -t deer`,
      `else`,
      `  echo "Note: tmux not available — attached directly (Ctrl+C to exit, agent will finalize)"`,
      `  cd ${agent.meta.worktreePath} && claude --continue --dangerously-skip-permissions --model ${MODEL}`,
      `fi`,
    ].join("\n");

    const attachProc = Bun.spawn([
      "docker", "sandbox", "exec", "-it", agent.meta.sandboxName,
      "env", "-u", "ANTHROPIC_API_KEY",
      `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
      "sh", "-c", tmuxScript,
    ], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await attachProc.exited;

    // Restore alternate screen and raw mode
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    setSuspended(false);

    // Bail if agent was killed while we were attached
    if (agent.status !== "running") return;

    // Check if Claude is still running in tmux
    const check = Bun.spawn([
      "docker", "sandbox", "exec", agent.meta.sandboxName,
      "tmux", "has-session", "-t", "deer",
    ], { stdout: "pipe", stderr: "pipe" });
    const sessionAlive = (await check.exited) === 0;

    if (sessionAlive) {
      // User detached — Claude still running in tmux
      agent.lastActivity = "Running in tmux (Enter to re-attach)";
      setAgents((prev) => [...prev]);

      // Start a background watcher (once) to finalize when Claude exits
      if (!agent.tmuxWatched) {
        agent.tmuxWatched = true;
        (async () => {
          while (agent.status === "running" && agent.meta) {
            await Bun.sleep(3000);
            const p = Bun.spawn([
              "docker", "sandbox", "exec", agent.meta.sandboxName,
              "tmux", "has-session", "-t", "deer",
            ], { stdout: "pipe", stderr: "pipe" });
            if ((await p.exited) !== 0) break;
          }
          if (agent.status !== "running") return;
          await finalizeAgent(agent, cwd, setAgents);
        })();
      }
    } else {
      // Claude exited — finalize immediately
      await finalizeAgent(agent, cwd, setAgents);
    }
  }, [cwd]);

  // ── Keyboard input ───────────────────────────────────────────────

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
      if (key.return) {
        const agent = visible[clampedIdx];
        if (agent?.status === "running") {
          // Attach to running agent — opens interactive Claude session
          attachToAgent(agent);
        } else if (agent?.result?.prUrl) {
          // Open completed PR in browser
          openUrl(agent.result.prUrl);
        } else if (agent?.transcriptPath) {
          // Continue conversation interactively
          continueConversation(agent);
        }
      }
      if (input === "s") {
        const agent = visible[clampedIdx];
        if (agent?.meta) shellIntoAgent(agent);
      }
      if (input === "c") {
        const agent = visible[clampedIdx];
        if (agent && !isActive(agent)) continueConversation(agent);
      }
      if (input === "x") {
        const agent = visible[clampedIdx];
        if (agent) killAgent(agent);
      }
      if (input === "l") {
        setLogExpanded((prev) => !prev);
      }
      if (key.backspace || key.delete) {
        const agent = visible[clampedIdx];
        if (agent && !isActive(agent)) {
          setAgents((prev) => prev.filter((a) => a !== agent));
          setSelectedIdx((prev) => Math.min(prev, Math.max(visible.length - 2, 0)));
          removeFromHistory(cwd, agent.taskId);
        }
      }
    }
  });

  // ── Render nothing when suspended ────────────────────────────────

  if (suspended) return null;

  // ── Derived state ────────────────────────────────────────────────

  const visibleAgents = agents;
  const clampedIdx = Math.min(selectedIdx, Math.max(visibleAgents.length - 1, 0));
  const activeCount = visibleAgents.filter(isActive).length;
  const selected = visibleAgents[clampedIdx] || null;
  const preflightOk = preflight?.ok ?? false;

  // Layout: header(1) + divider(1) + list(flex) + [detail] + divider(1) + input(1) + footer(1)
  const chromeHeight = 5; // header + top divider + bottom divider + input + footer
  const detailHeight = logExpanded && selected ? Math.min(MAX_VISIBLE_LOGS + 1, 6) : 0;
  const listHeight = Math.max(termHeight - chromeHeight - detailHeight, 3);
  const maxVisibleEntries = Math.max(Math.floor(listHeight / ENTRY_ROWS), 1);

  // Row fixed overhead: paddingX(2) + pointer(1) + icon(1) + time(5) + gaps(4) = 13
  // +3 for PR badge (emoji 2-wide + gap 1) when present
  const rowOverhead = 13;

  // ── Render ───────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight}>
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold>🦌 deer</Text>
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
        {visibleAgents.length === 0 ? (
          <Box justifyContent="center" paddingY={1}>
            <Text dimColor>Type a prompt below and press Enter to launch an agent</Text>
          </Box>
        ) : (
          visibleAgents.slice(0, maxVisibleEntries).map((agent, i) => {
            const display = STATUS_DISPLAY[agent.status];
            const isSelected = i === clampedIdx && !inputFocused;
            const pointer = isSelected ? "▸" : " ";

            // Gather log lines to show beneath the title
            const recentLogs = agent.logs.slice(-LOG_LINES_PER_ENTRY);

            // Title line: overhead = paddingX(2) + pointer(1) + gap(1) + icon(1) + gap(1) + gap(1) + time(4) = 11
            const titleOverhead = 11;
            const prBadge = agent.result?.prUrl && agent.prState
              ? agent.prState === "open"
                ? { icon: "🟢", color: "green" }
                : agent.prState === "merged"
                  ? { icon: "🟣", color: "magenta" }
                  : { icon: "🔴", color: "red" }
              : null;
            const titleWidth = Math.max(termWidth - titleOverhead - (prBadge ? 3 : 0), 5);
            // Log line: paddingX(2) + indent(3) = 5
            const logWidth = Math.max(termWidth - 5, 5);

            return (
              <Box key={agent.id} flexDirection="column">
                {/* Title line */}
                <Box gap={1}>
                  <Text dimColor={!isSelected}>{pointer}</Text>
                  {agent.status === "running" && agent.needsAttention ? (
                    <Text>👋</Text>
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
        // Reserve lines for fixed elements: 1 divider + optional PR + optional error
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
              <Text
                color={selected.prState === "merged" ? "magenta" : selected.prState === "closed" ? "red" : "green"}
                bold
              >
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
          <TextInput
            key={inputKey}
            placeholder={preflightOk ? "type prompt and press enter to launch agent" : "preflight checks failed"}
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
            <Text dimColor>j/k nav</Text>
            <Text dimColor>⏎ attach/open</Text>
            <Text dimColor>c continue</Text>
            <Text dimColor>s shell</Text>
            <Text dimColor>x kill</Text>
            <Text dimColor>⌫ delete</Text>
            <Text dimColor>l logs</Text>
            <Text dimColor>q quit</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
