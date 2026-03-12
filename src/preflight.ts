import { HOME } from "./constants";
import { createRequire } from "node:module";
import { accessSync } from "node:fs";
import { join } from "node:path";
import { t } from "./i18n";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  credentialType: "subscription" | "api-token" | "none";
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
    errors.push(t("preflight_srt_missing"));
  }

  // Check platform-specific sandbox dependencies
  const isMac = process.platform === "darwin";
  if (isMac) {
    try {
      const p = Bun.spawn(["sandbox-exec", "-n", "no-network", "true"], { stdout: "pipe", stderr: "pipe" });
      const code = await p.exited;
      if (code !== 0) errors.push(t("preflight_sandbox_exec_broken"));
    } catch {
      errors.push(t("preflight_sandbox_exec_missing"));
    }
  } else {
    try {
      const p = Bun.spawn(["bwrap", "--version"], { stdout: "pipe", stderr: "pipe" });
      const code = await p.exited;
      if (code !== 0) {
        errors.push(t("preflight_bwrap_missing"));
      }
    } catch {
      errors.push(t("preflight_bwrap_missing"));
    }
  }

  // Check tmux
  try {
    const p = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push(t("preflight_tmux_missing"));
  } catch {
    errors.push(t("preflight_tmux_missing"));
  }

  // Check claude
  try {
    const p = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push(t("preflight_claude_missing"));
  } catch {
    errors.push(t("preflight_claude_missing"));
  }

  // Check gh auth
  try {
    const p = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push(t("preflight_gh_auth_missing"));
  } catch {
    errors.push(t("preflight_gh_missing"));
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
    errors.push(t("preflight_no_credentials"));
  }

  return { ok: errors.length === 0, errors, credentialType };
}
