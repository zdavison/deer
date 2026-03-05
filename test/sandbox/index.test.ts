import { test, expect, describe, afterEach } from "bun:test";
import {
  launchSandbox,
  isTmuxSessionDead,
  captureTmuxPane,
  type SandboxSession,
} from "../../src/sandbox/index";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  test("launches a sandboxed command in tmux", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();

    const session = await launchSandbox({
      sessionName: name,
      worktreePath: dir,
      allowlist: [],
      command: ["sh", "-c", `echo "sandbox works" > ${dir}/result.txt`],
    });
    sessions.push(session);

    expect(session.sessionName).toBe(name);
    expect(session.proxy.port).toBeGreaterThan(0);

    // Wait for the command to finish
    await Bun.sleep(500);

    const content = await readFile(join(dir, "result.txt"), "utf-8");
    expect(content.trim()).toBe("sandbox works");
  });

  test("isTmuxSessionDead returns false for running session", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();

    const session = await launchSandbox({
      sessionName: name,
      worktreePath: dir,
      allowlist: [],
      command: ["sleep", "30"],
    });
    sessions.push(session);

    // Give tmux a moment to start the command
    await Bun.sleep(200);
    const dead = await isTmuxSessionDead(name);
    expect(dead).toBe(false);
  });

  test("isTmuxSessionDead returns true after command exits", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();

    const session = await launchSandbox({
      sessionName: name,
      worktreePath: dir,
      allowlist: [],
      command: ["true"], // exits immediately
    });
    sessions.push(session);

    // Wait for the command to finish (bwrap + shell startup takes time)
    await Bun.sleep(2000);
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

    const session = await launchSandbox({
      sessionName: name,
      worktreePath: dir,
      allowlist: [],
      command: ["echo", "hello from sandbox"],
    });
    sessions.push(session);

    await Bun.sleep(500);
    // Use full scrollback to capture output from short-lived commands
    const lines = await captureTmuxPane(name, true);
    expect(lines).not.toBeNull();
    const joined = lines!.join("\n");
    expect(joined).toContain("hello from sandbox");
  });

  test("captureTmuxPane returns null for nonexistent session", async () => {
    const lines = await captureTmuxPane("deer-nonexistent-session-xyz");
    expect(lines).toBeNull();
  });

  test("stop() kills session and proxy", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();

    const session = await launchSandbox({
      sessionName: name,
      worktreePath: dir,
      allowlist: [],
      command: ["sleep", "60"],
    });

    await session.stop();
    // Don't push to sessions array since we already stopped

    // tmux session should be gone
    const dead = await isTmuxSessionDead(name);
    expect(dead).toBe(true);
  });

  test("sandbox cannot write to host /tmp", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();
    const marker = `/tmp/deer-sandbox-escape-${Date.now()}`;

    const session = await launchSandbox({
      sessionName: name,
      worktreePath: dir,
      allowlist: [],
      command: ["sh", "-c", `echo escaped > ${marker}`],
    });
    sessions.push(session);

    await Bun.sleep(500);
    const escaped = await Bun.file(marker).exists();
    expect(escaped).toBe(false);
  });

  test("sandbox can write inside worktree", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();

    const session = await launchSandbox({
      sessionName: name,
      worktreePath: dir,
      allowlist: [],
      command: ["sh", "-c", `echo "inside" > ${dir}/sandboxed.txt`],
    });
    sessions.push(session);

    await Bun.sleep(500);
    const content = await readFile(join(dir, "sandboxed.txt"), "utf-8");
    expect(content.trim()).toBe("inside");
  });

  test("env vars are passed to the sandboxed process", async () => {
    const dir = await makeTmpDir();
    const name = sessionName();

    const session = await launchSandbox({
      sessionName: name,
      worktreePath: dir,
      allowlist: [],
      env: { DEER_TEST_VAR: "it_works" },
      command: ["sh", "-c", `echo $DEER_TEST_VAR > ${dir}/env-result.txt`],
    });
    sessions.push(session);

    await Bun.sleep(500);
    const content = await readFile(join(dir, "env-result.txt"), "utf-8");
    expect(content.trim()).toBe("it_works");
  });
});
