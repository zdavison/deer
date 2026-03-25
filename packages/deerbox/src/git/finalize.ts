export {
  createPullRequest,
  updatePullRequest,
  pushBranchUpdates,
  mergeIntoLocalBranch,
  hasChanges,
  findPRTemplate,
  generatePRMetadata,
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
  PRMetadata,
} from "@deer/shared";
