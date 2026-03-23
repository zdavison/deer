import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCredentials } from "../packages/deerbox/src/index";

// Save and restore env vars around each test
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (savedEnv.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = savedEnv.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (savedEnv.ANTHROPIC_API_KEY !== undefined) {
    process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "deer-preflight-test-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

describe("resolveCredentials", () => {
  describe("CLAUDE_CODE_OAUTH_TOKEN env var", () => {
    test("returns subscription when env var is set", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok_from_env";
      const home = makeTempHome();
      try {
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("subscription");
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_from_env");
      } finally {
        rmSync(home, { recursive: true });
      }
    });

    test("strips ANTHROPIC_API_KEY when OAuth token is present via env", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok_from_env";
      process.env.ANTHROPIC_API_KEY = "sk-should-be-removed";
      const home = makeTempHome();
      try {
        await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      } finally {
        rmSync(home, { recursive: true });
      }
    });
  });

  describe("sk-ant-oat* tokens from OAuth login", () => {
    test("returns subscription when env var is sk-ant-oat token", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-xxxx";
      const home = makeTempHome();
      try {
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("subscription");
      } finally {
        rmSync(home, { recursive: true });
      }
    });

    test("returns subscription when agent-oauth-token file contains sk-ant-oat token", async () => {
      const home = makeTempHome();
      try {
        writeFileSync(join(home, ".claude", "agent-oauth-token"), "sk-ant-oat01-xxxx\n");
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("subscription");
      } finally {
        rmSync(home, { recursive: true });
      }
    });
  });

  describe("~/.claude/agent-oauth-token file", () => {
    test("reads token from flat file when env var is absent", async () => {
      const home = makeTempHome();
      try {
        writeFileSync(join(home, ".claude", "agent-oauth-token"), "tok_from_file\n");
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("subscription");
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_from_file");
      } finally {
        rmSync(home, { recursive: true });
      }
    });

    test("trims whitespace from token file", async () => {
      const home = makeTempHome();
      try {
        writeFileSync(join(home, ".claude", "agent-oauth-token"), "  tok_trimmed  \n");
        await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_trimmed");
      } finally {
        rmSync(home, { recursive: true });
      }
    });
  });

  describe("~/.claude.json OAuth credentials (Linux path)", () => {
    test("reads claudeAiOauth.accessToken from ~/.claude.json", async () => {
      const home = makeTempHome();
      try {
        writeFileSync(
          join(home, ".claude.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "tok_from_claude_json",
              refreshToken: "refresh_xxx",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            oauthAccount: {
              accountUuid: "uuid-xxx",
              emailAddress: "test@example.com",
            },
          }),
        );
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("subscription");
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_from_claude_json");
      } finally {
        rmSync(home, { recursive: true });
      }
    });

    test("does not read ~/.claude.json when env var already set", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok_from_env";
      const home = makeTempHome();
      try {
        writeFileSync(
          join(home, ".claude.json"),
          JSON.stringify({ claudeAiOauth: { accessToken: "tok_from_claude_json" } }),
        );
        await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_from_env");
      } finally {
        rmSync(home, { recursive: true });
      }
    });

    test("does not read ~/.claude.json when flat file already provided token", async () => {
      const home = makeTempHome();
      try {
        writeFileSync(join(home, ".claude", "agent-oauth-token"), "tok_from_file");
        writeFileSync(
          join(home, ".claude.json"),
          JSON.stringify({ claudeAiOauth: { accessToken: "tok_from_claude_json" } }),
        );
        await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_from_file");
      } finally {
        rmSync(home, { recursive: true });
      }
    });

    test("ignores ~/.claude.json when claudeAiOauth.accessToken is missing", async () => {
      const home = makeTempHome();
      try {
        writeFileSync(
          join(home, ".claude.json"),
          JSON.stringify({ oauthAccount: { accountUuid: "uuid-xxx" } }),
        );
        process.env.ANTHROPIC_API_KEY = "sk-fallback";
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("api-token");
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      } finally {
        rmSync(home, { recursive: true });
      }
    });

    test("ignores malformed ~/.claude.json gracefully", async () => {
      const home = makeTempHome();
      try {
        writeFileSync(join(home, ".claude.json"), "{ this is not json }");
        process.env.ANTHROPIC_API_KEY = "sk-fallback";
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("api-token");
      } finally {
        rmSync(home, { recursive: true });
      }
    });
  });

  describe("ANTHROPIC_API_KEY fallback", () => {
    test("returns api-token when only API key is set", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const home = makeTempHome();
      try {
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("api-token");
        expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
      } finally {
        rmSync(home, { recursive: true });
      }
    });
  });

  describe("no credentials", () => {
    test("returns none when no credentials are available", async () => {
      const home = makeTempHome();
      try {
        const result = await resolveCredentials({ homeDir: home, skipKeychain: true });
        expect(result).toBe("none");
      } finally {
        rmSync(home, { recursive: true });
      }
    });
  });
});
