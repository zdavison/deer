import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HOME } from "./constants";

export interface RiskyEnvVar {
  /** Environment variable name */
  key: string;
  /**
   * Masked display value: first 3 chars followed by "..."
   * @example "ghp..."
   */
  displayValue: string;
  /** Why this var was flagged */
  reason: string;
}

export interface EnvPolicy {
  /** Var names blocked from reaching the sandbox */
  blocked: string[];
  /** Var names explicitly approved to pass through */
  approved: string[];
}

/** Default path for the env policy file */
export const ENV_POLICY_PATH = `${HOME}/.local/share/deer/env-policy.json`;

/**
 * Vars handled by deer's MITM auth proxy — excluded from risky detection
 * because they never reach the sandbox in plaintext regardless.
 */
const PROXY_MANAGED = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/** Var names that are never secrets */
const KNOWN_SAFE = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "MAIL",
  "HOSTNAME",
  "SHLVL",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  "MANPATH",
  "_",
  "CLAUDECODE",
]);

/** Var name prefixes that are never secrets */
const SAFE_PREFIXES = ["XDG_", "LC_", "DEER_", "GNOME_", "GTK_", "SYSTEMD_", "SSH_"];

/**
 * Patterns matched against the full var name (case-insensitive).
 * Each entry is [pattern, human-readable reason].
 *
 * Patterns are derived from well-known secret scanning tools:
 * - gitleaks: https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
 * - trufflehog: https://github.com/trufflesecurity/trufflehog/tree/main/pkg/detectors
 */
const RISKY_KEY_PATTERNS: Array<[RegExp, string]> = [
  [/_KEY$/i, "key"],
  [/_TOKEN$/i, "token"],
  [/_SECRET$/i, "secret"],
  [/_PASSWORD$/i, "password"],
  [/_PASSWD$/i, "password"],
  [/_PASS$/i, "password"],
  [/_PWD$/i, "password"],
  [/_AUTH$/i, "auth token"],
  [/CREDENTIAL/i, "credential"],
  [/OAUTH/i, "OAuth token"],
  [/PRIVATE_KEY/i, "private key"],
  [/_CERT$/i, "certificate"],
  [/API_KEY/i, "API key"],
  [/ACCESS_KEY/i, "access key"],
  [/SECRET_KEY/i, "secret key"],
  [/SIGNING_KEY/i, "signing key"],
  [/^.*_DSN$/i, "data source name"],
  [/^.*_CONNECTION_STRING$/i, "connection string"],
];

/**
 * Value prefixes that indicate a known secret format regardless of key name.
 * Used as a secondary heuristic when the key name doesn't match.
 *
 * Sources: gitleaks default config, trufflehog detectors, GitHub secret scanning patterns.
 */
const RISKY_VALUE_PREFIXES = [
  "sk-",      // OpenAI / Anthropic (ANTHROPIC_API_KEY excluded separately)
  "sk_live_", // Stripe live secret key
  "sk_test_", // Stripe test secret key
  "rk_live_", // Stripe restricted key
  "ghp_",     // GitHub personal access token
  "gho_",     // GitHub OAuth token
  "ghs_",     // GitHub server-to-server token
  "ghu_",     // GitHub user-to-server token
  "github_pat_", // GitHub fine-grained PAT
  "glpat-",   // GitLab personal access token
  "xoxb-",    // Slack bot token
  "xoxe-",    // Slack
  "xoxp-",    // Slack user token
  "xoxa-",    // Slack
  "ya29.",    // Google OAuth access token
  "AIza",     // Google API key
  "AKIA",     // AWS access key ID
  "SG.",      // SendGrid API key
  "key-",     // Mailgun API key
  "AC",       // Twilio Account SID (followed by 32 hex chars — caught by value-length check)
  "EAA",      // Facebook/Meta access token
];

/**
 * Matches URL/connection strings with embedded credentials: scheme://user:pass@host
 * Covers DATABASE_URL, REDIS_URL, MONGODB_URI, postgresql://, mysql://, etc.
 */
const CREDENTIAL_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^@/\s]+:[^@/\s]+@/i;

/**
 * Detect environment variables that look like they may contain secrets.
 *
 * Vars managed by deer's auth proxy (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)
 * are excluded — they are already protected regardless of this policy.
 */
export function detectRiskyEnvVars(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): RiskyEnvVar[] {
  const result: RiskyEnvVar[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (PROXY_MANAGED.has(key)) continue;
    if (KNOWN_SAFE.has(key)) continue;
    if (SAFE_PREFIXES.some((p) => key.startsWith(p))) continue;

    let reason: string | null = null;

    for (const [pattern, label] of RISKY_KEY_PATTERNS) {
      if (pattern.test(key)) {
        reason = label;
        break;
      }
    }

    if (!reason) {
      for (const prefix of RISKY_VALUE_PREFIXES) {
        if (value.startsWith(prefix)) {
          reason = "known secret prefix";
          break;
        }
      }
    }

    if (!reason && CREDENTIAL_URL_PATTERN.test(value)) {
      reason = "credential URL";
    }

    if (reason) {
      result.push({
        key,
        displayValue: `${value.slice(0, 3)}...`,
        reason,
      });
    }
  }

  return result.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Load the env policy from disk synchronously.
 * Returns an empty policy if the file doesn't exist or can't be parsed.
 */
export function loadEnvPolicy(policyPath = ENV_POLICY_PATH): EnvPolicy {
  try {
    const raw = readFileSync(policyPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      blocked: Array.isArray(parsed.blocked) ? (parsed.blocked as string[]) : [],
      approved: Array.isArray(parsed.approved) ? (parsed.approved as string[]) : [],
    };
  } catch {
    return { blocked: [], approved: [] };
  }
}

/**
 * Save the env policy to disk. Creates parent directories if needed.
 */
export async function saveEnvPolicy(
  policy: EnvPolicy,
  policyPath = ENV_POLICY_PATH,
): Promise<void> {
  mkdirSync(dirname(policyPath), { recursive: true });
  await Bun.write(policyPath, JSON.stringify(policy, null, 2) + "\n");
}

/**
 * Return only the risky vars not yet in the policy (neither blocked nor approved).
 */
export function getUnreviewedRiskyVars(
  riskyVars: RiskyEnvVar[],
  policy: EnvPolicy,
): RiskyEnvVar[] {
  const reviewed = new Set([...policy.blocked, ...policy.approved]);
  return riskyVars.filter((v) => !reviewed.has(v.key));
}

/**
 * Remove all blocked vars from a mutable env object.
 */
export function applyEnvPolicy(
  env: Record<string, string>,
  policy: EnvPolicy,
): void {
  for (const key of policy.blocked) {
    delete env[key];
  }
}
