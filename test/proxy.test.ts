import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolveProxyUpstreams } from "../packages/deerbox/src/proxy";
import type { ProxyCredential } from "../packages/deerbox/src/config";
import { DEFAULT_CONFIG } from "../packages/deerbox/src/config";

describe("resolveProxyUpstreams", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("credential without sandboxEnv does not crash and omits sandboxEnv entry", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "real-oauth-token";

    const creds: ProxyCredential[] = [
      {
        domain: "claude.ai",
        target: "https://claude.ai",
        hostEnv: { key: "CLAUDE_CODE_OAUTH_TOKEN" },
        headerTemplate: { authorization: "Bearer ${value}" },
        // No sandboxEnv — HTTPS traffic routed via SRT CONNECT tunneling
      },
    ];

    const { upstreams, sandboxEnv, placeholderEnv } = resolveProxyUpstreams(creds);

    expect(upstreams).toHaveLength(1);
    expect(upstreams[0].domain).toBe("claude.ai");
    expect(upstreams[0].headers.authorization).toBe("Bearer real-oauth-token");
    // sandboxEnv should have no entry for claude.ai (no env var needed)
    expect(Object.keys(sandboxEnv)).toHaveLength(0);
    // placeholder still set so Claude Code knows it has OAuth
    expect(placeholderEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("proxy-managed");
  });

  test("CLAUDE_CODE_OAUTH_TOKEN creates upstreams for both api.anthropic.com and claude.ai", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "real-oauth-token";
    delete process.env.ANTHROPIC_API_KEY;

    const { upstreams, sandboxEnv } = resolveProxyUpstreams(DEFAULT_CONFIG.sandbox.proxyCredentials);

    const anthropicUpstream = upstreams.find((u) => u.domain === "api.anthropic.com");
    const claudeAiUpstream = upstreams.find((u) => u.domain === "claude.ai");

    expect(anthropicUpstream).toBeDefined();
    expect(anthropicUpstream?.headers.authorization).toBe("Bearer real-oauth-token");

    expect(claudeAiUpstream).toBeDefined();
    expect(claudeAiUpstream?.headers.authorization).toBe("Bearer real-oauth-token");

    // api.anthropic.com sandboxEnv sets ANTHROPIC_BASE_URL
    expect(sandboxEnv.ANTHROPIC_BASE_URL).toBe("http://api.anthropic.com");
  });

  test("ANTHROPIC_API_KEY only creates upstream for api.anthropic.com, not claude.ai", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

    const { upstreams } = resolveProxyUpstreams(DEFAULT_CONFIG.sandbox.proxyCredentials);

    const anthropicUpstream = upstreams.find((u) => u.domain === "api.anthropic.com");
    const claudeAiUpstream = upstreams.find((u) => u.domain === "claude.ai");

    expect(anthropicUpstream).toBeDefined();
    expect(anthropicUpstream?.headers["x-api-key"]).toBe("sk-ant-test-key");

    // claude.ai credential uses CLAUDE_CODE_OAUTH_TOKEN which is unset,
    // so no upstream should be created for it
    expect(claudeAiUpstream).toBeUndefined();
  });

  test("claude.ai upstream has oauthRefresh configured", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "real-oauth-token";

    const { upstreams } = resolveProxyUpstreams(DEFAULT_CONFIG.sandbox.proxyCredentials);

    const claudeAiUpstream = upstreams.find((u) => u.domain === "claude.ai");
    expect(claudeAiUpstream?.oauthRefresh).toBeDefined();
    expect(claudeAiUpstream?.oauthRefresh?.headerName).toBe("authorization");
    expect(claudeAiUpstream?.oauthRefresh?.headerTemplate).toBe("Bearer ${token}");
  });
});

describe("DEFAULT_CONFIG proxy credentials", () => {
  test("includes claude.ai credential using CLAUDE_CODE_OAUTH_TOKEN", () => {
    const claudeAiCred = DEFAULT_CONFIG.sandbox.proxyCredentials.find(
      (c) => c.domain === "claude.ai",
    );

    expect(claudeAiCred).toBeDefined();
    expect(claudeAiCred?.hostEnv.key).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claudeAiCred?.target).toBe("https://claude.ai");
    expect(claudeAiCred?.headerTemplate.authorization).toMatch(/Bearer/);
  });

  test("claude.ai credential has no sandboxEnv (HTTPS routed via CONNECT tunnel)", () => {
    const claudeAiCred = DEFAULT_CONFIG.sandbox.proxyCredentials.find(
      (c) => c.domain === "claude.ai",
    );

    expect(claudeAiCred?.sandboxEnv).toBeUndefined();
  });
});
