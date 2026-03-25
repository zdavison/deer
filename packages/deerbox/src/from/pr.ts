/**
 * PR strategy — resolves GitHub PR URLs and bare PR numbers.
 *
 * Fetches the PR's head branch, base branch, and review comments,
 * injecting comments as system prompt context.
 */

import type { FromStrategy, FromResolution, GhRunner } from "./types";
import { fetchPRComments } from "../pr-comments";
import { t } from "../i18n";

const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const PR_NUMBER_RE = /^\d+$/;

const defaultRunner: GhRunner = async (args) => {
  const result = await Bun.$`gh ${args}`.quiet().nothrow();
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
};

export const prStrategy: FromStrategy = {
  match(from: string): boolean {
    return PR_URL_RE.test(from) || PR_NUMBER_RE.test(from);
  },

  async resolve(from: string, repoPath: string, defaultBranch: string, runner: GhRunner = defaultRunner): Promise<FromResolution> {
    const result = await runner(["pr", "view", from, "--json", "headRefName,url,baseRefName"]);
    if (result.exitCode !== 0) {
      throw new Error(`Could not find PR: ${from}`);
    }
    const data = JSON.parse(result.stdout) as { headRefName: string; url: string; baseRefName: string };

    // Fetch PR review comments and format as system prompt context
    let appendSystemPrompt: string | undefined;
    console.error(`  ${t("cli_fetching_pr_comments")}`);
    const { formatted, reviewCount, issueCount } = await fetchPRComments(data.url);
    const total = reviewCount + issueCount;
    if (total > 0) {
      const rc = t("cli_review_comment", { n: reviewCount, s: reviewCount !== 1 ? "s" : "" });
      const ic = t("cli_discussion_comment", { n: issueCount, s: issueCount !== 1 ? "s" : "" });
      console.error(`  ${t("cli_fetched_comments", { rc, ic })}`);
      appendSystemPrompt = formatted ?? undefined;
    } else {
      console.error(`  ${t("cli_no_pr_comments")}`);
    }

    return {
      branch: data.headRefName,
      prUrl: data.url,
      baseBranch: data.baseRefName,
      appendSystemPrompt,
    };
  },
};
