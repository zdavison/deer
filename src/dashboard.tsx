import { Box, Text, useInput, useApp, useStdout } from "ink";
import { Spinner } from "@inkjs/ui";
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { generateTaskId, transcriptsDir, loadHistory, upsertHistory, removeFromHistory } from "./task";
import type { PersistedTask } from "./task";
import { loadConfig } from "./config";
import type { DeerConfig } from "./config";
import { transition, availableActions, resolveKeypress, ACTION_BINDINGS } from "./state-machine";
import type { AgentState as AgentStatus } from "./state-machine";

// The Docker Sandbox proxy reads ANTHROPIC_API_KEY from the host process env
// on every `docker sandbox exec` call and injects it into API requests,
// overriding OAuth auth. Remove it from the process so child processes
// (especially docker sandbox exec) never inherit it.
delete process.env.ANTHROPIC_API_KEY;

// ── Types ────────────────────────────────────────────────────────────

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

/** @internal Exported for testing */
export interface AgentState {
  id: number;
  /** Persistent task ID (deer_xxx format) for history storage */
  taskId: string;
  prompt: string;
  status: AgentStatus;
  /** Elapsed seconds */
  elapsed: number;
  /** Last activity from tmux pane capture */
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
  /** Running process handle (or tmux kill handle) */
  proc: { kill(): void } | null;
  /** Timer handle */
  timer: ReturnType<typeof setInterval> | null;
  /** PR state on GitHub: null = unchecked, "open" = open, "merged" = merged, "closed" = closed */
  prState: "open" | "merged" | "closed" | null;
  /** Agent is waiting for user input (e.g. AskUserQuestion tool) */
  needsAttention: boolean;
  /** Human-readable conversation transcript (terminal output lines) */
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
/** Base rows per entry: title + log lines. Entries with a PR URL add 1 more row. */
const ENTRY_ROWS_BASE = 1 + LOG_LINES_PER_ENTRY;
const ENTRY_ROWS_WITH_PR = ENTRY_ROWS_BASE + 1;
const MODEL = "sonnet";
const PR_MERGE_CHECK_INTERVAL_MS = 60_000;

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

/** Suspend the ink alternate screen, run fn, then restore. */
async function withSuspendedTerminal(
  setSuspended: (v: boolean) => void,
  fn: () => Promise<void>,
): Promise<void> {
  setSuspended(true);
  process.stdout.write("\x1b[?1049l");
  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  try {
    await fn();
  } finally {
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    setSuspended(false);
  }
}

/** Spawn a bash script, check exit code, parse JSON from last stdout line. */
async function runScriptJson<T>(args: string[], cwd: string): Promise<T> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Script failed (exit ${code}): ${stderr.trim().split("\n").pop()}`);
  }
  const stdout = await new Response(proc.stdout).text();
  const lines = stdout.trim().split("\n").filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  if (!jsonLine) throw new Error("Script produced no output");
  return JSON.parse(jsonLine) as T;
}

/** Spawn claude -p inside a docker sandbox with OAuth env. */
function spawnClaudeInSandbox(meta: SandboxMeta, promptPath: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([
    "docker", "sandbox", "exec", "--privileged", meta.sandboxName,
    "env", "-u", "ANTHROPIC_API_KEY",
    `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
    "sh", "-c",
    `cd ${meta.worktreePath} && cat ${promptPath} | claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model ${MODEL}`,
  ], { stdout: "pipe", stderr: "pipe" });
}

function prStateColor(state: "open" | "merged" | "closed" | null): string {
  if (state === "merged") return "magenta";
  if (state === "closed") return "red";
  return "green";
}

/** Factory for AgentState with sensible defaults. */
export function createAgentState(overrides: Partial<AgentState>): AgentState {
  return {
    id: 0,
    taskId: "",
    prompt: "",
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
    needsAttention: false,
    transcript: [],
    transcriptPath: null,
    historical: false,
    ...overrides,
  };
}

/** Strip ANSI escape sequences from terminal output */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** Check if the deer tmux pane's command has exited */
async function isTmuxPaneDead(sandboxName: string): Promise<boolean> {
  const proc = Bun.spawn([
    "docker", "sandbox", "exec", sandboxName,
    "tmux", "list-panes", "-t", "deer", "-F", "#{pane_dead}",
  ], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) return true; // session gone = dead
  const result = (await new Response(proc.stdout).text()).trim();
  return result === "1";
}

/** Capture tmux pane content. Returns lines or null if session doesn't exist. */
async function captureTmuxPane(
  sandboxName: string,
  fullScrollback = false,
): Promise<string[] | null> {
  const args = ["docker", "sandbox", "exec", sandboxName,
    "tmux", "capture-pane", "-t", "deer", "-p"];
  if (fullScrollback) args.push("-S", "-");

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) return null;
  const text = await new Response(proc.stdout).text();
  return text.split("\n");
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

async function setupAgent(
  cwd: string,
  agent: AgentState,
  setAgents: (updater: (prev: AgentState[]) => AgentState[]) => void,
  baseBranch?: string,
): Promise<SandboxMeta> {
  const args = ["bash", join(SCRIPTS_DIR, "setup-sandbox.sh"), cwd, MODEL];
  if (baseBranch) args.push(baseBranch);

  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });

  // Stream stderr lines into agent logs in real-time
  const stderrStream = proc.stderr as ReadableStream;
  const reader = stderrStream.getReader();
  const decoder = new TextDecoder();
  let stderrBuf = "";

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrBuf += decoder.decode(value, { stream: true });
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop()!;
        for (const raw of lines) {
          const line = stripAnsi(raw).trim();
          if (line) {
            appendLog(agent, `[setup] ${line}`);
            agent.lastActivity = truncate(line, 120);
            setAgents((prev) => [...prev]);
          }
        }
      }
      // Flush remaining
      const last = stripAnsi(stderrBuf).trim();
      if (last) {
        appendLog(agent, `[setup] ${last}`);
        agent.lastActivity = truncate(last, 120);
        setAgents((prev) => [...prev]);
      }
    } catch { /* stream closed */ }
  })();

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Setup failed (exit ${code})`);
  }
  const stdout = await new Response(proc.stdout).text();
  const jsonLines = stdout.trim().split("\n").filter(Boolean);
  const jsonLine = jsonLines[jsonLines.length - 1];
  if (!jsonLine) throw new Error("Setup script produced no output");
  return JSON.parse(jsonLine) as SandboxMeta;
}

/**
 * Apply a deny-by-default network policy to the sandbox, allowing only the
 * domains in the config allowlist. Called after sandbox creation but before
 * the agent starts, so tmux/apt installs during setup are unaffected.
 */
/** Domains that must bypass the MITM proxy so OAuth credentials pass through
 *  unmodified. The `claude` sandbox template's proxy intercepts these and
 *  injects the host's ANTHROPIC_API_KEY, overriding CLAUDE_CODE_OAUTH_TOKEN. */
const PROXY_BYPASS_HOSTS = [
  "api.anthropic.com",
  "claude.ai",
  "statsig.anthropic.com",
  "sentry.io",
];

async function applyNetworkPolicy(sandboxName: string, allowlist: string[]): Promise<void> {
  const args = [
    "docker", "sandbox", "network", "proxy", sandboxName,
    "--policy", "deny",
    ...allowlist.flatMap((host) => ["--allow-host", host]),
    ...PROXY_BYPASS_HOSTS.flatMap((host) => ["--bypass-host", host]),
  ];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Network policy failed (exit ${code}): ${stderr.trim()}`);
  }
}

/**
 * Start Claude inside a tmux session in the sandbox.
 * Writes a launcher script to deerTmpDir (bind-mounted into the sandbox)
 * that bakes in the OAuth token and unsets ANTHROPIC_API_KEY. The script
 * runs as tmux's initial command, so when Claude exits the pane dies
 * (remain-on-exit preserves content for scrollback capture).
 *
 * A script file avoids fragile quoting through multiple shell layers
 * (TypeScript → docker exec → sh → tmux send-keys → tmux shell).
 */
async function startClaudeInTmux(meta: SandboxMeta, prompt: string): Promise<void> {
  const promptPath = join(meta.deerTmpDir, ".agent-prompt");
  await Bun.write(promptPath, prompt);

  // Write launcher script — runs as tmux session's initial command.
  // The token is written directly into the file, avoiding send-keys quoting.
  // deerTmpDir is inside GIT_DIR which is bind-mounted into the sandbox.
  const launcherPath = join(meta.deerTmpDir, ".agent-launcher.sh");
  await Bun.write(launcherPath, [
    `#!/bin/sh`,
    `unset ANTHROPIC_API_KEY`,
    `export CLAUDE_CODE_OAUTH_TOKEN='${process.env.CLAUDE_CODE_OAUTH_TOKEN}'`,
    `cd "${meta.worktreePath}"`,
    `cat "${meta.deerTmpDir}/.agent-prompt" | claude -p --verbose --dangerously-skip-permissions --model ${MODEL}`,
  ].join("\n") + "\n");

  const script = [
    `export PATH="$PATH:/usr/bin:/usr/local/bin:/bin"`,
    `export TERM=xterm-256color`,
    `chmod +x ${launcherPath}`,
    `tmux new-session -d -s deer "sh ${launcherPath}"`,
    `tmux set -t deer remain-on-exit on`,
  ].join(" && ");

  const proc = Bun.spawn([
    "docker", "sandbox", "exec", "--privileged", meta.sandboxName,
    "sh", "-c", script,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to start Claude in tmux: ${stderr.trim()}`);
  }
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

  // Collect the diff so the metadata prompt is self-contained (no --continue needed)
  const diffProc = Bun.spawn(["git", "-C", worktreePath, "diff", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  let diff = await new Response(diffProc.stdout).text();
  await diffProc.exited;

  // If nothing is unstaged, get the diff against the parent commit instead
  if (!diff.trim()) {
    const logProc = Bun.spawn(["git", "-C", worktreePath, "diff", "HEAD~1..HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    diff = await new Response(logProc.stdout).text();
    await logProc.exited;
  }

  // Truncate very large diffs to avoid blowing up the context window
  const MAX_DIFF_CHARS = 80_000;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + "\n\n... (diff truncated)";
  }

  const prSection = prTemplate
    ? `A pull request description following this template:\n\n<pr-template>\n${prTemplate}\n</pr-template>`
    : `A pull request description with a summary of the changes.`;

  return [
    "Below is the git diff of changes made by an automated agent. Based on this diff, write these three files:",
    "",
    `1. \`${deerTmpDir}/.agent-branch-name\``,
    "   A short kebab-case name for a git branch describing the changes.",
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
    "",
    "<diff>",
    diff,
    "</diff>",
  ].join("\n");
}

/**
 * Run a follow-up `claude -p` to extract metadata (branch name,
 * commit message, PR body) after the main task finishes. The prompt
 * includes the git diff so it's self-contained.
 *
 * Non-fatal — if this fails or times out, teardown has fallbacks.
 */
async function startClaudeMetadata(meta: SandboxMeta, agent: AgentState): Promise<void> {
  const prompt = await buildMetadataPrompt(meta.worktreePath, meta.deerTmpDir);
  const promptPath = join(meta.deerTmpDir, ".agent-metadata-prompt");
  await Bun.write(promptPath, prompt);

  const proc = spawnClaudeInSandbox(meta, `${meta.deerTmpDir}/.agent-metadata-prompt`);

  // Drain stdout/stderr to prevent backpressure
  const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
  const stderrPromise = new Response(proc.stderr as ReadableStream).text();

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
        const stderr = await stderrPromise;
        if (stderr.trim()) appendLog(agent, `[metadata stderr] ${stderr.trim()}`);
        if (code !== 0) {
          const hint = stderr.trim().split("\n").pop() || "";
          throw new Error(`Metadata extraction exited with code ${code}${hint ? `: ${hint}` : ""}`);
        }
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

async function teardownAgent(meta: SandboxMeta, cwd: string): Promise<TeardownResult> {
  return runScriptJson<TeardownResult>([
    "bash", join(SCRIPTS_DIR, "teardown-sandbox.sh"),
    cwd, meta.worktreePath, meta.sandboxName, meta.tempBranch, meta.baseBranch, meta.model, meta.deerTmpDir,
  ], cwd);
}

/** Like teardownAgent but captures stderr lines into agent logs. */
async function teardownAgentWithLogs(meta: SandboxMeta, cwd: string, agent: AgentState): Promise<TeardownResult> {
  const proc = Bun.spawn([
    "bash", join(SCRIPTS_DIR, "teardown-sandbox.sh"),
    cwd, meta.worktreePath, meta.sandboxName, meta.tempBranch, meta.baseBranch, meta.model, meta.deerTmpDir,
  ], { cwd, stdout: "pipe", stderr: "pipe" });

  const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
  const stderrPromise = new Response(proc.stderr as ReadableStream).text();

  const code = await proc.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  // Surface the script's progress messages into agent logs
  for (const line of stderr.trim().split("\n").filter(Boolean)) {
    appendLog(agent, `[teardown] ${stripAnsi(line).trim()}`);
  }

  if (code !== 0) {
    throw new Error(`Teardown failed (exit ${code}): ${stderr.trim().split("\n").pop()}`);
  }

  const lines = stdout.trim().split("\n").filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  if (!jsonLine) throw new Error("Teardown script produced no output");
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

  // Kill the dead tmux session left over from the main Claude run
  // (remain-on-exit keeps it alive). Cleaning up avoids stale lock files
  // or session state that could interfere with the metadata invocation.
  try {
    await Bun.spawn([
      "docker", "sandbox", "exec", agent.meta.sandboxName,
      "tmux", "kill-session", "-t", "deer",
    ], { stdout: "pipe", stderr: "pipe" }).exited;
  } catch { /* ignore */ }

  // Check if Claude wrote any code
  const statusProc = Bun.spawn(
    ["git", "-C", agent.meta.worktreePath, "status", "--porcelain"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const statusOut = await new Response(statusProc.stdout).text();
  await statusProc.exited;
  const changeCount = statusOut.trim().split("\n").filter(Boolean).length;
  appendLog(agent, `[teardown] ${changeCount} file(s) changed in worktree`);

  // Metadata extraction (non-fatal)
  agent.lastActivity = "Generating PR metadata...";
  setAgents((prev) => [...prev]);

  try {
    await startClaudeMetadata(agent.meta, agent);
  } catch (err) {
    appendLog(agent, `[warn] Metadata extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Teardown
  agent.status = transition(agent.status, "TEARDOWN_START") ?? agent.status;
  agent.lastActivity = "Committing and creating PR...";
  setAgents((prev) => [...prev]);

  try {
    agent.result = await teardownAgentWithLogs(agent.meta, cwd, agent);
    agent.status = transition(agent.status, "TEARDOWN_COMPLETE") ?? agent.status;

    if (agent.result.prUrl) {
      agent.lastActivity = "PR ready";
    } else if (agent.transcript.length > 0) {
      agent.transcriptPath = await persistTranscript(agent);
      agent.lastActivity = "Answer ready — Enter to continue";
    } else {
      agent.lastActivity = "No changes";
    }
  } catch (err) {
    agent.status = transition(agent.status, "ERROR") ?? "failed";
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

/** @internal Exported for testing */
export function parseNdjsonLine(line: string, agent: AgentState): boolean {
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
    finalBranch: agent.result?.finalBranch ?? null,
    error: agent.error || null,
    transcriptPath: agent.transcriptPath,
    lastActivity: agent.lastActivity,
  };
  await upsertHistory(repoPath, task);
}

/** Convert a persisted task to a read-only AgentState for display. */
function historicalAgent(task: PersistedTask, id: number): AgentState {
  const wasInterrupted = task.status === "running";
  return createAgentState({
    id,
    taskId: task.taskId,
    prompt: task.prompt,
    status: wasInterrupted ? "interrupted" : task.status,
    elapsed: task.elapsed,
    lastActivity: wasInterrupted ? "Interrupted — deer was closed" : task.lastActivity,
    result: task.prUrl ? { finalBranch: task.finalBranch ?? "", prUrl: task.prUrl } : null,
    error: task.error || "",
    transcriptPath: task.transcriptPath,
    historical: true,
  });
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
          const newValue = value.slice(0, cursorOffset) + "\n" + value.slice(cursorOffset);
          setValue(newValue);
          setCursorOffset((prev) => prev + 1);
        } else {
          onSubmit?.(value);
        }
        return;
      }

      if (key.leftArrow) {
        setCursorOffset((prev) => Math.max(0, prev - 1));
      } else if (key.rightArrow) {
        setCursorOffset((prev) => Math.min(value.length, prev + 1));
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          const newValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          setValue(newValue);
          setCursorOffset((prev) => prev - 1);
        }
      } else if (input) {
        const newValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        setValue(newValue);
        setCursorOffset((prev) => prev + 1);
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
  /** When set, the next prompt submission spawns an agent off this branch instead of the current branch. */
  const [continueBranch, setContinueBranch] = useState<string | null>(null);

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

      const results = await Promise.all(
        toCheck.map((agent) => checkPrState(agent.result!.prUrl)),
      );
      let changed = false;
      for (let i = 0; i < toCheck.length; i++) {
        const state = results[i];
        if (state !== null && state !== toCheck[i].prState) {
          toCheck[i].prState = state;
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

  const spawnAgent = useCallback(async (prompt: string, baseBranch?: string) => {
    if (!prompt.trim()) return;
    if (preflight && !preflight.ok) return;

    const id = nextId.current++;
    const agent = createAgentState({
      id,
      taskId: generateTaskId(),
      prompt: prompt.trim(),
    });

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
      finalBranch: null,
      error: null,
      transcriptPath: null,
      lastActivity: "",
    });

    try {
      // Phase 1: Setup
      agent.meta = await setupAgent(cwd, agent, setAgents, baseBranch);

      // Phase 1.5: Lock down network — deny all, allow only the configured list.
      // Applied after setup (tmux/apt installs are done) but before the agent runs.
      const allowlist = configRef.current?.network.allowlist ?? [];
      await applyNetworkPolicy(agent.meta.sandboxName, allowlist);
      appendLog(agent, `[setup] Network policy applied`);

      agent.status = transition(agent.status, "SETUP_COMPLETE") ?? agent.status;
      setAgents((prev) => [...prev]);

      // Phase 2: Run Claude in tmux
      await startClaudeInTmux(agent.meta, prompt.trim());
      appendLog(agent, `[tmux] Claude session started`);

      // Kill handle: killing the tmux session stops Claude
      agent.proc = {
        kill() {
          if (!agent.meta) return;
          Bun.spawn([
            "docker", "sandbox", "exec", agent.meta.sandboxName,
            "tmux", "kill-session", "-t", "deer",
          ], { stdout: "pipe", stderr: "pipe" });
        },
      };
      setAgents((prev) => [...prev]);

      // Poll tmux pane for status updates
      const POLL_MS = 3_000;
      while (true) {
        await Bun.sleep(POLL_MS);
        if ((agent.status as AgentStatus) === "cancelled") return;
        if (!agent.meta) break;

        const dead = await isTmuxPaneDead(agent.meta.sandboxName);
        if (dead) {
          appendLog(agent, `[tmux] Claude process exited`);
          break;
        }

        // Capture visible pane content for lastActivity
        const lines = await captureTmuxPane(agent.meta.sandboxName);
        if (lines) {
          const lastLine = lines
            .map(stripAnsi)
            .map((l) => l.trim())
            .filter(Boolean)
            .pop();
          if (lastLine) {
            agent.lastActivity = truncate(lastLine, 120);
            appendLog(agent, `[tmux] ${truncate(lastLine, 200)}`);
            setAgents((prev) => [...prev]);
          }
        }
      }

      if ((agent.status as AgentStatus) === "cancelled") return;

      // Capture full scrollback as transcript
      if (agent.meta) {
        const scrollback = await captureTmuxPane(agent.meta.sandboxName, true);
        if (scrollback) {
          const cleaned = scrollback.map(stripAnsi).filter((l) => l.trim());
          appendLog(agent, `[tmux] Captured ${cleaned.length} lines of scrollback`);

          // If Claude exited almost immediately, log the output for debugging
          if (cleaned.length <= 10) {
            for (const line of cleaned) {
              appendLog(agent, `[tmux:out] ${line}`);
            }
          }

          agent.transcript = cleaned;

          // Check if agent is waiting for human input
          if (await needsHumanInput(cleaned)) {
            agent.needsAttention = true;
            agent.lastActivity = "Needs input — Enter to assist";
            agent.proc = null;
            setAgents((prev) => [...prev]);
            return;
          }
        }
      }

      // Metadata extraction + teardown
      await finalizeAgent(agent, cwd, setAgents);
    } catch (err) {
      if (agent.status !== "cancelled") {
        agent.status = transition(agent.status, "ERROR") ?? "failed";
        agent.error = err instanceof Error ? err.message : String(err);
        agent.lastActivity = truncate(agent.error, 120);
        await saveToHistory(agent, cwd);
      }
    } finally {
      if (!agent.needsAttention) {
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
    agent.status = transition(agent.status, "USER_KILL") ?? "cancelled";
    agent.lastActivity = "Cancelled by user";
    cleanupAgent(agent, cwd);
    saveToHistory(agent, cwd);
    setAgents((prev) => [...prev]);
  }, [cwd]);

  // ── Shell into agent ─────────────────────────────────────────────

  const shellIntoAgent = useCallback(async (agent: AgentState) => {
    if (!agent.meta) return;

    await withSuspendedTerminal(setSuspended, async () => {
      const tmuxScript = [
        `export PATH="$PATH:/usr/bin:/usr/local/bin:/bin"`,
        `export TERM=xterm-256color`,
        `if ! command -v tmux >/dev/null 2>&1; then`,
        `  echo "ERROR: tmux is not installed in the sandbox. Shell requires tmux." >&2`,
        `  exit 1`,
        `fi`,
        `if ! tmux has-session -t deer-shell 2>/dev/null; then`,
        `  tmux new-session -d -s deer-shell -c ${agent.meta!.worktreePath}`,
        `fi`,
        `tmux set -t deer-shell status on`,
        `tmux set -t deer-shell status-position bottom`,
        `tmux set -t deer-shell status-style '#{?client_prefix,bg=#fab387 fg=#1e1e2e,bg=#313244 fg=#cdd6f4}'`,
        `tmux set -t deer-shell status-left '#{?client_prefix, PREFIX: d=detach (return to deer) , Ctrl+b d=detach (return to deer) }'`,
        `tmux set -t deer-shell status-left-length 55`,
        `tmux set -t deer-shell status-right ''`,
        `tmux set -t deer-shell focus-events off`,
        `tmux attach -t deer-shell`,
      ].join("\n");

      const proc = Bun.spawn([
        "docker", "sandbox", "exec", "-it", agent.meta!.sandboxName,
        "sh", "-c", tmuxScript,
      ], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      await proc.exited;
    });
  }, []);

  // ── Open transcript in editor ───────────────────────────────────

  const openInEditor = useCallback(async (filePath: string) => {
    const editor = process.env.EDITOR || "vim";
    await withSuspendedTerminal(setSuspended, async () => {
      const proc = Bun.spawn([editor, filePath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
    });
  }, []);

  // ── Continue: focus input to spawn a new agent off a PR branch ───

  const continuePr = useCallback((agent: AgentState) => {
    if (!agent.result?.finalBranch) return;
    setContinueBranch(agent.result.finalBranch);
    setInputFocused(true);
    setInputKey((k) => k + 1);
  }, []);

  // ── Attach to running agent (interactive Claude session) ────────

  const attachToAgent = useCallback(async (agent: AgentState) => {
    if (!agent.meta || agent.status !== "running") return;

    agent.needsAttention = false;

    await withSuspendedTerminal(setSuspended, async () => {
      const tmuxScript = [
        `export PATH="$PATH:/usr/bin:/usr/local/bin:/bin"`,
        `export TERM=xterm-256color`,
        `tmux set -t deer status on`,
        `tmux set -t deer status-position bottom`,
        `tmux set -t deer status-style '#{?client_prefix,bg=#fab387 fg=#1e1e2e,bg=#313244 fg=#cdd6f4}'`,
        `tmux set -t deer status-left '#{?client_prefix, PREFIX: d=detach | [=scroll (q exits) , Ctrl+b d=detach | Ctrl+b [=scroll (q exits) }'`,
        `tmux set -t deer status-left-length 80`,
        `tmux set -t deer status-right ''`,
        `tmux set -t deer focus-events off`,
        `tmux attach -t deer`,
      ].join("\n");

      const attachProc = Bun.spawn([
        "docker", "sandbox", "exec", "-it", agent.meta!.sandboxName,
        "env", "-u", "ANTHROPIC_API_KEY",
        `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
        "sh", "-c", tmuxScript,
      ], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await attachProc.exited;
    });

    // Update lastActivity from current pane content after detach
    if (agent.meta && agent.status === "running") {
      const lines = await captureTmuxPane(agent.meta.sandboxName);
      if (lines) {
        const lastLine = lines.map(stripAnsi).map((l) => l.trim()).filter(Boolean).pop();
        if (lastLine) {
          agent.lastActivity = truncate(lastLine, 120);
        }
      }
      setAgents((prev) => [...prev]);
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

    // Escape cancels continue-branch mode
    if (key.escape && continueBranch) {
      setContinueBranch(null);
      return;
    }

    // Tab to toggle focus
    if (key.tab) {
      if (continueBranch && inputFocused) setContinueBranch(null);
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
          hasFinalBranch: !!agent.result?.finalBranch,
          hasMeta: !!agent.meta,
          prState: agent.prState,
        };
        const actions = availableActions(ctx);
        const action = resolveKeypress(input, key, actions);

        switch (action) {
          case "attach":
            attachToAgent(agent);
            break;
          case "open_pr":
            if (agent.result?.prUrl) openUrl(agent.result.prUrl);
            break;
          case "shell":
            shellIntoAgent(agent);
            break;
          case "continue_pr":
            continuePr(agent);
            break;
          case "kill":
            killAgent(agent);
            break;
          case "delete":
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

  // ── Render nothing when suspended ────────────────────────────────

  if (suspended) return null;

  // ── Derived state ────────────────────────────────────────────────

  const clampedIdx = Math.min(selectedIdx, Math.max(agents.length - 1, 0));
  const activeCount = agents.filter(isActive).length;
  const selected = agents[clampedIdx] || null;
  const preflightOk = preflight?.ok ?? false;

  // Layout: header(1) + divider(1) + list(flex) + [detail] + divider(1) + input(1) + footer(1)
  const chromeHeight = 5; // header + top divider + bottom divider + input + footer
  const detailHeight = logExpanded && selected ? Math.min(MAX_VISIBLE_LOGS + 1, 6) : 0;
  const listHeight = Math.max(termHeight - chromeHeight - detailHeight, 3);
  // Use the larger row size to ensure we don't overflow the list area
  const hasPrEntries = agents.some((a) => a.result?.prUrl);
  const entryRows = hasPrEntries ? ENTRY_ROWS_WITH_PR : ENTRY_ROWS_BASE;
  const maxVisibleEntries = Math.max(Math.floor(listHeight / entryRows), 1);

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
        {agents.length === 0 ? (
          <Box justifyContent="center" paddingY={1}>
            <Text dimColor>Type a prompt below and press Enter to launch an agent</Text>
          </Box>
        ) : (
          agents.slice(0, maxVisibleEntries).map((agent, i) => {
            const display = STATUS_DISPLAY[agent.status];
            const isSelected = i === clampedIdx && !inputFocused;
            const pointer = isSelected ? "▸" : " ";

            // Gather log lines to show beneath the title
            const recentLogs = agent.logs.slice(-LOG_LINES_PER_ENTRY);

            // Title line: overhead = paddingX(2) + pointer(1) + gap(1) + icon(1) + gap(1) + gap(1) + time(4) = 11
            const titleOverhead = 11;
            const prBadge = agent.result?.prUrl && agent.prState
              ? {
                  icon: agent.prState === "merged" ? "🟣" : agent.prState === "closed" ? "🔴" : "🟢",
                  color: prStateColor(agent.prState),
                }
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
                color={prStateColor(selected.prState)}
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
          <PromptInput
            key={inputKey}
            placeholder={!preflightOk ? "preflight checks failed" : continueBranch ? `prompt for ${continueBranch} (Esc to cancel)` : "type prompt and press Enter to launch agent (Shift+Enter for newline)"}
            isDisabled={!preflightOk}
            defaultValue={inputDefault}
            onSubmit={(value) => {
              if (value.trim()) {
                setPromptHistory((prev) => [...prev, value.trim()]);
                setHistoryIdx(-1);
                setInputDefault("");
                setInputKey((k) => k + 1);
                const branch = continueBranch;
                setContinueBranch(null);
                spawnAgent(value, branch ?? undefined);
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
                  hasFinalBranch: !!selected.result?.finalBranch,
                  hasMeta: !!selected.meta,
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
