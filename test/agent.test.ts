import { test, expect, describe, afterEach, setDefaultTimeout, beforeEach } from "bun:test";
import { dirname, join } from "node:path";

setDefaultTimeout(30_000);
import { resolveProxyUpstreams, DEFAULT_CONFIG, createSrtRuntime } from "../packages/deerbox/src/index";
import type { ProxyCredential } from "../packages/deerbox/src/index";
import { startAgent, getAgentOutput, deleteTask } from "../src/agent";
import type { AgentHandle, AgentStatus } from "../src/agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * Create a temporary git repo for testing.
 * Returns the repo path — caller is responsible for cleanup.
 */
async function createTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deer-agent-test-"));
  await Bun.$`git init ${dir}`.quiet();
  await Bun.$`git -C ${dir} config user.name "test"`.quiet();
  await Bun.$`git -C ${dir} config user.email "test@test"`.quiet();
  await Bun.write(join(dir, "README.md"), "# Test\n");
  await Bun.$`git -C ${dir} add -A && git -C ${dir} commit -m "init"`.quiet();
  // Ensure the branch is called "main" for consistency
  await Bun.$`git -C ${dir} branch -M main`.quiet();
  return dir;
}

// ── resolveProxyUpstreams ─────────────────────────────────────────────

describe("resolveProxyUpstreams", () => {
  // Save and restore any env vars we touch
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  function setEnv(key: string, value: string) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function unsetEnv(key: string) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  function makeCred(overrides?: Partial<ProxyCredential>): ProxyCredential {
    return {
      domain: "api.example.com",
      target: "https://api.example.com",
      hostEnv: { key: "EXAMPLE_API_KEY" },
      headerTemplate: { "x-api-key": "${value}" },
      sandboxEnv: { key: "EXAMPLE_BASE_URL", value: "http://api.example.com" },
      ...overrides,
    };
  }

  test("returns empty results when credential list is empty", () => {
    const result = resolveProxyUpstreams([]);
    expect(result.upstreams).toEqual([]);
    expect(result.sandboxEnv).toEqual({});
    expect(result.placeholderEnv).toEqual({});
  });

  test("skips credential when host env var is not set", () => {
    unsetEnv("EXAMPLE_API_KEY");
    const result = resolveProxyUpstreams([makeCred()]);
    expect(result.upstreams).toHaveLength(0);
  });

  test("builds upstream with resolved header when env var is set", () => {
    setEnv("EXAMPLE_API_KEY", "secret-key-123");
    const result = resolveProxyUpstreams([makeCred()]);
    expect(result.upstreams).toHaveLength(1);
    expect(result.upstreams[0].domain).toBe("api.example.com");
    expect(result.upstreams[0].target).toBe("https://api.example.com");
    expect(result.upstreams[0].headers["x-api-key"]).toBe("secret-key-123");
  });

  test("resolves Bearer token template correctly", () => {
    setEnv("MY_OAUTH_TOKEN", "tok-abc");
    const cred = makeCred({
      hostEnv: { key: "MY_OAUTH_TOKEN" },
      headerTemplate: { authorization: "Bearer ${value}" },
    });
    const result = resolveProxyUpstreams([cred]);
    expect(result.upstreams[0].headers.authorization).toBe("Bearer tok-abc");
  });

  test("populates sandboxEnv from credential config", () => {
    setEnv("EXAMPLE_API_KEY", "the-key");
    const result = resolveProxyUpstreams([makeCred()]);
    expect(result.sandboxEnv["EXAMPLE_BASE_URL"]).toBe("http://api.example.com");
  });

  test("populates placeholderEnv with 'proxy-managed' for the host env key", () => {
    setEnv("EXAMPLE_API_KEY", "the-key");
    const result = resolveProxyUpstreams([makeCred()]);
    expect(result.placeholderEnv["EXAMPLE_API_KEY"]).toBe("proxy-managed");
  });

  test("first credential wins when two credentials target the same domain (OAuth before API key)", () => {
    setEnv("OAUTH_TOKEN", "oauth-tok");
    setEnv("API_KEY", "api-key-val");

    const oauthCred = makeCred({
      domain: "api.example.com",
      hostEnv: { key: "OAUTH_TOKEN" },
      headerTemplate: { authorization: "Bearer ${value}" },
      sandboxEnv: { key: "EXAMPLE_BASE_URL", value: "http://api.example.com" },
    });
    const apiKeyCred = makeCred({
      domain: "api.example.com",
      hostEnv: { key: "API_KEY" },
      headerTemplate: { "x-api-key": "${value}" },
      sandboxEnv: { key: "EXAMPLE_BASE_URL", value: "http://api.example.com" },
    });

    const result = resolveProxyUpstreams([oauthCred, apiKeyCred]);
    expect(result.upstreams).toHaveLength(1);
    expect(result.upstreams[0].headers.authorization).toBe("Bearer oauth-tok");
    expect(result.upstreams[0].headers["x-api-key"]).toBeUndefined();
  });

  test("second credential used when first domain credential's env var is unset", () => {
    unsetEnv("OAUTH_TOKEN");
    setEnv("API_KEY", "fallback-key");

    const oauthCred = makeCred({
      domain: "api.example.com",
      hostEnv: { key: "OAUTH_TOKEN" },
      headerTemplate: { authorization: "Bearer ${value}" },
      sandboxEnv: { key: "EXAMPLE_BASE_URL", value: "http://api.example.com" },
    });
    const apiKeyCred = makeCred({
      domain: "api.example.com",
      hostEnv: { key: "API_KEY" },
      headerTemplate: { "x-api-key": "${value}" },
      sandboxEnv: { key: "EXAMPLE_BASE_URL", value: "http://api.example.com" },
    });

    const result = resolveProxyUpstreams([oauthCred, apiKeyCred]);
    expect(result.upstreams).toHaveLength(1);
    expect(result.upstreams[0].headers["x-api-key"]).toBe("fallback-key");
  });

  test("multiple different domains each get their own upstream", () => {
    setEnv("KEY_A", "val-a");
    setEnv("KEY_B", "val-b");

    const credA = makeCred({
      domain: "api-a.example.com",
      target: "https://api-a.example.com",
      hostEnv: { key: "KEY_A" },
      headerTemplate: { "x-key-a": "${value}" },
      sandboxEnv: { key: "URL_A", value: "http://api-a.example.com" },
    });
    const credB = makeCred({
      domain: "api-b.example.com",
      target: "https://api-b.example.com",
      hostEnv: { key: "KEY_B" },
      headerTemplate: { "x-key-b": "${value}" },
      sandboxEnv: { key: "URL_B", value: "http://api-b.example.com" },
    });

    const result = resolveProxyUpstreams([credA, credB]);
    expect(result.upstreams).toHaveLength(2);
    expect(result.upstreams.find(u => u.domain === "api-a.example.com")?.headers["x-key-a"]).toBe("val-a");
    expect(result.upstreams.find(u => u.domain === "api-b.example.com")?.headers["x-key-b"]).toBe("val-b");
    expect(result.sandboxEnv["URL_A"]).toBe("http://api-a.example.com");
    expect(result.sandboxEnv["URL_B"]).toBe("http://api-b.example.com");
    expect(result.placeholderEnv["KEY_A"]).toBe("proxy-managed");
    expect(result.placeholderEnv["KEY_B"]).toBe("proxy-managed");
  });

  test("real DEFAULT_CONFIG credentials: OAuth wins over API key when both set", () => {
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token-xyz");
    setEnv("ANTHROPIC_API_KEY", "sk-ant-123");

    const result = resolveProxyUpstreams(DEFAULT_CONFIG.sandbox.proxyCredentials);

    expect(result.upstreams).toHaveLength(1);
    expect(result.upstreams[0].headers.authorization).toBe("Bearer oauth-token-xyz");
    expect(result.placeholderEnv["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("proxy-managed");
    expect(result.placeholderEnv["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  test("real DEFAULT_CONFIG credentials: API key used when OAuth not set", () => {
    unsetEnv("CLAUDE_CODE_OAUTH_TOKEN");
    setEnv("ANTHROPIC_API_KEY", "sk-ant-fallback");

    const result = resolveProxyUpstreams(DEFAULT_CONFIG.sandbox.proxyCredentials);

    expect(result.upstreams).toHaveLength(1);
    expect(result.upstreams[0].headers["x-api-key"]).toBe("sk-ant-fallback");
    expect(result.placeholderEnv["ANTHROPIC_API_KEY"]).toBe("proxy-managed");
  });
});

// ── agent lifecycle ───────────────────────────────────────────────────

describe("agent lifecycle", () => {
  const repos: string[] = [];
  const handles: AgentHandle[] = [];

  afterEach(async () => {
    for (const h of handles) {
      await h.destroy().catch(() => {});
    }
    handles.length = 0;
    for (const r of repos) {
      await rm(r, { recursive: true, force: true }).catch(() => {});
    }
    repos.length = 0;
  });

  // Use a config with empty allowlist (no network needed for these tests)
  const testConfig = {
    ...DEFAULT_CONFIG,
    network: { allowlist: [] },
  };

  test("startAgent writes a minimal gitconfig to the task dir", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const handle = await startAgent({
      repoPath: repo,
      prompt: "test",
      baseBranch: "main",
      config: testConfig,
    });
    handles.push(handle);

    const gitconfigPath = join(dirname(handle.worktreePath), "gitconfig");
    const content = await Bun.file(gitconfigPath).text();
    expect(content).toContain("[user]");
    expect(content).toContain("name = deer-agent");
    expect(content).toContain("email = deer@noreply");
  });

  test("startAgent creates a worktree and tmux session", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const statuses: AgentStatus[] = [];
    const handle = await startAgent({
      repoPath: repo,
      prompt: "echo hello",
      baseBranch: "main",
      config: testConfig,
      onStatus: (s) => statuses.push(s),
    });
    handles.push(handle);

    expect(handle.taskId).toMatch(/^deer_/);
    expect(handle.sessionName).toStartWith("deer-deer_");
    expect(handle.branch).toStartWith("deer/deer_");

    // Check that statuses were reported
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses[0].phase).toBe("setup");
  });

  test("startAgent respects a pre-generated taskId", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const preTaskId = "deer_pretestid0abc";
    const handle = await startAgent({
      repoPath: repo,
      prompt: "echo hello",
      baseBranch: "main",
      config: testConfig,
      taskId: preTaskId,
    });
    handles.push(handle);

    expect(handle.taskId).toBe(preTaskId);
  });

  test("getAgentOutput returns tmux pane content", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const handle = await startAgent({
      repoPath: repo,
      prompt: "test",
      baseBranch: "main",
      config: testConfig,
    });
    handles.push(handle);

    // Wait a moment for the session to start
    await Bun.sleep(200);

    const output = await getAgentOutput(handle.sessionName);
    // Should return some lines (even if empty or error output)
    expect(Array.isArray(output)).toBe(true);
  });

  test("destroyAgent cleans up session and worktree", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const handle = await startAgent({
      repoPath: repo,
      prompt: "test",
      baseBranch: "main",
      config: testConfig,
    });

    await handle.destroy();
    // Don't add to handles — already destroyed

    // tmux session should be gone
    const proc = Bun.spawn(["tmux", "has-session", "-t", handle.sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).not.toBe(0);

    // Worktree should be removed
    const exists = await Bun.file(join(handle.worktreePath, "README.md")).exists();
    expect(exists).toBe(false);
  });

  test("deleteTask kills session, removes worktree and task directory", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const handle = await startAgent({
      repoPath: repo,
      prompt: "test",
      baseBranch: "main",
      config: testConfig,
    });

    await deleteTask(handle.taskId, repo);

    // tmux session should be gone
    const proc = Bun.spawn(["tmux", "has-session", "-t", handle.sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).not.toBe(0);

    // Worktree should be removed
    expect(await Bun.file(join(handle.worktreePath, "README.md")).exists()).toBe(false);

    // Task directory should be removed
    const taskDir = dirname(handle.worktreePath);
    const { statSync } = await import("node:fs");
    let dirExists = false;
    try { statSync(taskDir); dirExists = true; } catch { /* gone */ }
    expect(dirExists).toBe(false);
  });

  test("startAgent runs setup_command in the worktree before the sandbox starts", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const handle = await startAgent({
      repoPath: repo,
      prompt: "test",
      baseBranch: "main",
      config: {
        ...testConfig,
        defaults: { ...testConfig.defaults, setupCommand: "touch setup-marker" },
      },
    });
    handles.push(handle);

    const markerPath = join(handle.worktreePath, "setup-marker");
    expect(await Bun.file(markerPath).exists()).toBe(true);
  });

  test("startAgent throws and cleans up worktree when setup_command fails", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    let worktreePath: string | undefined;
    let threw = false;
    try {
      const handle = await startAgent({
        repoPath: repo,
        prompt: "test",
        baseBranch: "main",
        config: {
          ...testConfig,
          defaults: { ...testConfig.defaults, setupCommand: "exit 1" },
        },
        onStatus: (s) => {
          if (s.phase === "setup" && "message" in s) {
            // capture the worktree path from a deeper hook isn't easy here;
            // we verify cleanup via the branch instead
          }
        },
      });
      handles.push(handle);
      worktreePath = handle.worktreePath;
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);

    // The deer/<taskId> branch should not exist since worktree was cleaned up
    const branches = await Bun.$`git -C ${repo} branch`.quiet().text();
    expect(branches).not.toMatch(/deer\//);
  });

  test("startAgent skips setup_command when continueSession is provided", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    // Start first agent (without setup_command) to get a worktree
    const firstHandle = await startAgent({
      repoPath: repo,
      prompt: "echo hello",
      baseBranch: "main",
      config: testConfig,
    });
    handles.push(firstHandle);
    await firstHandle.kill();

    // Continue with a setup_command that would leave a marker if run
    const secondHandle = await startAgent({
      repoPath: repo,
      prompt: "should not be used",
      baseBranch: "main",
      config: {
        ...testConfig,
        defaults: { ...testConfig.defaults, setupCommand: "touch setup-marker" },
      },
      continueSession: {
        taskId: firstHandle.taskId,
        worktreePath: firstHandle.worktreePath,
        branch: firstHandle.branch,
      },
    });
    handles.push(secondHandle);

    const markerPath = join(secondHandle.worktreePath, "setup-marker");
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });

  test("startAgent reports setup status while running setup_command", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const statuses: AgentStatus[] = [];
    const handle = await startAgent({
      repoPath: repo,
      prompt: "test",
      baseBranch: "main",
      config: {
        ...testConfig,
        defaults: { ...testConfig.defaults, setupCommand: "echo setup" },
      },
      onStatus: (s) => statuses.push(s),
    });
    handles.push(handle);

    const setupStatuses = statuses.filter(
      (s) => s.phase === "setup" && "message" in s && s.message.toLowerCase().includes("setup"),
    );
    expect(setupStatuses.length).toBeGreaterThan(0);
  });

  test("startAgent works without a prompt (interactive mode)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const handle = await startAgent({
      repoPath: repo,
      baseBranch: "main",
      config: testConfig,
    });
    handles.push(handle);

    expect(handle.taskId).toMatch(/^deer_/);
    expect(handle.sessionName).toStartWith("deer-deer_");
  });

  test("startAgent with continueSession reuses existing worktree and taskId", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    // Start a normal agent to create a worktree
    const firstHandle = await startAgent({
      repoPath: repo,
      prompt: "echo hello",
      baseBranch: "main",
      config: testConfig,
    });
    handles.push(firstHandle);

    // Kill the first tmux session
    await firstHandle.kill();

    // Start a second agent that continues in the same worktree
    const statuses: AgentStatus[] = [];
    const secondHandle = await startAgent({
      repoPath: repo,
      prompt: "should not be used",
      baseBranch: "main",
      config: testConfig,
      continueSession: {
        taskId: firstHandle.taskId,
        worktreePath: firstHandle.worktreePath,
        branch: firstHandle.branch,
      },
      onStatus: (s) => statuses.push(s),
    });
    handles.push(secondHandle);

    // Handle should reuse the same identifiers
    expect(secondHandle.taskId).toBe(firstHandle.taskId);
    expect(secondHandle.worktreePath).toBe(firstHandle.worktreePath);
    expect(secondHandle.branch).toBe(firstHandle.branch);

    // A new tmux session should be running
    const proc = Bun.spawn(["tmux", "has-session", "-t", secondHandle.sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);

    // The worktree should still exist (not re-created)
    expect(await Bun.file(join(secondHandle.worktreePath, "README.md")).exists()).toBe(true);

    // Status should indicate a continue, not a fresh worktree creation
    expect(statuses.some((s) => s.phase === "setup")).toBe(true);
  });
});
