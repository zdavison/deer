/**
 * Strategy-based --from resolution.
 *
 * Strategies are tried in order — the first match wins.
 * The branch strategy is always last as a catch-all.
 */

export type { FromResolution, FromStrategy, GhRunner } from "./types";
export { actionStrategy, parseActionUrl, formatActionLogs, fetchActionLogs } from "./action";
export type { ActionUrlParts, FetchActionLogsResult } from "./action";
export { prStrategy } from "./pr";
export { branchStrategy } from "./branch";
export { issueStrategy } from "./issue";

import { actionStrategy } from "./action";
import { prStrategy } from "./pr";
import { issueStrategy } from "./issue";
import { branchStrategy } from "./branch";
import type { FromStrategy, FromResolution } from "./types";

/** Ordered list of strategies. First match wins; branch is the catch-all. */
const FROM_STRATEGIES: FromStrategy[] = [actionStrategy, prStrategy, issueStrategy, branchStrategy];

/**
 * Resolve a --from value to a branch, optional PR URL, base branch,
 * and optional system prompt context.
 *
 * Accepts:
 * - A GitHub Actions URL (run or job)
 * - A GitHub PR URL or PR number
 * - A branch name
 */
export async function resolveFrom(
  from: string,
  repoPath: string,
  defaultBranch: string,
): Promise<FromResolution> {
  const strategy = FROM_STRATEGIES.find((s) => s.match(from));
  if (!strategy) throw new Error(`Cannot resolve --from value: ${from}`);
  return strategy.resolve(from, repoPath, defaultBranch);
}
