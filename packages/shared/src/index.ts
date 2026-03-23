// Constants
export { HOME, DEFAULT_MODEL, BYPASS_DIALOG_MAX_POLLS, BYPASS_DIALOG_POLL_MS, BYPASS_DIALOG_KEY_DELAY_MS, MAX_DIFF_FOR_PR_METADATA, PR_METADATA_MODEL } from "./constants";

// i18n
export { setLang, getLang, getPRLanguage, detectLang } from "./i18n";
export type { Lang } from "./i18n";

// Credentials
export { resolveCredentials } from "./credentials";
export type { CredentialType, ResolveCredentialsOptions } from "./credentials";

// Git utilities
export { detectRepo } from "./git/detect";
export type { RepoInfo } from "./git/detect";

// Updater
export { checkAndUpdate } from "./updater";
export type { UpdateOptions } from "./updater";

// Git finalize (PR creation)
export {
  createPullRequest,
  updatePullRequest,
  pushBranchUpdates,
  mergeIntoLocalBranch,
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
  MergeIntoLocalBranchOptions,
} from "./git/finalize";
