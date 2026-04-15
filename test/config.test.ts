import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULT_CONFIG } from "../packages/deerbox/src/index";
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
    expect(config.network.allowlist).toContain("api.anthropic.com");
    expect(config.network.allowlist).toContain("registry.npmjs.org");
  });

  test("default allowlist includes github.com and api.github.com", async () => {
    const config = await loadConfig(tmpDir);

    expect(config.network.allowlist).toContain("github.com");
    expect(config.network.allowlist).toContain("api.github.com");
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
    expect(DEFAULT_CONFIG.network.allowlist).toContain("api.anthropic.com");
    expect(DEFAULT_CONFIG.network.allowlist).toContain("registry.npmjs.org");
    expect(DEFAULT_CONFIG.network.allowlist).toContain("github.com");
    expect(DEFAULT_CONFIG.network.allowlist).toContain("api.github.com");
  });

  test("has empty default env_passthrough (credentials go through proxy)", () => {
    expect(DEFAULT_CONFIG.sandbox.envPassthrough).toBeArray();
    expect(DEFAULT_CONFIG.sandbox.envPassthrough).toHaveLength(0);
    // Credentials are now handled by proxyCredentials, not envPassthrough
    expect(DEFAULT_CONFIG.sandbox.proxyCredentials).toBeArray();
    expect(DEFAULT_CONFIG.sandbox.proxyCredentials.length).toBeGreaterThan(0);
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

    // Extra vars appended to the (now empty) default list
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

describe("write_paths config", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("repo-local deer.toml can add extra write paths", async () => {
    await Bun.write(
      join(tmpDir, "deer.toml"),
      `
[sandbox]
write_paths_extra = ["~/.my-hook-data", "~/.tmux-tracker"]
`
    );

    const config = await loadConfig(tmpDir);

    expect(config.sandbox.writePaths).toContain("~/.my-hook-data");
    expect(config.sandbox.writePaths).toContain("~/.tmux-tracker");
  });

  test("global config can override the full write paths list", async () => {
    const globalDir = join(tmpDir, ".config", "deer");
    await Bun.write(
      join(globalDir, "config.toml"),
      `
[sandbox]
write_paths = ["~/.always-writable"]
`
    );

    const config = await loadConfig(tmpDir, undefined, join(tmpDir, ".config", "deer", "config.toml"));

    expect(config.sandbox.writePaths).toEqual(["~/.always-writable"]);
  });

  test("defaults to empty array", () => {
    expect(DEFAULT_CONFIG.sandbox.writePaths).toBeArray();
    expect(DEFAULT_CONFIG.sandbox.writePaths).toHaveLength(0);
  });
});

describe("read_paths config", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("repo-local deer.toml can add extra read paths", async () => {
    await Bun.write(
      join(tmpDir, "deer.toml"),
      `
[sandbox]
read_paths_extra = ["~/.my-docs", "~/.config/my-tool"]
`
    );

    const config = await loadConfig(tmpDir);

    expect(config.sandbox.readPaths).toContain("~/.my-docs");
    expect(config.sandbox.readPaths).toContain("~/.config/my-tool");
  });

  test("global config can override the full read paths list", async () => {
    const globalDir = join(tmpDir, ".config", "deer");
    await Bun.write(
      join(globalDir, "config.toml"),
      `
[sandbox]
read_paths = ["~/.shared-docs"]
`
    );

    const config = await loadConfig(tmpDir, undefined, join(tmpDir, ".config", "deer", "config.toml"));

    expect(config.sandbox.readPaths).toEqual(["~/.shared-docs"]);
  });

  test("defaults to empty array", () => {
    expect(DEFAULT_CONFIG.sandbox.readPaths).toBeArray();
    expect(DEFAULT_CONFIG.sandbox.readPaths).toHaveLength(0);
  });
});
