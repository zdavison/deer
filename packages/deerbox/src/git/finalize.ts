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
  isPRAuthorFromLogins,
  isPRAuthor,
} from "@deer/shared";
export type {
  CreatePRResult,
  CreatePROptions,
  UpdatePROptions,
  PushBranchOptions,
  MergeIntoLocalBranchOptions,
} from "@deer/shared";
