/**
 * Agent lifecycle: worktree → sandbox → poll → finalize.
 *
 * Each agent runs Claude Code interactively inside an SRT sandbox
 * within a tmux session. The user can attach at any time via tmux.
 */

import { join, dirname, resolve } from "node:path";
import { createWorktree, removeWorktree } from "./git/worktree";
import { cleanupWorktree } from "./git/finalize";
import { launchSandbox, captureTmuxPane } from "./sandbox/index";
import type { SandboxSession, SandboxRuntime } from "./sandbox/index";
import { generateTaskId, dataDir } from "./task";
import type { DeerConfig, ProxyCredential } from "./config";
import { detectLang } from "./i18n";
import {
  DEFAULT_MODEL,
  BYPASS_DIALOG_MAX_POLLS,
  BYPASS_DIALOG_POLL_MS,
  BYPASS_DIALOG_KEY_DELAY_MS,
} from "./constants";

// ── Types ────────────────────────────────────────────────────────────

export interface AgentHandle {
  taskId: string;
  sessionName: string;
  worktreePath: string;
  branch: string;
  /** Kill the agent (stop sandbox, but don't clean up worktree) */
  kill: () => Promise<void>;
}

export interface ContinueSession {
  /** Task ID of the existing session to resume */
  taskId: string;
  /** Path to the existing worktree */
  worktreePath: string;
  /** Branch of the existing worktree */
  branch: string;
}

export interface AgentRunOptions {
  /** Path to the repository root */
  repoPath: string;
  /** The user's prompt / task description */
  prompt: string;
  /** Branch to base the worktree on */
  baseBranch: string;
  /** Loaded deer config (for network allowlist, env, etc.) */
  config: DeerConfig;
  /** Override the model (default: "sonnet") */
  model?: string;
  /** Sandbox runtime to use for isolation */
  runtime: SandboxRuntime;
  /** Callback for status updates */
  onStatus?: (status: AgentStatus) => void;
  /**
   * Pre-generated task ID. If not provided, one is generated internally.
   * Pass this when you need to know the taskId before `startAgent` resolves.
   */
  taskId?: string;
  /**
   * If provided, resume an existing Claude conversation instead of starting
   * a fresh one. The worktree and branch are reused; `--continue` is passed
   * to Claude instead of the prompt.
   */
  continueSession?: ContinueSession;
  /** Callback for auth proxy log messages (shown in the TUI log panel) */
  onProxyLog?: (message: string) => void;
}

export type AgentStatus =
  | { phase: "setup"; message: string }
  | { phase: "running"; sessionName: string }
  | { phase: "failed"; error: string }
  | { phase: "cancelled" };

// ── Constants ────────────────────────────────────────────────────────

/**
 * Build an env object containing only the vars from the passthrough list.
 * Vars not set in the host environment are omitted.
 *
 * Credentials handled by proxyCredentials are NOT included here — they stay
 * on the host and are injected by the auth proxy.
 */
function buildPassthroughEnv(passthrough: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of passthrough) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * Resolve proxy credentials from config: read host env vars, build upstream
 * definitions with concrete header values.
 *
 * When multiple credentials target the same domain (e.g. OAuth vs API key
 * for Anthropic), the first one whose env var is set wins.
 *
 * Returns upstreams (for the MITM proxy), sandbox env vars, and placeholder
 * env vars that make the sandboxed tool enter the right auth mode.
 */
export function resolveProxyUpstreams(
  credentials: ProxyCredential[],
): {
  upstreams: import("./sandbox/auth-proxy").ProxyUpstream[];
  sandboxEnv: Record<string, string>;
  placeholderEnv: Record<string, string>;
} {
  const upstreams: import("./sandbox/auth-proxy").ProxyUpstream[] = [];
  const sandboxEnv: Record<string, string> = {};
  const placeholderEnv: Record<string, string> = {};
  const claimedDomains = new Set<string>();

  for (const cred of credentials) {
    // Only one credential per domain — first match wins (e.g. OAuth before API key)
    if (claimedDomains.has(cred.domain)) continue;

    const value = process.env[cred.hostEnv.key];
    if (!value) continue;

    // Build concrete headers from templates
    const headers: Record<string, string> = {};
    for (const [hdr, tmpl] of Object.entries(cred.headerTemplate)) {
      headers[hdr] = tmpl.replace("${value}", value);
    }

    upstreams.push({
      domain: cred.domain,
      target: cred.target,
      headers,
    });

    sandboxEnv[cred.sandboxEnv.key] = cred.sandboxEnv.value;
    placeholderEnv[cred.hostEnv.key] = "proxy-managed";
    claimedDomains.add(cred.domain);
  }

  return { upstreams, sandboxEnv, placeholderEnv };
}

/**
 * Poll the tmux pane for the bypass permissions confirmation dialog
 * and dismiss it by selecting "Yes, I accept".
 */
async function dismissBypassDialog(sessionName: string): Promise<void> {
  for (let i = 0; i < BYPASS_DIALOG_MAX_POLLS; i++) {
    await Bun.sleep(BYPASS_DIALOG_POLL_MS);
    const pane = await captureTmuxPane(sessionName);
    if (!pane) return;
    const text = pane.join("\n");
    if (text.includes("Yes, I accept")) {
      // Send Down and Enter separately with a delay to avoid the race
      // where Enter confirms option 1 before Down moves to option 2.
      await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "Down"], {
        stdout: "pipe", stderr: "pipe",
      }).exited;
      await Bun.sleep(BYPASS_DIALOG_KEY_DELAY_MS);
      await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "Enter"], {
        stdout: "pipe", stderr: "pipe",
      }).exited;
      return;
    }
    // Claude started without the dialog
    if (text.includes("$") || text.includes("❯") || text.includes("Claude")) {
      if (!text.includes("Bypass Permissions")) return;
    }
  }
}

// ── Agent Lifecycle ──────────────────────────────────────────────────

/**
 * Start an agent: create worktree, launch sandbox, return handle.
 *
 * The agent runs Claude Code interactively in a tmux session.
 * Poll `isTmuxSessionDead` to detect when the agent finishes,
 * or use the handle to kill it / attach to it.
 */
export async function startAgent(options: AgentRunOptions): Promise<AgentHandle> {
  const {
    repoPath,
    prompt,
    baseBranch,
    config,
    model = DEFAULT_MODEL,
    runtime,
    onStatus,
    continueSession,
    onProxyLog,
  } = options;

  const taskId = options.taskId ?? continueSession?.taskId ?? generateTaskId();
  const sessionName = `deer-${taskId}`;

  let worktreePath: string;
  let branch: string;

  if (continueSession) {
    worktreePath = continueSession.worktreePath;
    branch = continueSession.branch;
    onStatus?.({ phase: "setup", message: "Resuming previous session..." });
  } else {
    onStatus?.({ phase: "setup", message: "Creating worktree..." });

    // Create git worktree
    const worktree = await createWorktree(repoPath, taskId, baseBranch);
    worktreePath = worktree.worktreePath;
    branch = worktree.branch;

    // Configure git in the worktree
    await Bun.$`git -C ${worktreePath} config user.name "deer-agent"`.quiet();
    await Bun.$`git -C ${worktreePath} config user.email "deer@noreply"`.quiet();
  }

  // Run the setup command in the worktree before the sandbox starts.
  // This is the right place for dependency installs (e.g. pnpm install).
  if (!continueSession && config.defaults.setupCommand) {
    onStatus?.({ phase: "setup", message: "Running setup command..." });
    const proc = Bun.spawn(["sh", "-c", config.defaults.setupCommand], {
      cwd: worktreePath,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      await removeWorktree(repoPath, worktreePath).catch(() => {});
      throw new Error(
        `Setup command failed with exit code ${exitCode}: ${config.defaults.setupCommand}`,
      );
    }
  }

  // Write a minimal gitconfig to the task dir so git never reads ~/.gitconfig
  // (which is blocked by the sandbox). GIT_CONFIG_GLOBAL points here instead.
  const gitconfigPath = join(dirname(worktreePath), "gitconfig");
  await Bun.write(
    gitconfigPath,
    [
      "[user]",
      "\tname = deer-agent",
      "\temail = deer@noreply",
      "[init]",
      "\tdefaultBranch = main",
      "[pull]",
      "\trebase = false",
      "[merge]",
      "\tconflictstyle = merge",
      "[safe]",
      "\tdirectory = *",
      "[advice]",
      "\tdetachedHead = false",
      "\tskippedCherryPicks = false",
      "\twaitingForEditor = false",
      "[credential]",
      "\thelper =",
    ].join("\n") + "\n"
  );

  onStatus?.({ phase: "setup", message: "Starting sandbox..." });

  // Resolve credentials → MITM proxy upstreams + sandbox env vars.
  // Credentials stay on the host; the sandbox gets HTTP base URLs that
  // route through SRT's proxy → our MITM proxy → real HTTPS upstream.
  const { startAuthProxy } = await import("./sandbox/auth-proxy");
  const { upstreams, sandboxEnv, placeholderEnv } =
    resolveProxyUpstreams(config.sandbox.proxyCredentials);

  let authProxy: import("./sandbox/auth-proxy").AuthProxy | null = null;
  let mitmProxy: { socketPath: string; domains: string[] } | undefined;
  if (upstreams.length > 0) {
    const socketPath = join(dirname(worktreePath), `deer-auth-${taskId}.sock`);
    authProxy = await startAuthProxy(socketPath, upstreams, onProxyLog);
    mitmProxy = { socketPath: authProxy.socketPath, domains: authProxy.domains };
  }

  // Build the Claude command — interactive mode (no -p) so users can
  // attach to the tmux session and observe/intervene.
  // When continuing, use --continue to resume the previous conversation.
  const claudeCmd = continueSession
    ? ["claude", "--dangerously-skip-permissions", "--model", model, "--continue"]
    : ["claude", "--dangerously-skip-permissions", "--model", model, prompt];

  // Merge passthrough env (non-secret vars), proxy base URLs, and placeholder
  // env vars. Placeholders make the sandboxed tool enter the right auth mode
  // (e.g. CLAUDE_CODE_OAUTH_TOKEN=proxy-managed → OAuth mode) without
  // exposing the real credential. The MITM proxy replaces them before forwarding.
  const lang = detectLang();
  const sandboxEnvFinal = {
    GIT_CONFIG_GLOBAL: gitconfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    ...buildPassthroughEnv(config.sandbox.envPassthrough),
    ...(lang !== "en" ? { CLAUDE_CODE_LOCALE: lang } : {}),
    ...placeholderEnv,
    ...sandboxEnv,
  };

  let sandbox: SandboxSession;
  try {
    sandbox = await launchSandbox({
      sessionName,
      worktreePath,
      repoGitDir: resolve(repoPath, ".git"),
      allowlist: config.network.allowlist,
      env: sandboxEnvFinal,
      mitmProxy,
      command: claudeCmd,
      runtime,
    });
  } catch (err) {
    await authProxy?.close();
    // Only clean up worktree on sandbox failure if we created it
    if (!continueSession) {
      await removeWorktree(repoPath, worktreePath).catch(() => {});
    }
    throw err;
  }

  // Dismiss the --dangerously-skip-permissions confirmation dialog.
  // The dialog defaults to "1. No, exit" — send Down then Enter
  // to select "2. Yes, I accept".
  await dismissBypassDialog(sessionName);

  onStatus?.({ phase: "running", sessionName });

  return {
    taskId,
    sessionName,
    worktreePath,
    branch,
    async kill() {
      await sandbox.stop();
      await authProxy?.close();
    },
  };
}

/**
 * Get the last N lines of tmux output for an agent.
 */
export async function getAgentOutput(
  sessionName: string,
  fullScrollback = false,
): Promise<string[]> {
  const lines = await captureTmuxPane(sessionName, fullScrollback);
  return lines ?? [];
}

/**
 * Full cleanup: kill sandbox, remove worktree and branch.
 */
export async function destroyAgent(
  handle: AgentHandle,
  repoPath: string,
): Promise<void> {
  await handle.kill().catch(() => {});
  await cleanupWorktree(repoPath, handle.worktreePath, handle.branch);
}

/**
 * Delete a task and clean up all associated resources: tmux session,
 * sandbox process, git worktree, branch, and task directory on disk.
 *
 * Works regardless of whether a live handle is available, so it correctly
 * cleans up historical/interrupted tasks that have no active sandbox.
 */
export async function deleteTask(
  taskId: string,
  repoPath: string,
): Promise<void> {
  const worktreePath = join(dataDir(), "tasks", taskId, "worktree");
  const taskDir = join(dataDir(), "tasks", taskId);
  const branch = `deer/${taskId}`;

  // Kill the tmux session by its conventional name
  await Bun.spawn(
    ["tmux", "kill-session", "-t", `deer-${taskId}`],
    { stdout: "pipe", stderr: "pipe" },
  ).exited;

  // Remove the git worktree and branch
  await cleanupWorktree(repoPath, worktreePath, branch);

  // Remove the task directory (worktree subdir is gone; remove parent)
  await Bun.$`rm -rf ${taskDir}`.quiet().nothrow();
}
