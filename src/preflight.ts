import { HOME } from "./constants";
import { createRequire } from "node:module";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  credentialType: "subscription" | "api-token" | "none";
}

export async function runPreflight(): Promise<PreflightResult> {
  const errors: string[] = [];

  // Check srt (Anthropic Sandbox Runtime)
  try {
    const require = createRequire(import.meta.url);
    require.resolve("@anthropic-ai/sandbox-runtime/dist/cli.js");
  } catch {
    errors.push("@anthropic-ai/sandbox-runtime not installed — run: bun add @anthropic-ai/sandbox-runtime");
  }

  // Check platform-specific sandbox dependencies
  const isMac = process.platform === "darwin";
  if (isMac) {
    try {
      const p = Bun.spawn(["sandbox-exec", "-n", "no-network", "true"], { stdout: "pipe", stderr: "pipe" });
      const code = await p.exited;
      if (code !== 0) errors.push("sandbox-exec not working — ensure /usr/bin is in PATH");
    } catch {
      errors.push("sandbox-exec not available — required on macOS for srt sandboxing");
    }
  } else {
    try {
      const p = Bun.spawn(["bwrap", "--version"], { stdout: "pipe", stderr: "pipe" });
      const code = await p.exited;
      if (code !== 0) {
        errors.push("bwrap not available — install bubblewrap (required by srt on Linux)");
      }
    } catch {
      errors.push("bwrap not available — install bubblewrap (required by srt on Linux)");
    }
  }

  // Check tmux
  try {
    const p = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("tmux not available");
  } catch {
    errors.push("tmux not available");
  }

  // Check claude
  try {
    const p = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("claude CLI not available");
  } catch {
    errors.push("claude CLI not available");
  }

  // Check gh auth
  try {
    const p = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("gh auth not configured — run 'gh auth login'");
  } catch {
    errors.push("gh CLI not available");
  }

  // Check credentials — OAuth token preferred, API key accepted as fallback.
  // Claude Code stores OAuth credentials in the macOS Keychain, which is
  // inaccessible from inside the sandbox. Extract the token on the host
  // and pass it via CLAUDE_CODE_OAUTH_TOKEN so sandboxed agents can auth.
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // 1. Try the flat file (legacy / explicit override)
    const tokenFile = `${HOME}/.claude/agent-oauth-token`;
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
  // Strip API key if OAuth is now available (OAuth always wins)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete process.env.ANTHROPIC_API_KEY;
  }
  let credentialType: PreflightResult["credentialType"] = "none";
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    credentialType = "subscription";
  } else if (process.env.ANTHROPIC_API_KEY) {
    credentialType = "api-token";
  } else {
    errors.push("No credentials — set CLAUDE_CODE_OAUTH_TOKEN, create ~/.claude/agent-oauth-token, or set ANTHROPIC_API_KEY");
  }

  return { ok: errors.length === 0, errors, credentialType };
}
