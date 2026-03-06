import { test, expect, describe } from "bun:test";
import { resolveCredentialMode } from "../src/credentials";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Save and restore env vars around a test. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("resolveCredentialMode", () => {
  test("returns 'api-key' when ANTHROPIC_API_KEY is set", async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_CODE_OAUTH_TOKEN: undefined },
      async () => {
        const mode = await resolveCredentialMode("/nonexistent-home");
        expect(mode).toBe("api-key");
      },
    );
  });

  test("returns 'oauth' when CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
      async () => {
        const mode = await resolveCredentialMode("/nonexistent-home");
        expect(mode).toBe("oauth");
      },
    );
  });

  test("prefers 'api-key' when both env vars are set", async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
      async () => {
        const mode = await resolveCredentialMode("/nonexistent-home");
        expect(mode).toBe("api-key");
      },
    );
  });

  test("returns 'oauth' when agent-oauth-token file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deer-cred-test-"));
    try {
      const claudeDir = join(dir, ".claude");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, "agent-oauth-token"), "file-token\n");

      await withEnv(
        { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
        async () => {
          const mode = await resolveCredentialMode(dir);
          expect(mode).toBe("oauth");
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns 'none' when agent-oauth-token file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deer-cred-test-"));
    try {
      const claudeDir = join(dir, ".claude");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, "agent-oauth-token"), "   \n");

      await withEnv(
        { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
        async () => {
          const mode = await resolveCredentialMode(dir);
          expect(mode).toBe("none");
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns 'none' when no credentials are available", async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
      async () => {
        const mode = await resolveCredentialMode("/nonexistent-home");
        expect(mode).toBe("none");
      },
    );
  });

  test("loads token from file into CLAUDE_CODE_OAUTH_TOKEN env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deer-cred-test-"));
    try {
      const claudeDir = join(dir, ".claude");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, "agent-oauth-token"), "loaded-token");

      await withEnv(
        { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
        async () => {
          await resolveCredentialMode(dir);
          expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("loaded-token");
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
