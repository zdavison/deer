/**
 * Post-session git operations: create PR on demand, clean up worktree.
 */

export interface CreatePRResult {
  /** @example "https://github.com/org/repo/pull/42" */
  prUrl: string;
  /** @example "deer/fix-login-bug" */
  finalBranch: string;
}

export interface CreatePROptions {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  prompt: string;
}

interface PRMetadata {
  branchName: string;
  title: string;
  body: string;
}

export function ensureDeerEmojiPrefix(title: string): string {
  if (title.startsWith("🦌 ")) return title;
  return `🦌 ${title}`;
}

/**
 * Ask Claude to generate PR metadata (branch name, title, body) from the diff.
 * Falls back to a simple prompt-based title if Claude fails.
 */
async function generatePRMetadata(worktreePath: string, baseBranch: string, prompt: string): Promise<PRMetadata> {
  const diffResult = await Bun.$`git -C ${worktreePath} diff ${baseBranch}..HEAD`.quiet().nothrow();
  const diff = diffResult.stdout.toString().trim();

  const logResult = await Bun.$`git -C ${worktreePath} log --oneline ${baseBranch}..HEAD`.quiet().nothrow();
  const commitLog = logResult.stdout.toString().trim();

  const maxDiffLen = 20_000;
  const truncatedDiff = diff.length > maxDiffLen
    ? diff.slice(0, maxDiffLen) + "\n... (diff truncated)"
    : diff;

  const metadataPrompt = `You are generating metadata for a pull request. Analyze the following task prompt, commits, and diff, then produce EXACTLY the following JSON (no markdown fences, no extra text):

{"branchName": "<short-kebab-case-name>", "title": "<PR title under 70 chars>", "body": "<PR body in markdown>"}

Rules:
- branchName: short, descriptive, kebab-case (e.g. "fix-login-redirect", "add-user-search"). Do NOT include any prefix like "deer/" — just the name itself.
- title: concise, imperative mood (e.g. "Fix login redirect loop", "Add user search endpoint")
- body: markdown with a ## Summary section describing what changed and why, followed by a ## Changes section with bullet points of key changes. End with a horizontal rule and "> Created by [deer](https://github.com/mm-zacharydavison/deer) — review carefully."

Task prompt:
${prompt}

Commits:
${commitLog}

Diff:
${truncatedDiff}`;

  try {
    const proc = Bun.spawn(["claude", "-p", metadataPrompt, "--output-format", "json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error("claude exited with non-zero status");
    const output = (await new Response(proc.stdout).text()).trim();

    let text = output;
    try {
      const wrapper = JSON.parse(output);
      if (wrapper.result) text = wrapper.result;
    } catch {
      // Not wrapped, use as-is
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in Claude response");

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.branchName || !parsed.title || !parsed.body) {
      throw new Error("Missing required fields in Claude response");
    }

    return {
      branchName: parsed.branchName.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
      title: ensureDeerEmojiPrefix(parsed.title.slice(0, 70)),
      body: parsed.body,
    };
  } catch {
    const clean = prompt.replace(/\n/g, " ").trim();
    const title = ensureDeerEmojiPrefix(clean.length > 65 ? clean.slice(0, 62) + "..." : clean);
    const body = [
      "## Summary",
      "",
      `> ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`,
      "",
      "### Commits",
      "",
      "```",
      commitLog,
      "```",
      "",
      "---",
      "> Created by [deer](https://github.com/mm-zacharydavison/deer) — review carefully.",
    ].join("\n");
    return { branchName: "", title, body };
  }
}

/**
 * Create a PR for a completed agent session.
 *
 * - Stages and commits any uncommitted changes
 * - Asks Claude to generate branch name, PR title, and PR body
 * - Renames the branch to `deer/<branchName>`
 * - Pushes the branch to origin
 * - Creates a PR via `gh pr create`
 */
export async function createPullRequest(options: CreatePROptions): Promise<CreatePRResult> {
  const { repoPath, worktreePath, branch, baseBranch, prompt } = options;

  // Stage and commit any uncommitted changes
  await Bun.$`git -C ${worktreePath} add -A`.quiet();
  const status = await Bun.$`git -C ${worktreePath} status --porcelain`.quiet();
  if (status.stdout.toString().trim().length > 0) {
    await Bun.$`git -C ${worktreePath} commit -m "deer: uncommitted changes from agent session"`.quiet();
  }

  // Generate PR metadata using Claude
  const metadata = await generatePRMetadata(worktreePath, baseBranch, prompt);

  // Rename the branch if Claude provided a name
  let finalBranch = branch;
  if (metadata.branchName) {
    const newBranch = `deer/${metadata.branchName}`;
    const renameResult = await Bun.$`git -C ${worktreePath} branch -m ${newBranch}`.quiet().nothrow();
    if (renameResult.exitCode === 0) {
      finalBranch = newBranch;
    }
  }

  // Push the branch
  const pushResult = await Bun.$`git -C ${worktreePath} push -u origin ${finalBranch}`.quiet().nothrow();
  if (pushResult.exitCode !== 0) {
    throw new Error(`Push failed: ${pushResult.stderr.toString().trim()}`);
  }

  // Create PR
  const prResult = await Bun.$`gh pr create --base ${baseBranch} --head ${finalBranch} --title ${metadata.title} --body ${metadata.body}`.cwd(repoPath).quiet().nothrow();

  if (prResult.exitCode !== 0) {
    const stderr = prResult.stderr.toString().trim();
    throw new Error(`PR creation failed: ${stderr}`);
  }

  return {
    prUrl: prResult.stdout.toString().trim(),
    finalBranch,
  };
}

/**
 * Clean up a worktree and optionally delete the branch.
 */
export async function cleanupWorktree(
  repoPath: string,
  worktreePath: string,
  branch?: string,
): Promise<void> {
  await Bun.$`git -C ${repoPath} worktree remove ${worktreePath} --force`.quiet().nothrow();
  if (branch) {
    await Bun.$`git -C ${repoPath} branch -D ${branch}`.quiet().nothrow();
  }
}
