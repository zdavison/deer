/**
 * Prepare a sandboxed Claude session.
 *
 * This is the main entrypoint for deerbox. It handles all the setup:
 * worktree creation, ecosystem detection, gitconfig, auth proxy, and
 * SRT command building. The caller gets back a prepared session with
 * the full command to run and a cleanup function.
 */

import { join, dirname, resolve } from "node:path";
import { mkdir, cp, access, readFile, writeFile, readdir } from "node:fs/promises";
import { createWorktree, checkoutWorktree, removeWorktree, cleanupWorktree } from "./git/worktree";
import { generateTaskId, dataDir, repoSlug } from "./task";
import { loadConfig, type DeerConfig } from "./config";
import { resolveRuntime } from "./sandbox/resolve";
import { detectLang, HOME, DEFAULT_MODEL, loadEnvPolicy } from "@deer/shared";
import { applyEcosystems } from "./ecosystems";
import { resolveProxyUpstreams } from "./proxy";
import { startAuthProxy, ensureCACert, type AuthProxy } from "./sandbox/auth-proxy";

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
   * If provided, resume an existing session instead of creating a new worktree.
   * The worktree and branch are reused, and `--continue` is passed to Claude
   * to resume the conversation history from the previous run.
   */
  continueSession?: {
    taskId: string;
    worktreePath: string;
    branch: string;
  };
  /**
   * If provided, run Claude in an existing worktree without creating a new
   * one. The worktree will not be destroyed on cleanup. Used when the user
   * already works with git worktrees and runs deerbox from within one.
   */
  reuseWorktree?: {
    worktreePath: string;
    branch: string;
    /** The main .git directory (not the worktree's .git file pointer) */
    repoGitDir: string;
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

/**
 * Items to copy from ~/.claude into the per-task claude config dir.
 * Directories are copied recursively; files are copied as-is.
 * All are sourced from the ~/.claude directory.
 */
const CLAUDE_DIR_ITEMS: Array<{ name: string; isDir: boolean }> = [
  { name: "CLAUDE.md", isDir: false },
  { name: "settings.json", isDir: false },
  { name: "settings.local.json", isDir: false },
  { name: "commands", isDir: true },
  { name: "agents", isDir: true },
  { name: "plugins", isDir: true },
  { name: "skills", isDir: true },
  { name: "hooks", isDir: true },
];

/**
 * Recursively walk a directory and rewrite all `.json` files, replacing
 * occurrences of `oldPrefix` with `newPrefix` in their content.
 * Non-JSON files and files that don't contain the old prefix are skipped.
 */
async function rewriteJsonFiles(dir: string, oldPrefix: string, newPrefix: string): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteJsonFiles(full, oldPrefix, newPrefix);
    } else if (entry.name.endsWith(".json")) {
      try {
        const raw = await readFile(full, "utf-8");
        if (!raw.includes(oldPrefix)) continue;
        await writeFile(full, raw.replaceAll(oldPrefix, newPrefix));
      } catch { /* unreadable or unwritable — skip */ }
    }
  }
}

/**
 * Create a per-task Claude config directory populated with a curated,
 * read-safe copy of ~/.claude content.
 *
 * Directories are copied recursively. ~/.claude.json is copied with
 * oauthToken and apiKey fields stripped, since auth is handled by the
 * host-side MITM proxy and credentials must never enter the sandbox.
 *
 * Items absent from ~/.claude are silently skipped.
 *
 * @param claudeConfigDir - Absolute path to the per-task claude config dir to create
 * @param home - The user's home directory
 */
export async function setupClaudeConfigDir(claudeConfigDir: string, home: string): Promise<void> {
  await mkdir(claudeConfigDir, { recursive: true });

  const sourceClaudeDir = join(home, ".claude");

  for (const item of CLAUDE_DIR_ITEMS) {
    const src = join(sourceClaudeDir, item.name);
    const dst = join(claudeConfigDir, item.name);
    const exists = await access(src).then(() => true).catch(() => false);
    if (!exists) continue;
    await cp(src, dst, { recursive: item.isDir });
  }

  // Rewrite all references to ~/.claude in copied JSON files so they point
  // to the per-task config dir. This catches installPath, installLocation,
  // and any other field that embeds the host config path — a blanket replace
  // is more resilient than patching individual files.
  const oldPrefix = join(home, ".claude");
  await rewriteJsonFiles(claudeConfigDir, oldPrefix, claudeConfigDir);

  // Copy ~/.claude.json with credentials stripped
  const hostClaudeJson = join(home, ".claude.json");
  const hasClaudeJson = await access(hostClaudeJson).then(() => true).catch(() => false);
  if (hasClaudeJson) {
    const raw = await readFile(hostClaudeJson, "utf-8");
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable — skip rather than crash the session
    }
    if (parsed !== null) {
      delete parsed.oauthToken;
      delete parsed.apiKey;
      await writeFile(join(claudeConfigDir, ".claude.json"), JSON.stringify(parsed, null, 2));
    }
  }

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
    reuseWorktree,
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
  let ecosystemResult = { extraReadPaths: [] as string[], extraWritePaths: [] as string[], env: {} as Record<string, string> };

  if (continueSession) {
    worktreePath = continueSession.worktreePath;
    branch = continueSession.branch;
    onStatus?.("Resuming previous session...");
  } else if (reuseWorktree) {
    worktreePath = reuseWorktree.worktreePath;
    branch = reuseWorktree.branch;
    onStatus?.("Using existing worktree...");
  } else if (fromBranch) {
    onStatus?.("Checking out branch...");
    const worktree = await checkoutWorktree(repoPath, taskId, fromBranch);
    worktreePath = worktree.worktreePath;
    branch = worktree.branch;

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

    ecosystemResult = await applyEcosystems(
      repoPath,
      worktreePath,
      config.sandbox.ecosystems?.disabled,
      undefined,
      onStatus,
    );
  }

  // Run the setup command in the worktree before the sandbox starts
  if (!continueSession && !reuseWorktree && config.defaults.setupCommand) {
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

  // Write a minimal gitconfig so git never reads ~/.gitconfig.
  // When reusing an existing worktree, use a task-scoped name to avoid
  // overwriting the outer session's gitconfig.
  const gitconfigPath = reuseWorktree
    ? join(dirname(worktreePath), `gitconfig-${taskId}`)
    : join(dirname(worktreePath), "gitconfig");
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

  const claudeConfigDir = join(dataDir(), "tasks", repoSlug(repoPath), taskId, "claude-config");
  // On resume, the config dir already exists with read-only git pack files from
  // the plugin cache. Re-copying would fail with EACCES trying to overwrite them.
  const claudeConfigExists = await access(claudeConfigDir).then(() => true).catch(() => false);
  if (!claudeConfigExists) {
    await setupClaudeConfigDir(claudeConfigDir, HOME);
  }

  onStatus?.("Starting sandbox...");

  // Generate CA cert for TLS MITM proxying (idempotent — reuses existing cert)
  const caCert = ensureCACert(join(dataDir(), "tls"));

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
      // Only allow PR-related REST + GraphQL API endpoints
      allowedPaths: ["^/repos/", "^/graphql$"],
    });
    upstreams.push({
      domain: "github.com",
      target: "https://github.com",
      headers: { authorization: `Bearer ${ghToken}` },
      // Allow git smart HTTP fetch and push paths
      allowedPaths: ["\\.git/(info/refs|git-upload-pack|git-receive-pack)$"],
    });
  }

  let authProxy: AuthProxy | null = null;
  let mitmProxy: { socketPath: string; domains: string[] } | undefined;
  if (upstreams.length > 0) {
    // Use a short filename to stay within macOS's 104-byte sun_path limit.
    // The task dir path can be long, so we use "proxy.sock" instead of
    // repeating the taskId (which is already in the directory path).
    const socketPath = join(dirname(worktreePath), "proxy.sock");
    authProxy = await startAuthProxy(socketPath, upstreams, onProxyLog, daemonize, caCert);
    mitmProxy = { socketPath: authProxy.socketPath, domains: authProxy.domains };
  }

  // Build env vars for the sandbox
  const lang = detectLang();
  const sandboxEnvFinal: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitconfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    ...(lang !== "en" ? { CLAUDE_CODE_LOCALE: lang } : {}),
    ...placeholderEnv,
    ...sandboxEnv,
  };

  // Load the user's env policy to block any vars they've denied
  const envPolicy = loadEnvPolicy();

  // Build the full sandboxed command via the runtime
  const runtimeOpts = {
    worktreePath,
    repoGitDir: reuseWorktree?.repoGitDir ?? resolve(repoPath, ".git"),
    allowlist: config.network.allowlist,
    extraReadPaths: ecosystemResult.extraReadPaths,
    extraWritePaths: ecosystemResult.extraWritePaths,
    env: { ...ecosystemResult.env, ...sandboxEnvFinal },
    mitmProxy,
    claudeConfigDir,
    envBlocklist: envPolicy.blocked,
    caCertPath: caCert.certPath,
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
      if (reuseWorktree) {
        await Bun.$`rm -f ${gitconfigPath}`.quiet().nothrow();
      }
    },
    async destroy() {
      await authProxy?.close();
      if (reuseWorktree) {
        // Don't remove the outer worktree; just clean up this session's gitconfig
        await Bun.$`rm -f ${gitconfigPath}`.quiet().nothrow();
        return;
      }
      // Only delete deer-managed branches; preserve user branches from --from
      const branchToDelete = branch.startsWith("deer/") ? branch : undefined;
      await cleanupWorktree(repoPath, worktreePath, branchToDelete);
    },
  };
}

/**
 * Returns the worktree path for a given task ID scoped by repository.
 */
export function taskWorktreePath(repoPath: string, taskId: string): string {
  return join(dataDir(), "tasks", repoSlug(repoPath), taskId, "worktree");
}
