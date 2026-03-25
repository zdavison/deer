/**
 * GitHub Actions strategy — resolves action run/job URLs.
 *
 * Fetches the run's branch, detects associated PRs, and retrieves
 * failed job logs for injection into Claude's system prompt.
 */

import type { FromStrategy, FromResolution, GhRunner } from "./types";
import { t } from "../i18n";

const ACTION_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/;

/** Maximum number of log lines to include in the system prompt. */
const MAX_LOG_LINES = 500;

// ── Types ────────────────────────────────────────────────────────────

export interface ActionUrlParts {
  owner: string;
  repo: string;
  runId: string;
  /** @example "68502679989" */
  jobId?: string;
}

export interface FetchActionLogsResult {
  /** Formatted log block for Claude's system prompt, or null if no logs. */
  formatted: string | null;
  /** Branch the action ran on. */
  branch: string;
  /** Base branch (from PR or default). */
  baseBranch: string;
  /** Associated PR URL, if any. */
  prUrl: string | null;
}

// ── Pure functions ───────────────────────────────────────────────────

/**
 * Parse a GitHub Actions URL into its constituent parts.
 * Returns null if the URL does not match the expected pattern.
 */
export function parseActionUrl(url: string): ActionUrlParts | null {
  const match = url.match(ACTION_URL_RE);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    runId: match[3],
    jobId: match[4] || undefined,
  };
}

/**
 * Format raw CI logs into a context block for Claude's system prompt.
 * Truncates to the last MAX_LOG_LINES lines. Returns null for empty input.
 */
export function formatActionLogs(logs: string, jobName?: string): string | null {
  const trimmed = logs.trim();
  if (!trimmed) return null;

  const allLines = trimmed.split("\n");
  let body: string;
  let truncationNotice = "";

  if (allLines.length > MAX_LOG_LINES) {
    body = allLines.slice(-MAX_LOG_LINES).join("\n");
    truncationNotice = `(Output truncated — showing last ${MAX_LOG_LINES} of ${allLines.length} lines)\n\n`;
  } else {
    body = trimmed;
  }

  const jobHeader = jobName ? `Job: ${jobName}\n\n` : "";
  return `GitHub Actions Failed Job Logs:\n\n${jobHeader}${truncationNotice}${body}`;
}

// ── Fetching ─────────────────────────────────────────────────────────

const defaultRunner: GhRunner = async (args) => {
  const result = await Bun.$`gh ${args}`.quiet().nothrow();
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
};

/**
 * Fetch action run metadata, logs, and associated PR info.
 *
 * @param url - Full GitHub Actions URL (run or job)
 * @param defaultBranch - Fallback base branch if no PR is found
 * @param runner - Injectable for testing
 */
export async function fetchActionLogs(
  url: string,
  defaultBranch: string,
  runner: GhRunner = defaultRunner,
): Promise<FetchActionLogsResult> {
  const parts = parseActionUrl(url);
  if (!parts) throw new Error(`Not a valid GitHub Actions URL: ${url}`);

  const { owner, repo, runId, jobId } = parts;
  const repoSlug = `${owner}/${repo}`;

  // 1. Fetch run metadata
  console.error(`  ${t("cli_fetching_action_logs")}`);
  const metaResult = await runner(["run", "view", runId, "--repo", repoSlug, "--json", "headBranch,event,headSha"]);
  if (metaResult.exitCode !== 0) {
    throw new Error(`Could not fetch run metadata for ${url}`);
  }
  const meta = JSON.parse(metaResult.stdout) as { headBranch: string; event: string; headSha: string };

  // 2. If it's a pull_request event, look up the associated PR
  let prUrl: string | null = null;
  let baseBranch = defaultBranch;

  if (meta.event === "pull_request" || meta.event === "pull_request_target") {
    const prResult = await runner(["api", `/repos/${repoSlug}/commits/${meta.headSha}/pulls`]);
    if (prResult.exitCode === 0) {
      try {
        const prs = JSON.parse(prResult.stdout) as Array<{
          number: number;
          html_url: string;
          base: { ref: string };
        }>;
        if (prs.length > 0) {
          prUrl = prs[0].html_url;
          baseBranch = prs[0].base.ref;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 3. Fetch logs — job-specific or all failed
  let logsStdout = "";
  if (jobId) {
    const logResult = await runner(["api", `/repos/${repoSlug}/actions/jobs/${jobId}/logs`]);
    if (logResult.exitCode === 0) logsStdout = logResult.stdout;
  } else {
    const logResult = await runner(["run", "view", runId, "--repo", repoSlug, "--log-failed"]);
    if (logResult.exitCode === 0) logsStdout = logResult.stdout;
  }

  const formatted = formatActionLogs(logsStdout);

  if (formatted) {
    const lineCount = logsStdout.trim().split("\n").length;
    console.error(`  ${t("cli_fetched_action_logs", { n: lineCount })}`);
  } else {
    console.error(`  ${t("cli_no_action_logs")}`);
  }

  return { formatted, branch: meta.headBranch, baseBranch, prUrl };
}

// ── Strategy ─────────────────────────────────────────────────────────

export const actionStrategy: FromStrategy = {
  match(from: string): boolean {
    return ACTION_URL_RE.test(from);
  },

  async resolve(from: string, _repoPath: string, defaultBranch: string): Promise<FromResolution> {
    const result = await fetchActionLogs(from, defaultBranch);
    return {
      branch: result.branch,
      prUrl: result.prUrl,
      baseBranch: result.baseBranch,
      appendSystemPrompt: result.formatted ?? undefined,
    };
  },
};
