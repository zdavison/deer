/**
 * Issue strategy — resolves GitHub issue URLs.
 *
 * Fetches the issue title, body, and comments, injecting them as
 * system prompt context. Creates a fresh branch (no existing branch
 * to check out), so `branch` is left undefined.
 */

import type { FromStrategy, FromResolution, GhRunner } from "./types";
import { t } from "../i18n";

const ISSUE_URL_RE = /github\.com\/[^/]+\/[^/]+\/issues\/\d+/;

const defaultRunner: GhRunner = async (args) => {
  const result = await Bun.$`gh ${args}`.quiet().nothrow();
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
};

interface IssueComment {
  author: { login: string };
  body: string;
}

interface IssueData {
  title: string;
  body: string;
  comments: IssueComment[];
}

function formatIssue(data: IssueData): string {
  const lines: string[] = [`GitHub Issue: ${data.title}`, ""];

  const body = data.body?.trim();
  if (body) {
    lines.push(body, "");
  }

  const comments = data.comments.filter((c) => c.body?.trim());
  if (comments.length > 0) {
    lines.push("Comments:", "");
    for (const c of comments) {
      lines.push(`[Comment by @${c.author.login}]`, c.body.trim(), "");
    }
  }

  // Remove trailing blank line
  while (lines.at(-1) === "") lines.pop();

  return lines.join("\n");
}

export const issueStrategy: FromStrategy = {
  match(from: string): boolean {
    return ISSUE_URL_RE.test(from);
  },

  async resolve(from: string, _repoPath: string, defaultBranch: string, runner: GhRunner = defaultRunner): Promise<FromResolution> {
    console.error(`  ${t("cli_fetching_issue")}`);

    const result = await runner(["issue", "view", from, "--json", "title,body,comments"]);
    if (result.exitCode !== 0) {
      throw new Error(`Could not fetch issue: ${from}`);
    }

    const data = JSON.parse(result.stdout) as IssueData;
    const commentCount = data.comments.filter((c) => c.body?.trim()).length;

    if (commentCount > 0) {
      console.error(`  ${t("cli_fetched_issue", { n: commentCount, s: commentCount !== 1 ? "s" : "" })}`);
    } else {
      console.error(`  ${t("cli_no_issue_comments")}`);
    }

    return {
      branch: undefined,
      prUrl: null,
      baseBranch: defaultBranch,
      appendSystemPrompt: formatIssue(data),
    };
  },
};
