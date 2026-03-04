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
    expect(config.network.allowlist).toBeArrayOfSize(10);
    expect(config.network.allowlist).toContain("api.anthropic.com");
    expect(config.network.allowlist).toContain("github.com");
    expect(config.network.allowlist).toContain("registry.npmjs.org");
    expect(config.repos).toEqual({});
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
      "statsig.anthropic.com",
      "sentry.io",
      "registry.npmjs.org",
      "pypi.org",
      "github.com",
      "objects.githubusercontent.com",
      "archive.ubuntu.com",
      "security.ubuntu.com",
      "deb.debian.org",
    ]);
    expect(DEFAULT_CONFIG.repos).toEqual({});
  });
});
