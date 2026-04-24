/**
 * Worktree path strategy — handles absolute or relative paths to git worktree directories.
 *
 * Reads the branch name from the worktree's HEAD, then delegates to the
 * branch strategy to find any associated PR.
 */

import { isAbsolute, resolve } from "node:path";
import { stat, readFile } from "node:fs/promises";
import type { FromStrategy, FromResolution, GhRunner } from "./types";
import { branchStrategy } from "./branch";

async function readWorktreeBranch(worktreePath: string): Promise<string | null> {
  try {
    const headPath = `${worktreePath}/.git`;
    let gitDir: string;

    // Could be a main worktree (.git is a dir) or a linked worktree (.git is a file)
    const headStat = await stat(headPath).catch(() => null);
    if (!headStat) return null;

    if (headStat.isFile()) {
      // Linked worktree: .git file contains "gitdir: /path/to/.git/worktrees/<name>"
      const contents = await readFile(headPath, "utf8");
      const match = contents.match(/^gitdir:\s*(.+)$/m);
      if (!match) return null;
      gitDir = match[1].trim();
    } else {
      gitDir = headPath;
    }

    const head = await readFile(`${gitDir}/HEAD`, "utf8");
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/m);
    if (!refMatch) return null;
    return refMatch[1].trim();
  } catch {
    return null;
  }
}

export const worktreeStrategy: FromStrategy = {
  match(from: string): boolean {
    return isAbsolute(from) || from.startsWith("./") || from.startsWith("../");
  },

  async resolve(from: string, repoPath: string, defaultBranch: string, runner?: GhRunner): Promise<FromResolution> {
    const absPath = resolve(from);
    const branch = await readWorktreeBranch(absPath);
    if (!branch) {
      throw new Error(`Could not determine branch from worktree path: ${absPath}`);
    }
    return branchStrategy.resolve(branch, repoPath, defaultBranch, runner as GhRunner);
  },
};
