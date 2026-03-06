/**
 * Credential mode for Claude API access.
 * - "api-key"  — using ANTHROPIC_API_KEY
 * - "oauth"    — using CLAUDE_CODE_OAUTH_TOKEN (Claude subscription)
 * - "none"     — no credentials detected
 */
export type CredentialMode = "api-key" | "oauth" | "none";

/**
 * Detects which credential mode is available.
 *
 * Priority: ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN > ~/.claude/agent-oauth-token file.
 * When an OAuth token is loaded from the file, it is written into CLAUDE_CODE_OAUTH_TOKEN
 * so the rest of the process can use it without re-reading the file.
 *
 * @param home - Override for HOME directory (for testing)
 */
export async function resolveCredentialMode(home?: string): Promise<CredentialMode> {
  if (process.env.ANTHROPIC_API_KEY) return "api-key";
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "oauth";

  const tokenFile = `${home ?? process.env.HOME ?? ""}/.claude/agent-oauth-token`;
  try {
    const f = Bun.file(tokenFile);
    if (await f.exists()) {
      const token = (await f.text()).trim();
      if (token) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
        return "oauth";
      }
    }
  } catch { /* ignore */ }

  return "none";
}
