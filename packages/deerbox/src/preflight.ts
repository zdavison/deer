import { HOME } from "./constants";
import { createRequire } from "node:module";
import { accessSync } from "node:fs";
import { join } from "node:path";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
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
    errors.push("@anthropic-ai/sandbox-runtime not installed — run: bunx @zdavison/deer install");
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

  return { ok: errors.length === 0, errors, credentialType };
}

/**
 * Resolve credentials from all available sources, setting CLAUDE_CODE_OAUTH_TOKEN
 * or ANTHROPIC_API_KEY in process.env as a side effect.
 *
 * @duplicate src/preflight.ts — keep both in sync
 *
 * Resolution order (first match wins):
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var (already set)
 *   2. ~/.claude/agent-oauth-token flat file
 *   3. macOS Keychain (darwin only) — Claude Code stores OAuth here
 *   4. ~/.claude.json — Claude Code stores OAuth here on Linux
 *
 * OAuth always wins over API key: if an OAuth token is found, ANTHROPIC_API_KEY
 * is removed from the environment.
 *
 * @param homeDir - Home directory to use (defaults to HOME constant; overridable in tests)
 */
export async function resolveCredentials(homeDir = HOME): Promise<PreflightResult["credentialType"]> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // 1. Try the flat file (explicit override)
    const tokenFile = join(homeDir, ".claude", "agent-oauth-token");
    try {
      const f = Bun.file(tokenFile);
      if (await f.exists()) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = (await f.text()).trim();
      }
    } catch { /* ignore */ }
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && process.platform === "darwin") {
    // 2. Read from macOS Keychain where Claude Code stores subscription OAuth
    try {
      const p = Bun.spawn(
        ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { stdout: "pipe", stderr: "pipe" },
      );
      if ((await p.exited) === 0) {
        const raw = (await new Response(p.stdout).text()).trim();
        const creds = JSON.parse(raw);
        const accessToken = creds?.claudeAiOauth?.accessToken;
        if (typeof accessToken === "string" && accessToken.length > 0) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
        }
      }
    } catch { /* ignore — keychain unavailable or no entry */ }
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // 3. Read from ~/.claude.json where Claude Code stores OAuth on Linux
    try {
      const f = Bun.file(join(homeDir, ".claude.json"));
      if (await f.exists()) {
        const creds = JSON.parse(await f.text());
        const accessToken = creds?.claudeAiOauth?.accessToken;
        if (typeof accessToken === "string" && accessToken.length > 0) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
        }
      }
    } catch { /* ignore — file absent or malformed */ }
  }
  // Strip API key if OAuth is now available (OAuth always wins)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return "subscription";
  }
  if (process.env.ANTHROPIC_API_KEY) return "api-token";
  return "none";
}
