/**
 * Prepare a sandboxed Claude session.
 *
 * This is the main entrypoint for deerbox. It handles all the setup:
 * worktree creation, ecosystem detection, gitconfig, auth proxy, and
 * SRT command building. The caller gets back a prepared session with
 * the full command to run and a cleanup function.
 */

import { join, dirname, resolve } from "node:path";
import { createWorktree, checkoutWorktree, removeWorktree, cleanupWorktree } from "./git/worktree";
import { generateTaskId, dataDir } from "./task";
import { loadConfig, type DeerConfig } from "./config";
import { resolveRuntime } from "./sandbox/resolve";
import { detectLang } from "@deer/shared";
import { applyEcosystems } from "./ecosystems";
import { resolveProxyUpstreams } from "./proxy";
import { startAuthProxy, type AuthProxy } from "./sandbox/auth-proxy";
import { DEFAULT_MODEL } from "@deer/shared";

// ── Types ────────────────────────────────────────────────────────────

export interface PrepareOptions {
  /** Path to the repository root */
  repoPath: string;
  /** The user's prompt / task description. If omitted, Claude runs interactively. */
  prompt?: string;
  /** Branch to base the worktree on */
  baseBranch: string;
  /** Loaded config (if already loaded). If omitted, loaded from repoPath. */
  config?: DeerConfig;
  /** Override the model
   * @default "sonnet"
   */
  model?: string;
  /**
   * Pre-generated task ID. If not provided, one is generated internally.
   * Pass this when you need to know the taskId before `prepare` resolves.
   */
  taskId?: string;
  /**
   * If provided, check out this existing branch into the worktree instead
   * of creating a new `deer/<taskId>` branch. Used with `--from` to
   * continue work on an existing branch or PR.
   * @example "feature/auth-fix"
   */
  fromBranch?: string;
  /**
   * If provided, resume an existing session instead of creating a new
   * worktree. The worktree and branch are reused; `--continue` is passed
   * to Claude instead of the prompt.
   */
  continueSession?: {
    taskId: string;
    worktreePath: string;
    branch: string;
  };
  /**
   * If true, daemonize the auth proxy so it survives process exit.
   * The proxy PID is returned in PreparedSession.authProxyPid.
   * @default false
   */
  daemonize?: boolean;
  /**
   * Additional text to append to Claude's system prompt via `--append-system-prompt`.
   * Use this to inject context (e.g. PR review comments) without passing it as a task
   * prompt — Claude receives it as background context and does not act on it immediately.
   */
  appendSystemPrompt?: string;
  /** Callback for status updates during setup */
  onStatus?: (message: string) => void;
  /** Callback for auth proxy log messages */
  onProxyLog?: (message: string) => void;
}

export interface PreparedSession {
  /** Unique task identifier */
  taskId: string;
  /** Path to the git worktree */
  worktreePath: string;
  /** Git branch name (e.g. "deer/<taskId>") */
  branch: string;
  /** Full sandboxed command array ready to exec or wrap in tmux */
  command: string[];
  /** PID of the daemonized auth proxy, or null if no proxy was started */
  authProxyPid: number | null;
  /** Stop the auth proxy (if running). Does NOT remove the worktree. */
  cleanup(): Promise<void>;
  /** Stop the auth proxy AND remove the worktree and branch. */
  destroy(): Promise<void>;
}

// ── Implementation ───────────────────────────────────────────────────

/**
 * Prepare a sandboxed Claude session.
 *
 * Creates a git worktree, detects ecosystems, writes a sandbox gitconfig,
 * starts the MITM auth proxy (if credentials are configured), and builds
 * the full SRT-wrapped command. The caller is responsible for actually
 * running the command (directly, in tmux, etc.).
 */
export async function prepare(options: PrepareOptions): Promise<PreparedSession> {
  const {
    repoPath,
    prompt,
    baseBranch,
    model = DEFAULT_MODEL,
    fromBranch,
    continueSession,
    appendSystemPrompt,
    daemonize = false,
    onStatus,
    onProxyLog,
  } = options;

  const config = options.config ?? await loadConfig(repoPath);
  const runtime = resolveRuntime(config);
  const taskId = options.taskId ?? continueSession?.taskId ?? generateTaskId();

  let worktreePath: string;
  let branch: string;
  let ecosystemResult = { extraReadPaths: [] as string[], env: {} as Record<string, string> };

  if (continueSession) {
    worktreePath = continueSession.worktreePath;
    branch = continueSession.branch;
    onStatus?.("Resuming previous session...");
  } else if (fromBranch) {
    onStatus?.("Checking out branch...");
    const worktree = await checkoutWorktree(repoPath, taskId, fromBranch);
    worktreePath = worktree.worktreePath;
    branch = worktree.branch;

    await Bun.$`git -C ${worktreePath} config user.name "deer-agent"`.quiet();
    await Bun.$`git -C ${worktreePath} config user.email "deer@noreply"`.quiet();

    ecosystemResult = await applyEcosystems(
      repoPath,
      worktreePath,
      config.sandbox.ecosystems?.disabled,
      undefined,
      onStatus,
    );
  } else {
    onStatus?.("Creating worktree...");

    const worktree = await createWorktree(repoPath, taskId, baseBranch);
    worktreePath = worktree.worktreePath;
    branch = worktree.branch;

    // Configure git in the worktree
    await Bun.$`git -C ${worktreePath} config user.name "deer-agent"`.quiet();
    await Bun.$`git -C ${worktreePath} config user.email "deer@noreply"`.quiet();

    ecosystemResult = await applyEcosystems(
      repoPath,
      worktreePath,
      config.sandbox.ecosystems?.disabled,
      undefined,
      onStatus,
    );
  }

  // Run the setup command in the worktree before the sandbox starts
  if (!continueSession && config.defaults.setupCommand) {
    onStatus?.("Running setup command...");
    const proc = Bun.spawn(["sh", "-c", config.defaults.setupCommand], {
      cwd: worktreePath,
      stdout: "pipe",
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

  // Write a minimal gitconfig so git never reads ~/.gitconfig
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
      // Rewrite SSH remotes to HTTPS so git always goes through the HTTP auth
      // proxy. Without this, repos cloned via SSH would bypass the proxy and
      // hit an interactive host-key fingerprint prompt that can't be answered.
      '[url "https://github.com/"]',
      "\tinsteadOf = git@github.com:",
      '\tinsteadOf = ssh://git@github.com/',
    ].join("\n") + "\n",
  );

  onStatus?.("Starting sandbox...");

  // Resolve credentials → MITM proxy
  const { upstreams, sandboxEnv, placeholderEnv } =
    resolveProxyUpstreams(config.sandbox.proxyCredentials);

  // Inject GitHub credentials — resolve the token from the host gh CLI, then
  // add proxy upstreams with tight path filters so the sandbox can only open
  // or update PRs and push branches, not browse arbitrary GitHub content.
  const ghTokenResult = await Bun.$`gh auth token`.quiet().nothrow();
  const ghToken = ghTokenResult.stdout.toString().trim();
  if (ghToken) {
    upstreams.push({
      domain: "api.github.com",
      target: "https://api.github.com",
      headers: { authorization: `Bearer ${ghToken}` },
      // Only allow PR-related REST API endpoints
      allowedPaths: ["^/repos/"],
    });
    upstreams.push({
      domain: "github.com",
      target: "https://github.com",
      headers: { authorization: `Bearer ${ghToken}` },
      // Only allow git smart HTTP push paths
      allowedPaths: ["\\.git/(info/refs|git-receive-pack)$"],
    });
  }

  let authProxy: AuthProxy | null = null;
  let mitmProxy: { socketPath: string; domains: string[] } | undefined;
  if (upstreams.length > 0) {
    const socketPath = join(dirname(worktreePath), `deer-auth-${taskId}.sock`);
    authProxy = await startAuthProxy(socketPath, upstreams, onProxyLog, daemonize);
    mitmProxy = { socketPath: authProxy.socketPath, domains: authProxy.domains };
  }

  // Build env vars for the sandbox
  const lang = detectLang();
  const sandboxEnvFinal: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitconfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    ...(lang !== "en" ? { CLAUDE_CODE_LOCALE: lang } : {}),
    ...placeholderEnv,
    ...sandboxEnv,
  };

  // Build the full sandboxed command via the runtime
  const runtimeOpts = {
    worktreePath,
    repoGitDir: resolve(repoPath, ".git"),
    allowlist: config.network.allowlist,
    extraReadPaths: ecosystemResult.extraReadPaths,
    env: { ...ecosystemResult.env, ...sandboxEnvFinal },
    mitmProxy,
  };

  try {
    await runtime.prepare?.(runtimeOpts);
  } catch (err) {
    await authProxy?.close();
    if (!continueSession) {
      await removeWorktree(repoPath, worktreePath).catch(() => {});
    }
    throw err;
  }

  const appendSysPromptArgs = appendSystemPrompt ? ["--append-system-prompt", appendSystemPrompt] : [];
  const claudeCmd = continueSession
    ? ["claude", "--dangerously-skip-permissions", "--model", model, "--continue", ...appendSysPromptArgs]
    : prompt
      ? ["claude", "--dangerously-skip-permissions", "--model", model, ...appendSysPromptArgs, prompt]
      : ["claude", "--dangerously-skip-permissions", "--model", model, ...appendSysPromptArgs];

  const command = runtime.buildCommand(runtimeOpts, claudeCmd);

  return {
    taskId,
    worktreePath,
    branch,
    command,
    authProxyPid: authProxy?.pid ?? null,
    async cleanup() {
      await authProxy?.close();
    },
    async destroy() {
      await authProxy?.close();
      // Only delete deer-managed branches; preserve user branches from --from
      const branchToDelete = branch.startsWith("deer/") ? branch : undefined;
      await cleanupWorktree(repoPath, worktreePath, branchToDelete);
    },
  };
}

/**
 * Returns the worktree path for a given task ID.
 */
export function taskWorktreePath(taskId: string): string {
  return join(dataDir(), "tasks", taskId, "worktree");
}
