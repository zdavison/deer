/**
 * Post-session git operations: create PR on demand, push branches.
 */

import { join } from "path";
import { MAX_DIFF_FOR_PR_METADATA, PR_METADATA_MODEL } from "../constants";
import { getPRLanguage } from "../i18n";
import { resolveCredentials } from "../credentials";

/**
 * Stage all changes without committing.
 */
async function stageChanges(worktreePath: string): Promise<void> {
  const result = await Bun.$`git -C ${worktreePath} add -A`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`git add failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
}

/**
 * Try a git commit, retrying with --no-verify if it fails.
 */
async function commitWithFallback(
  worktreePath: string,
  args: string[],
  onLog?: (msg: string) => void,
): Promise<void> {
  const baseCmd = ["git", "-C", worktreePath, "commit", ...args];
  const result = await Bun.spawn(baseCmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await result.exited;
  if (exitCode === 0) return;

  const stderr = await new Response(result.stderr).text();
  onLog?.(`[pr] git commit failed, retrying with --no-verify: ${stderr.trim().split("\n")[0]}`);

  const retry = await Bun.spawn(
    ["git", "-C", worktreePath, "commit", "--no-verify", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const retryExit = await retry.exited;
  if (retryExit === 0) return;
  const retryStderr = await new Response(retry.stderr).text();
  throw new Error(`git commit failed (exit ${retryExit}): ${retryStderr.trim()}`);
}

/**
 * Commit staged/unstaged changes if any exist. No-op if the worktree is clean.
 * @returns true if a commit was created, false if the worktree was clean.
 */
async function commitIfNeeded(worktreePath: string, message: string, onLog?: (msg: string) => void): Promise<boolean> {
  const status = await Bun.$`git -C ${worktreePath} status --porcelain`.quiet().nothrow();
  if (status.stdout.toString().trim().length > 0) {
    await commitWithFallback(worktreePath, ["-m", message], onLog);
    return true;
  }
  return false;
}

/**
 * Stage all changes and commit if there are uncommitted modifications.
 * No-op if the worktree is clean.
 * @returns true if a commit was created, false if the worktree was clean.
 */
async function stageAndCommit(worktreePath: string, message = "deer: uncommitted changes from agent session", onLog?: (msg: string) => void): Promise<boolean> {
  await stageChanges(worktreePath);
  return commitIfNeeded(worktreePath, message, onLog);
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
  /** The task prompt, or null if the session was started interactively without a prompt. */
  prompt: string | null;
  /** Verbose log callback for diagnostics */
  onLog?: (message: string) => void;
}

export interface UpdatePROptions {
  repoPath: string;
  worktreePath: string;
  /** Already-finalized branch name, e.g. "deer/fix-login-bug" */
  finalBranch: string;
  baseBranch: string;
  /** The task prompt, or null if the session was started interactively without a prompt. */
  prompt: string | null;
  /** @example "https://github.com/org/repo/pull/42" */
  prUrl: string;
  /** Verbose log callback for diagnostics */
  onLog?: (message: string) => void;
  /**
   * Override for PR authorship check. Defaults to querying the GitHub API.
   * Inject a mock in tests to control whether the title/body update is skipped.
   * @default isPRAuthor
   */
  prAuthorCheck?: (prUrl: string, repoPath: string) => Promise<boolean>;
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
 * Build a clean subprocess environment for the claude metadata subprocess.
 *
 * Strips sandbox proxy vars that would route claude through the SRT MITM proxy
 * (which only works inside the sandbox, not for host-level processes). Also
 * removes the placeholder token so the subprocess falls back to real credentials.
 *
 * @param env - Source environment (typically process.env)
 */
export function buildClaudeSubprocessEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) result[k] = v;
  }
  // Strip SRT sandbox proxy routing vars — these point to the per-sandbox MITM proxy
  // which is not accessible from the host process that runs this metadata generation.
  delete result.ANTHROPIC_BASE_URL;
  delete result.CLAUDE_CODE_HOST_HTTP_PROXY_PORT;
  delete result.CLAUDE_CODE_HOST_SOCKS_PROXY_PORT;
  // Strip the placeholder token — "proxy-managed" is not a real credential.
  // resolveCredentials() will have set the real token in process.env before this runs.
  if (result.CLAUDE_CODE_OAUTH_TOKEN === "proxy-managed") {
    delete result.CLAUDE_CODE_OAUTH_TOKEN;
  }
  result.PWD = "/tmp";
  return result;
}

/**
 * Parse the raw JSON output from `claude -p --output-format json` into PR metadata fields.
 * Handles both the wrapped format (outer JSON envelope with `result` field) and
 * unwrapped format (direct JSON object).
 *
 * @throws if no JSON object is found or required fields are missing
 */
export function parsePRMetadataResponse(rawOutput: string): { branchName: string; title: string; body: string } {
  const output = rawOutput.trim();
  let text = output;
  try {
    const wrapper = JSON.parse(output);
    if (wrapper.result) text = wrapper.result;
  } catch {
    // Not wrapped — use the raw output as-is
  }

  const jsonStr = extractFirstJsonObject(text);
  if (!jsonStr) throw new Error(`No JSON found in Claude response: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(jsonStr);
  if (!parsed.branchName || !parsed.title || !parsed.body) {
    throw new Error("Missing required fields in Claude response");
  }
  return { branchName: parsed.branchName, title: parsed.title, body: parsed.body };
}

/**
 * Extract the first balanced JSON object from a string.
 * Tracks brace depth and respects string boundaries, so braces inside
 * JSON string values don't break extraction.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Ask Claude to generate PR metadata (branch name, title, body) from the diff.
 * Falls back to a simple prompt-based title if Claude fails.
 */
async function generatePRMetadata(worktreePath: string, baseBranch: string, prompt: string | null, prTemplate: string | null, onLog?: (msg: string) => void): Promise<PRMetadata> {
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
    ? (prompt
        ? "body: follow the PR template structure above, filling in each section based on what the commits and diff ACTUALLY show was done — not based on the task prompt alone. The task prompt tells you what was requested; the diff and commits tell you what was actually implemented. Start with a ## Task section containing the original task prompt as a blockquote. End with a horizontal rule and \"> Created by [deer](https://github.com/zdavison/deer) — review carefully.\""
        : "body: follow the PR template structure above, filling in each section based on what the commits and diff ACTUALLY show was done. End with a horizontal rule and \"> Created by [deer](https://github.com/zdavison/deer) — review carefully.\"")
    : (prompt
        ? "body: markdown starting with a ## Task section containing the original task prompt as a blockquote, followed by a ## Summary section describing what changed and why, then a ## Changes section with bullet points of key changes. End with a horizontal rule and \"> Created by [deer](https://github.com/zdavison/deer) — review carefully.\""
        : "body: markdown starting with a ## Summary section describing what changed and why, then a ## Changes section with bullet points of key changes. End with a horizontal rule and \"> Created by [deer](https://github.com/zdavison/deer) — review carefully.\"");

  const prLang = getPRLanguage();
  const languageRule = prLang
    ? `\n- Language: Write the title and body in ${prLang}. branchName must remain short kebab-case ASCII English regardless of language.`
    : "";

  const taskPromptSection = prompt ? `\nTask prompt:\n${prompt}\n` : "";

  const metadataPrompt = `You are generating metadata for a pull request. Analyze the following commits and diff, then produce EXACTLY the following JSON (no markdown fences, no extra text):

{"branchName": "<short-kebab-case-name>", "title": "<PR title under 70 chars>", "body": "<PR body in markdown>"}

Rules:
- branchName: short, descriptive, kebab-case (e.g. "fix-login-redirect", "add-user-search"). Do NOT include any prefix like "deer/" — just the name itself.
- title: concise, imperative mood (e.g. "Fix login redirect loop", "Add user search endpoint")
- ${bodyInstruction}
- CRITICAL: The Changes section MUST only reference files that actually appear in the diff below. Do NOT infer or guess file changes based on the task prompt. The changed files are EXACTLY: ${changedFiles || "(none)"}${languageRule}
${templateSection}${taskPromptSection}
Commits:
${commitLog}

Changed files:
${changedFiles}

Diff:
${truncatedDiff}`;

  try {
    // Ensure real credentials are in process.env before spawning — reads from
    // ~/.claude.json if CLAUDE_CODE_OAUTH_TOKEN is not already set in the environment.
    await resolveCredentials();

    // Build a clean env that strips sandbox proxy vars. When the deer TUI is launched
    // from within a deer agent session (or any context where SRT sandbox env vars have
    // been inherited), ANTHROPIC_BASE_URL points to the per-sandbox MITM proxy which is
    // not accessible for this host-level subprocess. Stripping it ensures claude connects
    // directly to the real Anthropic API.
    const subprocessEnv = buildClaudeSubprocessEnv(process.env);

    const proc = Bun.spawn(["claude", "-p", metadataPrompt, "--model", PR_METADATA_MODEL, "--output-format", "json", "--no-session-persistence"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      // Run in /tmp so this doesn't pollute the user's project history in ~/.claude/projects/.
      cwd: "/tmp",
      env: subprocessEnv,
    });
    // Read stdout and stderr concurrently with process exit — reading after proc.exited
    // can return empty in Bun because unread pipe data may be discarded on process exit.
    const [exitCode, rawOutput, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      const preview = rawOutput.trim().slice(0, 200);
      throw new Error(`claude exited ${exitCode}: ${stderrText.trim()}${preview ? ` (stdout: ${preview})` : ""}`);
    }

    const parsed = parsePRMetadataResponse(rawOutput);
    return {
      branchName: parsed.branchName.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
      title: ensureDeerEmojiPrefix(parsed.title.slice(0, 70)),
      body: parsed.body,
    };
  } catch (err) {
    onLog?.(`[pr] generatePRMetadata failed (using fallback): ${err instanceof Error ? err.message : String(err)}`);
    const clean = prompt ? prompt.replace(/\n/g, " ").trim() : "Interactive session";
    const title = ensureDeerEmojiPrefix(clean.length > 65 ? clean.slice(0, 62) + "..." : clean);
    const taskSection = prompt
      ? [`> ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`, ""]
      : [];
    const body = [
      "## Summary",
      "",
      ...taskSection,
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
  const hadUncommitted = await stageAndCommit(worktreePath, PENDING_PR_METADATA_MSG, onLog);

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
    await commitWithFallback(worktreePath, ["--amend", "-m", metadata.title], onLog);
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
  /**
   * Set upstream tracking on first push.
   * @default false
   */
  setUpstream?: boolean;
}

/**
 * Push new commits (and any uncommitted changes) from the worktree to the
 * existing remote branch, updating the open PR without creating a new one.
 */
export async function pushBranchUpdates(options: PushBranchOptions): Promise<void> {
  const { worktreePath, branch, setUpstream = false } = options;

  // Remove deer internal files before staging
  await Bun.$`rm -rf ${worktreePath}/.deer-claude-config ${worktreePath}/.deer-prompt`.quiet().nothrow();

  await stageAndCommit(worktreePath);
  await pushBranch(worktreePath, branch, setUpstream);
}

/**
 * Returns true if the two GitHub login strings refer to the same user.
 * Defaults to true (can update) when either login is unknown/empty, so a
 * gh API failure doesn't silently block pushes.
 */
export function isPRAuthorFromLogins(currentLogin: string, authorLogin: string): boolean {
  if (!currentLogin || !authorLogin) return true;
  return currentLogin === authorLogin;
}

/**
 * Returns true if the authenticated GitHub user is the author of the given PR.
 * Defaults to true on any gh API error so that failed lookups don't block pushes.
 */
export async function isPRAuthor(prUrl: string, repoPath: string): Promise<boolean> {
  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) return true;
  const [, owner, repo, prNumber] = prMatch;

  const [currentUserResult, prAuthorResult] = await Promise.all([
    Bun.$`gh api user --jq .login`.cwd(repoPath).quiet().nothrow(),
    Bun.$`gh api repos/${owner}/${repo}/pulls/${prNumber} --jq .user.login`.cwd(repoPath).quiet().nothrow(),
  ]);

  const currentLogin = currentUserResult.stdout.toString().trim();
  const authorLogin = prAuthorResult.stdout.toString().trim();
  return isPRAuthorFromLogins(currentLogin, authorLogin);
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
  const hadUncommitted = await stageAndCommit(worktreePath, PENDING_PR_METADATA_MSG, onLog);

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
    await commitWithFallback(worktreePath, ["--amend", "-m", metadata.title], onLog);
  }

  log(`[pr] Pushing branch ${finalBranch}...`);
  await pushBranch(worktreePath, finalBranch);
  log(`[pr] Push succeeded`);

  // Only update title/body if we own the PR — GitHub silently ignores PATCH
  // requests on PRs authored by other users when called by a non-admin.
  const checkAuthor = options.prAuthorCheck ?? isPRAuthor;
  const isAuthor = await checkAuthor(prUrl, repoPath);

  if (!isAuthor) {
    log(`[pr] Skipping PR title/body update: PR was authored by a different user`);
    return;
  }

  // Update the PR title and body via REST API to avoid deprecated projectCards GraphQL query
  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) throw new Error(`Could not parse PR URL: ${prUrl}`);
  const [, owner, repo, prNumber] = prMatch;

  log(`[pr] Updating PR ${owner}/${repo}#${prNumber} via REST API...`);
  const editResult = await Bun.$`gh api repos/${owner}/${repo}/pulls/${prNumber} --method PATCH -f title=${metadata.title} -f body=${metadata.body}`.cwd(repoPath).quiet().nothrow();
  if (editResult.exitCode !== 0) {
    const stderr = editResult.stderr.toString().trim();
    log(`[pr] gh api PATCH failed (exit ${editResult.exitCode}): ${stderr}`);
    throw new Error(`PR update failed: ${stderr}`);
  }
  log(`[pr] PR updated: ${prUrl}`);
}

/**
 * Check whether a worktree has any changes (committed or uncommitted) relative
 * to a base branch or a specific commit. Used to decide whether to offer PR creation.
 *
 * @param sinceCommit - If provided, compare against this commit SHA instead of
 *   baseBranch. Used with `--from` to detect only new changes made during the
 *   session, ignoring commits that already existed on the branch.
 */
export interface MergeIntoLocalBranchOptions {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  targetBranch: string;
  prompt: string | null;
  onLog?: (message: string) => void;
}

/**
 * Merge the session branch into a local branch (e.g. main).
 *
 * Mirrors the createPullRequest flow: stages uncommitted changes, generates an
 * AI commit message via Claude, amends the placeholder commit, then merges
 * into targetBranch with --no-ff.
 */
export async function mergeIntoLocalBranch(options: MergeIntoLocalBranchOptions): Promise<void> {
  const { repoPath, worktreePath, branch, baseBranch, targetBranch, prompt, onLog } = options;
  const log = onLog ?? (() => {});

  // Stage and commit all changes with a placeholder message (same as PR flow)
  log(`[merge] Staging and committing changes...`);
  const hadUncommitted = await stageAndCommit(worktreePath, PENDING_PR_METADATA_MSG, onLog);

  // Generate metadata via Claude for a proper commit message
  log(`[merge] Generating commit message via Claude...`);
  const metadata = await generatePRMetadata(worktreePath, baseBranch, prompt, null, onLog);
  log(`[merge] Commit message: ${metadata.title}`);

  // Amend the placeholder commit with the real title
  const headMsgResult = await Bun.$`git -C ${worktreePath} log -1 --format=%s`.quiet().nothrow();
  const headMsg = headMsgResult.stdout.toString().trim();
  if (hadUncommitted || headMsg === PENDING_PR_METADATA_MSG) {
    log(`[merge] Updating commit message...`);
    await commitWithFallback(worktreePath, ["--amend", "-m", metadata.title], onLog);
  }

  // Checkout target branch and merge
  log(`[merge] Checking out ${targetBranch}...`);
  await Bun.$`git -C ${repoPath} checkout ${targetBranch}`.quiet();

  log(`[merge] Merging ${branch} into ${targetBranch}...`);
  await Bun.$`git -C ${repoPath} merge ${branch} --no-ff`.quiet();
}

export async function hasChanges(worktreePath: string, baseBranch: string, sinceCommit?: string): Promise<boolean> {
  // Check for uncommitted changes
  const statusResult = await Bun.$`git -C ${worktreePath} status --porcelain`.quiet().nothrow();
  if (statusResult.stdout.toString().trim().length > 0) return true;

  // Check for commits beyond the reference point
  const ref = sinceCommit ?? baseBranch;
  const logResult = await Bun.$`git -C ${worktreePath} log --oneline ${ref}..HEAD`.quiet().nothrow();
  return logResult.stdout.toString().trim().length > 0;
}
