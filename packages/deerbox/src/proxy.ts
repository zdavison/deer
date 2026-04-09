/**
 * Credential resolution for the MITM auth proxy.
 */

import { join } from "node:path";
import type { ProxyCredential } from "./config";
import type { ProxyUpstream } from "./sandbox/auth-proxy";
import { HOME } from "@deer/shared";

/**
 * Resolve proxy credentials from config: read host env vars, build upstream
 * definitions with concrete header values.
 *
 * When multiple credentials target the same domain (e.g. OAuth vs API key
 * for Anthropic), the first one whose env var is set wins.
 *
 * Returns upstreams (for the MITM proxy), sandbox env vars, and placeholder
 * env vars that make the sandboxed tool enter the right auth mode.
 */
export function resolveProxyUpstreams(
  credentials: ProxyCredential[],
): {
  upstreams: ProxyUpstream[];
  sandboxEnv: Record<string, string>;
  placeholderEnv: Record<string, string>;
} {
  const upstreams: ProxyUpstream[] = [];
  const sandboxEnv: Record<string, string> = {};
  const placeholderEnv: Record<string, string> = {};
  const claimedDomains = new Set<string>();

  for (const cred of credentials) {
    // Only one credential per domain — first match wins (e.g. OAuth before API key)
    if (claimedDomains.has(cred.domain)) continue;

    const value = process.env[cred.hostEnv.key];
    if (!value) continue;

    // Build concrete headers from templates
    const headers: Record<string, string> = {};
    for (const [hdr, tmpl] of Object.entries(cred.headerTemplate)) {
      headers[hdr] = tmpl.replace("${value}", value);
    }

    upstreams.push({
      domain: cred.domain,
      target: cred.target,
      headers,
      ...(cred.hostEnv.key === "CLAUDE_CODE_OAUTH_TOKEN" && {
        oauthRefresh: {
          sources: [
            { type: "agent-token-file" as const, path: join(HOME, ".claude", "agent-oauth-token") },
            ...(process.platform === "darwin"
              ? [{ type: "keychain" as const, service: "Claude Code-credentials" }]
              : []),
            {
              type: "file" as const,
              paths: [
                join(HOME, ".claude.json"),
                join(HOME, ".config", "claude", "config.json"),
                join(HOME, ".claude", ".credentials.json"),
              ],
            },
          ],
          headerName: "authorization",
          headerTemplate: "Bearer ${token}",
        },
      }),
    });

    if (cred.sandboxEnv) {
      sandboxEnv[cred.sandboxEnv.key] = cred.sandboxEnv.value;
    }
    placeholderEnv[cred.hostEnv.key] = "proxy-managed";
    claimedDomains.add(cred.domain);
  }

  return { upstreams, sandboxEnv, placeholderEnv };
}
