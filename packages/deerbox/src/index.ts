// Main entrypoint
export { prepare, taskWorktreePath } from "./session";
export type { PrepareOptions, PreparedSession } from "./session";

// Startup
export { detectRepo, createWorktree, checkoutWorktree, removeWorktree, cleanupWorktree } from "./git/worktree";
export type { RepoInfo, WorktreeInfo } from "./git/worktree";
export { loadConfig, DEFAULT_CONFIG } from "./config";
export type { DeerConfig, ProxyCredential } from "./config";
export { runPreflight, resolveCredentials } from "./preflight";
export type { PreflightResult } from "./preflight";

// Sandbox primitives
export type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./sandbox/runtime";
export { createSrtRuntime } from "./sandbox/srt";
export { resolveRuntime } from "./sandbox/resolve";
export { startAuthProxy } from "./sandbox/auth-proxy";
export { resolveProxyUpstreams } from "./proxy";
export type { ProxyUpstream, AuthProxy } from "./sandbox/auth-proxy";

// Ecosystems
export { applyEcosystems, BUILTIN_PLUGINS } from "./ecosystems";
export type { EcosystemPlugin, EcosystemResult } from "./ecosystems";

// Git finalize (PR creation)
export {
  createPullRequest,
  updatePullRequest,
  pushBranchUpdates,
  hasChanges,
  findPRTemplate,
  ensureDeerEmojiPrefix,
  parsePRMetadataResponse,
  buildClaudeSubprocessEnv,
} from "./git/finalize";
export type {
  CreatePRResult,
  CreatePROptions,
  UpdatePROptions,
  PushBranchOptions,
} from "./git/finalize";

// Post-session (interactive finalize prompt)
export { runPostSession, parseChoice, renderPromptMenu } from "./post-session";
export type { PostSessionChoice, PostSessionOutcome, PostSessionDeps, PostSessionContext } from "./post-session";

// Utilities
export { generateTaskId, dataDir } from "./task";
export { detectLang, setLang, getLang, getPRLanguage } from "./i18n";
export type { Lang } from "./i18n";
export { VERSION, HOME, DEFAULT_MODEL, MAX_DIFF_FOR_PR_METADATA, PR_METADATA_MODEL } from "./constants";
