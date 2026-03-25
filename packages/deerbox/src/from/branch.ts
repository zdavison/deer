/**
 * Branch strategy — catch-all for bare branch names.
 *
 * Checks if an open PR exists for the branch and resolves its base.
 * Always matches (must be last in the strategy list).
 */

import type { FromStrategy, FromResolution, GhRunner } from "./types";

const defaultRunner: GhRunner = async (args) => {
  const result = await Bun.$`gh ${args}`.quiet().nothrow();
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
};

export const branchStrategy: FromStrategy = {
  match(_from: string): boolean {
    return true;
  },

  async resolve(from: string, repoPath: string, defaultBranch: string, runner: GhRunner = defaultRunner): Promise<FromResolution> {
    const result = await runner(["pr", "list", "--head", from, "--state", "open", "--json", "url,baseRefName", "--limit", "1"]);
    if (result.exitCode === 0) {
      try {
        const prs = JSON.parse(result.stdout) as Array<{ url: string; baseRefName: string }>;
        if (prs.length > 0) {
          return { branch: from, prUrl: prs[0].url, baseBranch: prs[0].baseRefName };
        }
      } catch { /* ignore parse errors */ }
    }

    return { branch: from, prUrl: null, baseBranch: defaultBranch };
  },
};
