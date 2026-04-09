/**
 * Strategy-based resolution for the --from flag.
 *
 * Each URL/input type (PR, GitHub Actions, branch name) has its own
 * strategy that handles matching and resolution. Strategies are tried
 * in order; the first match wins. The branch strategy is always last
 * as a catch-all.
 */

/** Result of resolving a --from value. */
export interface FromResolution {
  /**
   * Branch name to check out in the worktree.
   * Undefined when there is no existing branch (e.g. a GitHub issue).
   */
  branch?: string;
  /**
   * Associated PR URL, if any.
   * @example "https://github.com/acme/repo/pull/42"
   */
  prUrl: string | null;
  /** Base branch for the worktree (e.g. the PR's target branch) */
  baseBranch: string;
  /** Additional context to inject into Claude's system prompt (e.g. CI logs, PR comments) */
  appendSystemPrompt?: string;
  /**
   * True when the PR originates from a fork (cross-repository PR in GitHub API terms).
   * When true, the fork remote cannot be pushed to.
   */
  isCrossRepository?: boolean;
  /**
   * Additional content to append to the system prompt used when Claude generates
   * PR metadata (branch name, title, body). Strategies use this to influence the
   * generated PR description (e.g. instructing Claude to close a related issue).
   */
  appendPRSystemPrompt?: string;
}

/** A strategy that can resolve a --from value. */
export interface FromStrategy {
  /** Return true if this strategy handles the given input */
  match(from: string): boolean;
  /** Resolve the input to a FromResolution */
  resolve(from: string, repoPath: string, defaultBranch: string): Promise<FromResolution>;
}

/**
 * Runs a `gh` CLI command and returns stdout + exit code.
 * Injectable for testing.
 */
export type GhRunner = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;
