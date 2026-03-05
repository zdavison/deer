import { test, expect, describe, afterEach, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
import { startAgent, waitForCompletion, getAgentOutput, destroyAgent } from "../src/agent";
import type { AgentHandle, AgentStatus } from "../src/agent";
import { DEFAULT_CONFIG } from "../src/config";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
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

describe("agent lifecycle", () => {
  const repos: string[] = [];
  const handles: AgentHandle[] = [];

  afterEach(async () => {
    for (const h of handles) {
      await destroyAgent(h, repos[0] ?? "/tmp").catch(() => {});
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

  test("waitForCompletion resolves when the session is killed", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const handle = await startAgent({
      repoPath: repo,
      prompt: "test",
      baseBranch: "main",
      config: testConfig,
    });
    handles.push(handle);

    // Kill the session after a short delay to trigger completion
    setTimeout(() => handle.kill(), 1_000);

    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 25_000),
    );

    const result = await Promise.race([
      waitForCompletion(handle).then(() => "completed" as const),
      timeout,
    ]);

    expect(result).toBe("completed");
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
    await Bun.sleep(500);

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

    await destroyAgent(handle, repo);
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

  test("waitForCompletion respects AbortSignal", async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const handle = await startAgent({
      repoPath: repo,
      prompt: "sleep 60",
      baseBranch: "main",
      config: testConfig,
    });
    handles.push(handle);

    const controller = new AbortController();

    // Abort after 200ms
    setTimeout(() => controller.abort(), 200);

    const start = Date.now();
    await waitForCompletion(handle, controller.signal);
    const elapsed = Date.now() - start;

    // Should have returned quickly, not waited the full poll interval
    expect(elapsed).toBeLessThan(5_000);
  });
});
