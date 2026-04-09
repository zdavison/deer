import { test, expect, describe, afterEach } from "bun:test";
import { createSrtRuntime } from "../../packages/deerbox/src/index";
import type { SandboxRuntimeOptions } from "../../packages/deerbox/src/index";
import {
  launchSandbox,
  isTmuxSessionDead,
  captureTmuxPane,
  type SandboxSession,
} from "../../src/sandbox/index";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Build a sandboxed command via SRT runtime.
 * Handles prepare() + buildCommand() so tests can pass the result to launchSandbox().
 */
async function buildSandboxedCommand(
  worktreePath: string,
  innerCommand: string[],
  opts?: Partial<SandboxRuntimeOptions>,
): Promise<string[]> {
  const runtime = createSrtRuntime();
  const runtimeOpts: SandboxRuntimeOptions = {
    worktreePath,
    allowlist: [],
    ...opts,
  };
  await runtime.prepare?.(runtimeOpts);
  return runtime.buildCommand(runtimeOpts, innerCommand);
}

describe("sandbox integration", () => {
  const sessions: SandboxSession[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const s of sessions) {
      await s.stop().catch(() => {});
    }
    sessions.length = 0;
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-sandbox-test-"));
    tmpDirs.push(d);
    return d;
  }

  function sessionName(): string {
    return `deer-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Poll until the tmux pane is dead (command exited), up to a timeout. */
  async function waitForPaneDead(name: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await isTmuxSessionDead(name)) return;
      await Bun.sleep(100);
    }
    throw new Error(`Pane ${name} did not die within ${timeoutMs}ms`);
  }

  /** Poll until a file exists, up to a timeout. */
  async function waitForFile(path: string, timeoutMs = 5000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        return await readFile(path, "utf-8");
      } catch {
        await Bun.sleep(100);
      }
    }
    return await readFile(path, "utf-8"); // final attempt — throws if still missing
  }

  test("launches a sandboxed command in tmux", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const command = await buildSandboxedCommand(dir, ["sh", "-c", `echo "sandbox works" > ${dir}/result.txt`]);

    const session = await launchSandbox({ sessionName: name, worktreePath: dir, command });
    sessions.push(session);

    expect(session.sessionName).toBe(name);

    const content = await waitForFile(join(dir, "result.txt"));
    expect(content.trim()).toBe("sandbox works");
  });

  test("isTmuxSessionDead returns false for running session", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const command = await buildSandboxedCommand(dir, ["sleep", "30"]);

    const session = await launchSandbox({ sessionName: name, worktreePath: dir, command });
    sessions.push(session);

    await Bun.sleep(300);
    const dead = await isTmuxSessionDead(name);
    expect(dead).toBe(false);
  });

  test("isTmuxSessionDead returns true after command exits", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const command = await buildSandboxedCommand(dir, ["true"]);

    const session = await launchSandbox({ sessionName: name, worktreePath: dir, command });
    sessions.push(session);

    await waitForPaneDead(name);
    const dead = await isTmuxSessionDead(name);
    expect(dead).toBe(true);
  });

  test("isTmuxSessionDead returns true for nonexistent session", async () => {
    const dead = await isTmuxSessionDead("deer-nonexistent-session-xyz");
    expect(dead).toBe(true);
  });

  test("captureTmuxPane returns output", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const command = await buildSandboxedCommand(dir, ["echo", "hello from sandbox"]);

    const session = await launchSandbox({ sessionName: name, worktreePath: dir, command });
    sessions.push(session);

    await waitForPaneDead(name);
    const lines = await captureTmuxPane(name, true);
    expect(lines).not.toBeNull();
    const joined = lines!.join("\n");
    expect(joined).toContain("hello from sandbox");
  });

  test("captureTmuxPane returns null for nonexistent session", async () => {
    const lines = await captureTmuxPane("deer-nonexistent-session-xyz");
    expect(lines).toBeNull();
  });

  test("stop() kills session", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const command = await buildSandboxedCommand(dir, ["sleep", "60"]);

    const session = await launchSandbox({ sessionName: name, worktreePath: dir, command });

    await session.stop();

    const dead = await isTmuxSessionDead(name);
    expect(dead).toBe(true);
  });

  test("sandbox can write inside worktree", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const command = await buildSandboxedCommand(dir, ["sh", "-c", `echo "inside" > ${dir}/sandboxed.txt`]);

    const session = await launchSandbox({ sessionName: name, worktreePath: dir, command });
    sessions.push(session);

    const content = await waitForFile(join(dir, "sandboxed.txt"));
    expect(content.trim()).toBe("inside");
  });

  test("env vars are passed to the sandboxed process", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const command = await buildSandboxedCommand(
      dir,
      ["sh", "-c", `echo $DEER_TEST_VAR > ${dir}/env-result.txt`],
      { env: { DEER_TEST_VAR: "it_works" } },
    );

    const session = await launchSandbox({ sessionName: name, worktreePath: dir, command });
    sessions.push(session);

    const content = await waitForFile(join(dir, "env-result.txt"));
    expect(content.trim()).toBe("it_works");
  });

  test("sandbox blocks direct network access", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const command = await buildSandboxedCommand(
      dir,
      [
        "sh", "-c",
        `curl --noproxy '*' --max-time 3 -s -o /dev/null -w '%{http_code}' https://example.com > ${dir}/direct.txt 2>&1 || echo "BLOCKED" > ${dir}/direct.txt`,
      ],
      { allowlist: ["example.com"] },
    );

    const session = await launchSandbox({ sessionName: name, worktreePath: dir, command });
    sessions.push(session);

    const content = await waitForFile(join(dir, "direct.txt"), 10000);
    expect(content.trim()).toBe("BLOCKED");
  }, 15000);
});
