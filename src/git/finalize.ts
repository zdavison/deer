/**
 * Post-session git operations: create PR on demand, clean up worktree.
 */

import { join } from "path";

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

export interface UpdatePROptions {
  repoPath: string;
  worktreePath: string;
  /** Already-finalized branch name, e.g. "deer/fix-login-bug" */
  finalBranch: string;
  baseBranch: string;
  prompt: string;
  /** @example "https://github.com/org/repo/pull/42" */
  prUrl: string;
}

interface PRMetadata {
  branchName: string;
  title: string;
  body: string;
}

/** Candidate paths to check for a PR template, in priority order. */
const PR_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "docs/pull_request_template.md",
  "pull_request_template.md",
];

/**
 * Find and read a GitHub PR template from the repo, if one exists.
 *
 * Checks standard GitHub-documented locations in priority order.
 * Falls back to the first file found in `.github/PULL_REQUEST_TEMPLATE/`.
 *
 * @returns Template content, or null if none found.
 */
export async function findPRTemplate(repoPath: string): Promise<string | null> {
  for (const candidate of PR_TEMPLATE_PATHS) {
    const file = Bun.file(join(repoPath, candidate));
    if (await file.exists()) return file.text();
  }

  // Check for directory-based templates
  const templateDir = join(repoPath, ".github", "PULL_REQUEST_TEMPLATE");
  try {
    const dirGlob = new Bun.Glob("*.md");
    for await (const name of dirGlob.scan({ cwd: templateDir, onlyFiles: true })) {
      return Bun.file(join(templateDir, name)).text();
    }
  } catch {
    // Directory does not exist
  }

  return null;
}

export function ensureDeerEmojiPrefix(title: string): string {
  if (title.startsWith("🦌 ")) return title;
  return `🦌 ${title}`;
}

/**
 * Ask Claude to generate PR metadata (branch name, title, body) from the diff.
 * Falls back to a simple prompt-based title if Claude fails.
 */
async function generatePRMetadata(worktreePath: string, baseBranch: string, prompt: string, prTemplate: string | null): Promise<PRMetadata> {
  // Fetch latest remote state so we compare against up-to-date origin
  await Bun.$`git -C ${worktreePath} fetch origin ${baseBranch}`.quiet().nothrow();
  const remoteBase = `origin/${baseBranch}`;

  const diffResult = await Bun.$`git -C ${worktreePath} diff ${remoteBase}..HEAD`.quiet().nothrow();
  const diff = diffResult.stdout.toString().trim();

  const logResult = await Bun.$`git -C ${worktreePath} log --oneline ${remoteBase}..HEAD`.quiet().nothrow();
  const commitLog = logResult.stdout.toString().trim();

  const maxDiffLen = 20_000;
  const truncatedDiff = diff.length > maxDiffLen
    ? diff.slice(0, maxDiffLen) + "\n... (diff truncated)"
    : diff;

  const templateSection = prTemplate
    ? `\nPR Template (use this structure for the body, filling in the relevant sections):\n${prTemplate}\n`
    : "";

  const bodyInstruction = prTemplate
    ? "body: follow the PR template structure above, filling in relevant sections based on the changes. End with a horizontal rule and \"> Created by [deer](https://github.com/mm-zacharydavison/deer) — review carefully.\""
    : "body: markdown with a ## Summary section describing what changed and why, followed by a ## Changes section with bullet points of key changes. End with a horizontal rule and \"> Created by [deer](https://github.com/mm-zacharydavison/deer) — review carefully.\"";

  const metadataPrompt = `You are generating metadata for a pull request. Analyze the following task prompt, commits, and diff, then produce EXACTLY the following JSON (no markdown fences, no extra text):

{"branchName": "<short-kebab-case-name>", "title": "<PR title under 70 chars>", "body": "<PR body in markdown>"}

Rules:
- branchName: short, descriptive, kebab-case (e.g. "fix-login-redirect", "add-user-search"). Do NOT include any prefix like "deer/" — just the name itself.
- title: concise, imperative mood (e.g. "Fix login redirect loop", "Add user search endpoint")
- ${bodyInstruction}
${templateSection}
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
  const prTemplate = await findPRTemplate(repoPath);
  const metadata = await generatePRMetadata(worktreePath, baseBranch, prompt, prTemplate);

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

export interface PushBranchOptions {
  worktreePath: string;
  /** @example "deer/fix-login-redirect" */
  branch: string;
}

/**
 * Push new commits (and any uncommitted changes) from the worktree to the
 * existing remote branch, updating the open PR without creating a new one.
 */
export async function pushBranchUpdates(options: PushBranchOptions): Promise<void> {
  const { worktreePath, branch } = options;

  // Remove deer internal files before staging
  await Bun.$`rm -rf ${worktreePath}/.deer-claude-config ${worktreePath}/.deer-prompt`.quiet().nothrow();

  // Stage and commit any uncommitted changes
  await Bun.$`git -C ${worktreePath} add -A`.quiet();
  const status = await Bun.$`git -C ${worktreePath} status --porcelain`.quiet();
  if (status.stdout.toString().trim().length > 0) {
    await Bun.$`git -C ${worktreePath} commit -m "deer: uncommitted changes from agent session"`.quiet();
  }

  // Push to origin
  const pushResult = await Bun.$`git -C ${worktreePath} push origin ${branch}`.quiet().nothrow();
  if (pushResult.exitCode !== 0) {
    throw new Error(`Push failed: ${pushResult.stderr.toString().trim()}`);
  }
}

/**
 * Update an existing PR: commit any new changes, push, and regenerate the
 * PR title and body from the latest diff.
 */
export async function updatePullRequest(options: UpdatePROptions): Promise<void> {
  const { repoPath, worktreePath, finalBranch, baseBranch, prompt, prUrl } = options;

  // Remove deer internal files before staging
  await Bun.$`rm -rf ${worktreePath}/.deer-claude-config ${worktreePath}/.deer-prompt`.quiet().nothrow();

  // Stage and commit any uncommitted changes
  await Bun.$`git -C ${worktreePath} add -A`.quiet();
  const status = await Bun.$`git -C ${worktreePath} status --porcelain`.quiet();
  if (status.stdout.toString().trim().length > 0) {
    await Bun.$`git -C ${worktreePath} commit -m "deer: uncommitted changes from agent session"`.quiet();
  }

  // Push the branch
  const pushResult = await Bun.$`git -C ${worktreePath} push origin ${finalBranch}`.quiet().nothrow();
  if (pushResult.exitCode !== 0) {
    throw new Error(`Push failed: ${pushResult.stderr.toString().trim()}`);
  }

  // Regenerate PR metadata from the updated diff
  const prTemplate = await findPRTemplate(repoPath);
  const metadata = await generatePRMetadata(worktreePath, baseBranch, prompt, prTemplate);

  // Update the PR title and body
  const editResult = await Bun.$`gh pr edit ${prUrl} --title ${metadata.title} --body ${metadata.body}`.cwd(repoPath).quiet().nothrow();
  if (editResult.exitCode !== 0) {
    throw new Error(`PR update failed: ${editResult.stderr.toString().trim()}`);
  }
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
