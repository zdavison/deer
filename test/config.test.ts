import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULT_CONFIG } from "../src/config";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("missing config files return sensible defaults", async () => {
    const config = await loadConfig(tmpDir);

    expect(config.defaults.agent).toBe("claude");
    expect(config.defaults.timeoutMs).toBe(1800000);
    expect(config.network.allowlist).toBeArrayOfSize(8);
    expect(config.network.allowlist).toContain("api.anthropic.com");
    expect(config.network.allowlist).toContain("github.com");
    expect(config.network.allowlist).toContain("registry.npmjs.org");
  });

  test("TOML repo config (deer.toml) parses correctly", async () => {
    const toml = `
base_branch = "master"
setup_command = "pnpm run setup"

[network]
allowlist_extra = ["npm.pkg.github.com"]

[env]
NODE_ENV = "development"
`;
    await Bun.write(join(tmpDir, "deer.toml"), toml);

    const config = await loadConfig(tmpDir);

    expect(config.defaults.baseBranch).toBe("master");
    expect(config.defaults.setupCommand).toBe("pnpm run setup");
    expect(config.network.allowlist).toContain("npm.pkg.github.com");
    // Default allowlist entries still present
    expect(config.network.allowlist).toContain("api.anthropic.com");
  });

  test("TOML global config parses correctly", async () => {
    const globalDir = join(tmpDir, ".config", "deer");
    await Bun.write(
      join(globalDir, "config.toml"),
      `
[defaults]
agent = "claude"
timeout_ms = 3600000

[network]
allowlist = [
  "api.anthropic.com",
  "custom.example.com",
]
`
    );

    const config = await loadConfig(tmpDir, undefined, join(tmpDir, ".config", "deer", "config.toml"));

    expect(config.defaults.timeoutMs).toBe(3600000);
    expect(config.network.allowlist).toContain("custom.example.com");
  });

  test("merge order: global < repo < CLI (CLI wins)", async () => {
    const globalDir = join(tmpDir, ".config", "deer");
    await Bun.write(
      join(globalDir, "config.toml"),
      `
[defaults]
timeout_ms = 3600000
`
    );

    await Bun.write(
      join(tmpDir, "deer.toml"),
      `
base_branch = "develop"
`
    );

    const config = await loadConfig(
      tmpDir,
      undefined,
      join(tmpDir, ".config", "deer", "config.toml")
    );

    // Global value preserved when not overridden
    expect(config.defaults.timeoutMs).toBe(3600000);
    // Repo value preserved
    expect(config.defaults.baseBranch).toBe("develop");
  });

  test("partial configs merge correctly (missing fields filled from defaults)", async () => {
    await Bun.write(
      join(tmpDir, "deer.toml"),
      `
base_branch = "main"
`
    );

    const config = await loadConfig(tmpDir);

    // Repo value
    expect(config.defaults.baseBranch).toBe("main");
    // Defaults fill in the rest
    expect(config.defaults.agent).toBe("claude");
    expect(config.defaults.timeoutMs).toBe(1800000);
  });

  test("invalid TOML throws descriptive error", async () => {
    await Bun.write(join(tmpDir, "deer.toml"), "this is not valid toml {{{}}}");

    expect(loadConfig(tmpDir)).rejects.toThrow();
  });
});

describe("DEFAULT_CONFIG", () => {
  test("has expected default values", () => {
    expect(DEFAULT_CONFIG.defaults.agent).toBe("claude");
    expect(DEFAULT_CONFIG.defaults.timeoutMs).toBe(1800000);
    expect(DEFAULT_CONFIG.network.allowlist).toEqual([
      "api.anthropic.com",
      "claude.ai",
      "statsig.anthropic.com",
      "sentry.io",
      "registry.npmjs.org",
      "pypi.org",
      "github.com",
      "objects.githubusercontent.com",
    ]);
  });

  test("has default env_passthrough list", () => {
    expect(DEFAULT_CONFIG.sandbox.envPassthrough).toBeArray();
    expect(DEFAULT_CONFIG.sandbox.envPassthrough).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    // GH_TOKEN is intentionally NOT in the default list — agents don't need
    // it because deer handles git push/PR creation outside the sandbox.
    expect(DEFAULT_CONFIG.sandbox.envPassthrough).not.toContain("GH_TOKEN");
  });
});

describe("env_passthrough config", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("repo-local deer.toml can add extra env vars to passthrough", async () => {
    await Bun.write(
      join(tmpDir, "deer.toml"),
      `
[sandbox]
env_passthrough_extra = ["CUSTOM_API_KEY", "MY_SECRET"]
`
    );

    const config = await loadConfig(tmpDir);

    // Default vars still present
    expect(config.sandbox.envPassthrough).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    // Extra vars appended
    expect(config.sandbox.envPassthrough).toContain("CUSTOM_API_KEY");
    expect(config.sandbox.envPassthrough).toContain("MY_SECRET");
  });

  test("global config can override the full passthrough list", async () => {
    const globalDir = join(tmpDir, ".config", "deer");
    await Bun.write(
      join(globalDir, "config.toml"),
      `
[sandbox]
env_passthrough = ["ONLY_THIS_VAR"]
`
    );

    const config = await loadConfig(tmpDir, undefined, join(tmpDir, ".config", "deer", "config.toml"));

    expect(config.sandbox.envPassthrough).toEqual(["ONLY_THIS_VAR"]);
  });
});
