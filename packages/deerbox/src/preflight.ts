import { HOME } from "@deer/shared";
import { resolveCredentials } from "@deer/shared";
import { createRequire } from "node:module";
import { accessSync } from "node:fs";
import { join } from "node:path";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  credentialType: "subscription" | "api-token" | "none";
}

/** Run a command and return an error string if it fails, or null on success. */
async function checkCmd(cmd: string[], errorMsg: string): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    return (await p.exited) === 0 ? null : errorMsg;
  } catch {
    return errorMsg;
  }
}

export async function runPreflight(): Promise<PreflightResult> {
  const errors: string[] = [];

  // Check srt (Anthropic Sandbox Runtime)
  // Search local node_modules (dev) then deer data dir (compiled binary)
  let srtFound = false;
  try {
    const require = createRequire(import.meta.url);
    require.resolve("@anthropic-ai/sandbox-runtime/dist/cli.js");
    srtFound = true;
  } catch { /* not in local node_modules */ }
  if (!srtFound) {
    try {
      accessSync(join(HOME, ".local", "share", "deer", "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js"));
      srtFound = true;
    } catch { /* not in deer data dir either */ }
  }
  if (!srtFound) {
    errors.push("@anthropic-ai/sandbox-runtime not installed — run: curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash");
  }

  // Check platform-specific sandbox dependencies
  if (process.platform === "darwin") {
    const err = await checkCmd(
      ["sandbox-exec", "-n", "no-network", "true"],
      "sandbox-exec not available — required on macOS for srt sandboxing",
    );
    if (err) errors.push(err);
  } else {
    const err = await checkCmd(
      ["bwrap", "--version"],
      "bwrap not available — install bubblewrap (required by srt on Linux)",
    );
    if (err) errors.push(err);
  }

  // Check claude
  const claudeErr = await checkCmd(["claude", "--version"], "claude CLI not available");
  if (claudeErr) errors.push(claudeErr);

  // Check gh auth
  const ghErr = await checkCmd(["gh", "auth", "token"], "gh auth not configured — run 'gh auth login'");
  if (ghErr) errors.push(ghErr);

  // Check credentials — OAuth token preferred, API key accepted as fallback.
  const credentialType = await resolveCredentials();
  if (credentialType === "none") {
    errors.push("No credentials — set CLAUDE_CODE_OAUTH_TOKEN, create ~/.claude/agent-oauth-token, or set ANTHROPIC_API_KEY");
  }

  // Warn if ~/.claude.json contains OAuth credentials. The file is readable
  // inside the sandbox (Claude Code needs its settings), but tokens should
  // only live in .credentials.json / agent-oauth-token which are deny-listed.
  const warnings: string[] = [];
  try {
    const claudeJson = await Bun.file(join(HOME, ".claude.json")).json();
    if (typeof claudeJson?.claudeAiOauth?.accessToken === "string" && claudeJson.claudeAiOauth.accessToken.length > 0) {
      warnings.push(
        "~/.claude.json contains OAuth credentials (claudeAiOauth.accessToken) — this file is readable inside the sandbox. Move tokens to ~/.claude/.credentials.json instead.",
      );
    }
  } catch {
    // File doesn't exist or isn't valid JSON — nothing to warn about
  }

  return { ok: errors.length === 0, errors, warnings, credentialType };
}
