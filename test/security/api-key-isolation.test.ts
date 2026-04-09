/**
 * Security tests: credentials must never reach sandboxed Claude processes.
 *
 * Deer uses a host-side MITM proxy (via SRT's mitmProxy Unix socket) to inject
 * credentials. Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY should
 * appear in the sandbox env or the srt command arguments.
 */
import { test, expect, describe } from "bun:test";
import { createSrtRuntime, resolveProxyUpstreams, DEFAULT_CONFIG } from "../../packages/deerbox/src/index";
import type { ProxyCredential, SandboxRuntimeOptions } from "../../packages/deerbox/src/index";

const defaults: SandboxRuntimeOptions = {
  worktreePath: "/tmp/deer-test-worktree",
  allowlist: ["api.anthropic.com"],
};

describe("credential isolation — srt command construction", () => {
  test("ANTHROPIC_API_KEY from host env does not appear in srt args", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-isolation-sentinel";
    try {
      const runtime = createSrtRuntime();
      const args = runtime.buildCommand(defaults, ["claude"]);
      expect(args.join("\0")).not.toContain("sk-ant-isolation-sentinel");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("CLAUDE_CODE_OAUTH_TOKEN is NOT passed directly to sandbox env", () => {
    const runtime = createSrtRuntime();
    const args = runtime.buildCommand(
      {
        ...defaults,
        env: {
          ANTHROPIC_BASE_URL: "http://api.anthropic.com",
          CLAUDE_CODE_OAUTH_TOKEN: "proxy-managed",
        },
      },
      ["claude"],
    );

    const joined = args.join("\0");
    // Only the placeholder "proxy-managed" should appear, not a real token
    expect(joined).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(joined).toContain("proxy-managed");
    expect(joined).toContain("ANTHROPIC_BASE_URL");
    expect(joined).toContain("http://api.anthropic.com");
  });

  test("ANTHROPIC_API_KEY is not set even when other env vars are forwarded", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-isolation-sentinel";
    try {
      const runtime = createSrtRuntime();
      const args = runtime.buildCommand(
        {
          ...defaults,
          env: {
            ANTHROPIC_BASE_URL: "http://api.anthropic.com",
            CLAUDE_CODE_OAUTH_TOKEN: "proxy-managed",
          },
        },
        ["claude"],
      );
      expect(args.join("\0")).not.toContain("sk-ant-isolation-sentinel");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });
});

describe("credential proxy resolution", () => {
  test("OAuth token takes priority over API key", () => {
    const origOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-key-test";
    try {
      const { upstreams, sandboxEnv, placeholderEnv } = resolveProxyUpstreams(
        DEFAULT_CONFIG.sandbox.proxyCredentials,
      );
      // Only one upstream should be created (OAuth wins, same domain)
      expect(upstreams).toHaveLength(1);
      expect(upstreams[0].headers["authorization"]).toBe("Bearer oauth-tok-test");
      expect(upstreams[0].headers["x-api-key"]).toBeUndefined();
      expect(upstreams[0].domain).toBe("api.anthropic.com");
      // Sandbox gets HTTP base URL (not HTTPS — goes through SRT proxy)
      expect(sandboxEnv.ANTHROPIC_BASE_URL).toBe("http://api.anthropic.com");
      // Sandbox gets placeholder CLAUDE_CODE_OAUTH_TOKEN (not the real value)
      expect(placeholderEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("proxy-managed");
      // ANTHROPIC_API_KEY placeholder must NOT be set (OAuth won)
      expect(placeholderEnv.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (origOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = origOAuth;
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  test("API key is used as fallback when OAuth is absent", () => {
    const origOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-fallback";
    try {
      const { upstreams, placeholderEnv } = resolveProxyUpstreams(
        DEFAULT_CONFIG.sandbox.proxyCredentials,
      );
      expect(upstreams).toHaveLength(1);
      expect(upstreams[0].headers["x-api-key"]).toBe("sk-ant-fallback");
      // Sandbox gets placeholder ANTHROPIC_API_KEY (not the real value)
      expect(placeholderEnv.ANTHROPIC_API_KEY).toBe("proxy-managed");
      expect(placeholderEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (origOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = origOAuth;
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  test("no upstreams when no credentials are set", () => {
    const origOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { upstreams } = resolveProxyUpstreams(
        DEFAULT_CONFIG.sandbox.proxyCredentials,
      );
      expect(upstreams).toHaveLength(0);
    } finally {
      if (origOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = origOAuth;
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  test("same domain with different credentials still deduplicates (one upstream per domain)", () => {
    const origOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok";
    process.env.ANTHROPIC_API_KEY = "sk-ant-key";
    try {
      const creds: ProxyCredential[] = [
        {
          domain: "api.anthropic.com",
          target: "https://api.anthropic.com",
          hostEnv: { key: "CLAUDE_CODE_OAUTH_TOKEN" },
          headerTemplate: { authorization: "Bearer ${value}" },
          sandboxEnv: {
            key: "ANTHROPIC_BASE_URL",
            value: "http://api.anthropic.com",
          },
        },
        {
          domain: "api.anthropic.com",
          target: "https://api.anthropic.com",
          hostEnv: { key: "ANTHROPIC_API_KEY" },
          headerTemplate: { "x-api-key": "${value}" },
          sandboxEnv: {
            key: "SOME_OTHER_VAR",
            value: "http://api.anthropic.com",
          },
        },
      ];
      const { upstreams } = resolveProxyUpstreams(creds);
      expect(upstreams).toHaveLength(1);
      expect(upstreams[0].headers["authorization"]).toBe("Bearer oauth-tok");
    } finally {
      if (origOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = origOAuth;
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  test("OAuth token header reaches upstream, API key header does not (end-to-end)", async () => {
    const { createServer } = await import("node:http");
    const { startAuthProxy } = await import("deerbox");
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const origOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-the-real-one";
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-appear";

    const dir = await mkdtemp(join(tmpdir(), "deer-e2e-test-"));

    // Start a mock upstream that echoes headers
    const mock = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ headers: req.headers }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({
          port: addr.port,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });

    try {
      const { upstreams } = resolveProxyUpstreams(DEFAULT_CONFIG.sandbox.proxyCredentials);

      // Rewrite target to point at mock instead of real Anthropic
      const patchedUpstreams = upstreams.map((u) => ({
        ...u,
        target: `http://127.0.0.1:${mock.port}`,
      }));

      const socketPath = join(dir, "auth.sock");
      const proxy = await startAuthProxy(socketPath, patchedUpstreams);
      try {
        // Send a proxy-style request to the Unix socket (like SRT does)
        const { connect } = await import("node:net");
        const result = await new Promise<{ headers: Record<string, string> }>((resolve, reject) => {
          const socket = connect(socketPath, () => {
            socket.write(
              "GET http://api.anthropic.com/v1/messages HTTP/1.1\r\n" +
              "Host: api.anthropic.com\r\nConnection: close\r\n\r\n",
            );
          });
          let data = "";
          socket.on("data", (c) => data += c);
          socket.on("end", () => {
            const body = data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
            resolve(JSON.parse(body));
          });
          socket.on("error", reject);
        });

        // The OAuth token must be the one injected
        expect(result.headers["authorization"]).toBe("Bearer oauth-the-real-one");
        // The API key must NOT appear anywhere in the headers
        const allHeaderValues = Object.values(result.headers).join(" ");
        expect(allHeaderValues).not.toContain("sk-ant-should-not-appear");
      } finally {
        await proxy.close();
      }
    } finally {
      await mock.close();
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })).catch(() => {});
      if (origOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = origOAuth;
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});
