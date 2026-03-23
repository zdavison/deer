import { join } from "node:path";
import { HOME } from "./constants";

export type CredentialType = "subscription" | "api-token" | "none";

/**
 * Resolve credentials from all available sources, setting CLAUDE_CODE_OAUTH_TOKEN
 * or ANTHROPIC_API_KEY in process.env as a side effect.
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
export interface ResolveCredentialsOptions {
  homeDir?: string;
  skipKeychain?: boolean;
}

export async function resolveCredentials(
  homeDirOrOpts: string | ResolveCredentialsOptions = HOME,
): Promise<CredentialType> {
  const { homeDir, skipKeychain } =
    typeof homeDirOrOpts === "string"
      ? { homeDir: homeDirOrOpts, skipKeychain: false }
      : { homeDir: homeDirOrOpts.homeDir ?? HOME, skipKeychain: homeDirOrOpts.skipKeychain ?? false };
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
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !skipKeychain && process.platform === "darwin") {
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
