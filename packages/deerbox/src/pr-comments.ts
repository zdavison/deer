/**
 * Fetch and format PR review comments for injection into Claude's prompt context.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface PRReviewComment {
  user: { login: string };
  body: string;
  /** File path for inline diff comments */
  path?: string;
  /** Line number for inline diff comments */
  line?: number;
}

export interface PRIssueComment {
  user: { login: string };
  body: string;
}

/**
 * Runs a `gh api <endpoint>` call and returns stdout + exit code.
 * Injectable for testing.
 */
export type GhApiRunner = (endpoint: string) => Promise<{ stdout: string; exitCode: number }>;

// ── Pure formatting ───────────────────────────────────────────────────

/**
 * Format fetched PR comments into a context block for Claude.
 * Returns null if there are no non-empty comments.
 */
export function formatPRComments(
  reviewComments: PRReviewComment[],
  issueComments: PRIssueComment[],
): string | null {
  const lines: string[] = [];

  for (const c of reviewComments) {
    const body = c.body.trim();
    if (!body) continue;
    const location = c.path
      ? c.line != null
        ? `on ${c.path} line ${c.line}`
        : `on ${c.path}`
      : null;
    const header = location
      ? `[Review by @${c.user.login} ${location}]`
      : `[Review by @${c.user.login}]`;
    lines.push(header, body, "");
  }

  for (const c of issueComments) {
    const body = c.body.trim();
    if (!body) continue;
    lines.push(`[Comment by @${c.user.login}]`, body, "");
  }

  if (lines.length === 0) return null;

  // Remove trailing blank line
  while (lines.at(-1) === "") lines.pop();

  return `PR Review Comments:\n\n${lines.join("\n")}`;
}

// ── Fetching ──────────────────────────────────────────────────────────

function parsePRUrl(prUrl: string): { owner: string; repo: string; number: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

const defaultRunner: GhApiRunner = async (endpoint) => {
  const result = await Bun.$`gh api ${endpoint}`.quiet().nothrow();
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
};

/**
 * Fetch PR review and issue comments from GitHub and return a formatted
 * context block, or null if there are no comments or on failure.
 */
export async function fetchPRComments(prUrl: string, runner: GhApiRunner = defaultRunner): Promise<string | null> {
  const parsed = parsePRUrl(prUrl);
  if (!parsed) return null;

  const { owner, repo, number } = parsed;

  let reviewComments: PRReviewComment[] = [];
  let issueComments: PRIssueComment[] = [];

  try {
    const [reviewRes, issueRes] = await Promise.all([
      runner(`/repos/${owner}/${repo}/pulls/${number}/comments`),
      runner(`/repos/${owner}/${repo}/issues/${number}/comments`),
    ]);

    if (reviewRes.exitCode === 0) {
      reviewComments = JSON.parse(reviewRes.stdout) as PRReviewComment[];
    }
    if (issueRes.exitCode === 0) {
      issueComments = JSON.parse(issueRes.stdout) as PRIssueComment[];
    }
  } catch {
    return null;
  }

  return formatPRComments(reviewComments, issueComments);
}
