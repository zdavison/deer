/**
 * Post-session git operations: create PR on demand, clean up worktree.
 */

import { join } from "path";
import { MAX_DIFF_FOR_PR_METADATA, PR_METADATA_MODEL } from "../constants";
import { getPRLanguage } from "../i18n";

/**
 * Stage all changes without committing.
 */
async function stageChanges(worktreePath: string): Promise<void> {
  await Bun.$`git -C ${worktreePath} add -A`.quiet();
}

/**
 * Commit staged/unstaged changes if any exist. No-op if the worktree is clean.
 * @returns true if a commit was created, false if the worktree was clean.
 */
async function commitIfNeeded(worktreePath: string, message: string): Promise<boolean> {
  const status = await Bun.$`git -C ${worktreePath} status --porcelain`.quiet();
  if (status.stdout.toString().trim().length > 0) {
    await Bun.$`git -C ${worktreePath} commit -m ${message}`.quiet();
    return true;
  }
  return false;
}

/**
 * Stage all changes and commit if there are uncommitted modifications.
 * No-op if the worktree is clean.
 * @returns true if a commit was created, false if the worktree was clean.
 */
async function stageAndCommit(worktreePath: string, message = "deer: uncommitted changes from agent session"): Promise<boolean> {
  await stageChanges(worktreePath);
  return commitIfNeeded(worktreePath, message);
}

/**
 * Push a branch to origin, throwing on failure.
 */
async function pushBranch(worktreePath: string, branch: string, setUpstream = false): Promise<void> {
  const result = setUpstream
    ? await Bun.$`git -C ${worktreePath} push -u origin ${branch}`.quiet().nothrow()
    : await Bun.$`git -C ${worktreePath} push origin ${branch}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Push failed: ${result.stderr.toString().trim()}`);
  }
}

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
  /** Verbose log callback for diagnostics */
  onLog?: (message: string) => void;
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
  /** Verbose log callback for diagnostics */
  onLog?: (message: string) => void;
}

interface PRMetadata {
  branchName: string;
  title: string;
  body: string;
}

/** Placeholder commit message used while PR metadata is being generated. */
const PENDING_PR_METADATA_MSG = "deer: pending PR metadata";

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
async function generatePRMetadata(worktreePath: string, baseBranch: string, prompt: string, prTemplate: string | null, onLog?: (msg: string) => void): Promise<PRMetadata> {
  // Fetch latest remote state so we compare against up-to-date origin
  await Bun.$`git -C ${worktreePath} fetch origin ${baseBranch}`.quiet().nothrow();
  const remoteBase = `origin/${baseBranch}`;

  // Use the merge-base (three-dot equivalent) so the diff matches exactly what
  // GitHub will show in the PR — only the agent's changes since diverging from
  // origin, regardless of where the local base branch was when the worktree
  // was created.
  const mergeBaseResult = await Bun.$`git -C ${worktreePath} merge-base ${remoteBase} HEAD`.quiet().nothrow();
  const mergeBase = mergeBaseResult.stdout.toString().trim() || remoteBase;

  const diffResult = await Bun.$`git -C ${worktreePath} diff ${mergeBase}..HEAD`.quiet().nothrow();
  const diff = diffResult.stdout.toString().trim();

  const logResult = await Bun.$`git -C ${worktreePath} log --oneline ${mergeBase}..HEAD`.quiet().nothrow();
  const commitLog = logResult.stdout.toString().trim();

  // Get the list of actually changed files for the prompt
  const filesResult = await Bun.$`git -C ${worktreePath} diff --name-only ${mergeBase}..HEAD`.quiet().nothrow();
  const changedFiles = filesResult.stdout.toString().trim();

  const truncatedDiff = diff.length > MAX_DIFF_FOR_PR_METADATA
    ? diff.slice(0, MAX_DIFF_FOR_PR_METADATA) + "\n... (diff truncated)"
    : diff;

  const templateSection = prTemplate
    ? `\nPR Template (use this structure for the body, filling in the relevant sections):\n${prTemplate}\n`
    : "";

  const bodyInstruction = prTemplate
    ? "body: follow the PR template structure above, filling in each section based on what the commits and diff ACTUALLY show was done — not based on the task prompt alone. The task prompt tells you what was requested; the diff and commits tell you what was actually implemented. Start with a ## Task section containing the original task prompt as a blockquote. End with a horizontal rule and \"> Created by [deer](https://github.com/zdavison/deer) — review carefully.\""
    : "body: markdown starting with a ## Task section containing the original task prompt as a blockquote, followed by a ## Summary section describing what changed and why, then a ## Changes section with bullet points of key changes. End with a horizontal rule and \"> Created by [deer](https://github.com/zdavison/deer) — review carefully.\"";

  const prLang = getPRLanguage();
  const languageRule = prLang
    ? `\n- Language: Write the title and body in ${prLang}. branchName must remain short kebab-case ASCII English regardless of language.`
    : "";

  const metadataPrompt = `You are generating metadata for a pull request. Analyze the following task prompt, commits, and diff, then produce EXACTLY the following JSON (no markdown fences, no extra text):

{"branchName": "<short-kebab-case-name>", "title": "<PR title under 70 chars>", "body": "<PR body in markdown>"}

Rules:
- branchName: short, descriptive, kebab-case (e.g. "fix-login-redirect", "add-user-search"). Do NOT include any prefix like "deer/" — just the name itself.
- title: concise, imperative mood (e.g. "Fix login redirect loop", "Add user search endpoint")
- ${bodyInstruction}
- CRITICAL: The Changes section MUST only reference files that actually appear in the diff below. Do NOT infer or guess file changes based on the task prompt. The changed files are EXACTLY: ${changedFiles || "(none)"}${languageRule}
${templateSection}
Task prompt:
${prompt}

Commits:
${commitLog}

Changed files:
${changedFiles}

Diff:
${truncatedDiff}`;

  try {
    const proc = Bun.spawn(["claude", "-p", metadataPrompt, "--model", PR_METADATA_MODEL, "--output-format", "json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      // Run in /tmp so this doesn't pollute the user's project history in ~/.claude/projects/.
      // Also explicitly set PWD so claude uses /tmp for its project path rather than inheriting
      // the parent process's working directory.
      cwd: "/tmp",
      env: { ...process.env, PWD: "/tmp" },
    });
    // Read stdout and stderr concurrently with process exit — reading after proc.exited
    // can return empty in Bun because unread pipe data may be discarded on process exit.
    const [exitCode, rawOutput, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`claude exited ${exitCode}: ${stderrText.trim()}`);
    const output = rawOutput.trim();

    let text = output;
    try {
      const wrapper = JSON.parse(output);
      if (wrapper.result) text = wrapper.result;
    } catch {
      // Not wrapped, use as-is
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON found in Claude response: ${text.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.branchName || !parsed.title || !parsed.body) {
      throw new Error("Missing required fields in Claude response");
    }

    return {
      branchName: parsed.branchName.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
      title: ensureDeerEmojiPrefix(parsed.title.slice(0, 70)),
      body: parsed.body,
    };
  } catch (err) {
    onLog?.(`[pr] generatePRMetadata failed (using fallback): ${err instanceof Error ? err.message : String(err)}`);
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
      "> Created by [deer](https://github.com/zdavison/deer) — review carefully.",
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
  const { repoPath, worktreePath, branch, baseBranch, prompt, onLog } = options;
  const log = onLog ?? (() => {});

  // Stage and commit all changes first so they're visible in the diff used for
  // PR metadata generation. We commit with a temporary message, then amend with
  // the real title once Claude generates the PR metadata.
  log(`[pr] Staging and committing changes...`);
  const hadUncommitted = await stageAndCommit(worktreePath, PENDING_PR_METADATA_MSG);

  // Generate PR metadata using Claude (diff now includes all committed changes)
  log(`[pr] Finding PR template...`);
  const prTemplate = await findPRTemplate(repoPath);
  log(`[pr] PR template: ${prTemplate ? "found" : "none"}`);

  log(`[pr] Generating PR metadata via Claude...`);
  const metadata = await generatePRMetadata(worktreePath, baseBranch, prompt, prTemplate, onLog);
  log(`[pr] Metadata: branch=${metadata.branchName} title=${metadata.title}`);

  // Amend the placeholder commit with the real PR title. Also amend if HEAD
  // already has the placeholder message from a previously interrupted attempt
  // (stageAndCommit would have found nothing to commit in that case).
  const headMsgResult = await Bun.$`git -C ${worktreePath} log -1 --format=%s`.quiet().nothrow();
  const headMsg = headMsgResult.stdout.toString().trim();
  if (hadUncommitted || headMsg === PENDING_PR_METADATA_MSG) {
    log(`[pr] Updating commit message...`);
    await Bun.$`git -C ${worktreePath} commit --amend -m ${metadata.title}`.quiet();
  }

  // Rename the branch if Claude provided a name
  let finalBranch = branch;
  if (metadata.branchName) {
    const newBranch = `deer/${metadata.branchName}`;
    log(`[pr] Renaming branch ${branch} → ${newBranch}`);
    const renameResult = await Bun.$`git -C ${worktreePath} branch -m ${newBranch}`.quiet().nothrow();
    if (renameResult.exitCode === 0) {
      finalBranch = newBranch;
    } else {
      log(`[pr] Branch rename failed (exit ${renameResult.exitCode}): ${renameResult.stderr.toString().trim()}`);
    }
  }

  log(`[pr] Pushing branch ${finalBranch}...`);
  await pushBranch(worktreePath, finalBranch, true);
  log(`[pr] Push succeeded`);

  // Create PR
  log(`[pr] Running gh pr create --base ${baseBranch} --head ${finalBranch}...`);
  const prResult = await Bun.$`gh pr create --base ${baseBranch} --head ${finalBranch} --title ${metadata.title} --body ${metadata.body}`.cwd(repoPath).quiet().nothrow();

  if (prResult.exitCode !== 0) {
    const stderr = prResult.stderr.toString().trim();
    log(`[pr] gh pr create failed (exit ${prResult.exitCode}): ${stderr}`);
    throw new Error(`PR creation failed: ${stderr}`);
  }

  const prUrl = prResult.stdout.toString().trim();
  log(`[pr] PR created: ${prUrl}`);

  return {
    prUrl,
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

  await stageAndCommit(worktreePath);
  await pushBranch(worktreePath, branch);
}

/**
 * Update an existing PR: commit any new changes, push, and regenerate the
 * PR title and body from the latest diff.
 */
export async function updatePullRequest(options: UpdatePROptions): Promise<void> {
  const { repoPath, worktreePath, finalBranch, baseBranch, prompt, prUrl, onLog } = options;
  const log = onLog ?? (() => {});

  // Remove deer internal files before staging
  await Bun.$`rm -rf ${worktreePath}/.deer-claude-config ${worktreePath}/.deer-prompt`.quiet().nothrow();

  // Stage and commit changes so the diff used for metadata generation is complete.
  log(`[pr] Staging and committing changes...`);
  const hadUncommitted = await stageAndCommit(worktreePath, PENDING_PR_METADATA_MSG);

  // Regenerate PR metadata from the updated diff
  log(`[pr] Finding PR template...`);
  const prTemplate = await findPRTemplate(repoPath);
  log(`[pr] PR template: ${prTemplate ? "found" : "none"}`);

  log(`[pr] Generating PR metadata via Claude...`);
  const metadata = await generatePRMetadata(worktreePath, baseBranch, prompt, prTemplate, onLog);
  log(`[pr] Metadata: title=${metadata.title}`);

  // Amend the placeholder commit with the real PR title. Also amend if HEAD
  // already has the placeholder message from a previously interrupted attempt.
  const headMsgResult = await Bun.$`git -C ${worktreePath} log -1 --format=%s`.quiet().nothrow();
  const headMsg = headMsgResult.stdout.toString().trim();
  if (hadUncommitted || headMsg === PENDING_PR_METADATA_MSG) {
    log(`[pr] Updating commit message...`);
    await Bun.$`git -C ${worktreePath} commit --amend -m ${metadata.title}`.quiet();
  }

  log(`[pr] Pushing branch ${finalBranch}...`);
  await pushBranch(worktreePath, finalBranch);
  log(`[pr] Push succeeded`);

  // Update the PR title and body
  log(`[pr] Running gh pr edit ${prUrl}...`);
  const editResult = await Bun.$`gh pr edit ${prUrl} --title ${metadata.title} --body ${metadata.body}`.cwd(repoPath).quiet().nothrow();
  if (editResult.exitCode !== 0) {
    const stderr = editResult.stderr.toString().trim();
    log(`[pr] gh pr edit failed (exit ${editResult.exitCode}): ${stderr}`);
    throw new Error(`PR update failed: ${stderr}`);
  }
  log(`[pr] PR updated: ${prUrl}`);
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
