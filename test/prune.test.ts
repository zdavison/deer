import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prune, isTmuxSessionAlive } from "../packages/deerbox/src/prune";

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Create a fake task directory structure under the given home dir.
 * Does NOT create a real git worktree — just the directory skeleton.
 */
async function createFakeTaskDir(homeDir: string, taskId: string): Promise<string> {
  const taskDir = join(homeDir, ".local", "share", "deer", "tasks", taskId);
  await mkdir(join(taskDir, "worktree"), { recursive: true });
  await writeFile(join(taskDir, "gitconfig"), "[user]\n  name = Deer\n");
  return taskDir;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("isTmuxSessionAlive", () => {
  test("returns false for a nonexistent session", async () => {
    const alive = await isTmuxSessionAlive("deer-nonexistent-task-xyz-12345");
    expect(alive).toBe(false);
  });
});

describe("prune — normal mode", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-prune-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reports zero when there are no task dirs", async () => {
    const result = await prune();
    expect(result.tasksRemoved).toBe(0);
    expect(result.worktreesRemoved).toBe(0);
  });

  test("removes dangling task dirs (no tmux session)", async () => {
    const taskId = "deer_test_prune_dangling";
    const taskDir = await createFakeTaskDir(tmpDir, taskId);

    const logs: string[] = [];
    const result = await prune({ log: (m) => logs.push(m) });

    // No tmux session for this task ID → it's dangling → should be removed
    expect(result.tasksRemoved).toBe(1);
    // No real git worktree was created, so worktreesRemoved = 0
    expect(result.worktreesRemoved).toBe(0);

    const exists = await Bun.file(taskDir).exists();
    expect(exists).toBe(false);
  });

  test("removes multiple dangling task dirs", async () => {
    await createFakeTaskDir(tmpDir, "deer_test_prune_a");
    await createFakeTaskDir(tmpDir, "deer_test_prune_b");
    await createFakeTaskDir(tmpDir, "deer_test_prune_c");

    const result = await prune();
    expect(result.tasksRemoved).toBe(3);
  });

  test("dry-run does not remove task dirs", async () => {
    const taskId = "deer_test_prune_dryrun";
    const taskDir = await createFakeTaskDir(tmpDir, taskId);

    const logs: string[] = [];
    const result = await prune({ dryRun: true, log: (m) => logs.push(m) });

    expect(result.tasksRemoved).toBe(1);
    // Directory should still exist
    const dirExists = await Bun.file(join(taskDir, "gitconfig")).exists();
    expect(dirExists).toBe(true);
    // Log messages should include [dry-run] prefix
    expect(logs.some((l) => l.startsWith("[dry-run]"))).toBe(true);
  });
});

describe("prune — force mode", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-prune-force-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("removes all task dirs in force mode", async () => {
    await createFakeTaskDir(tmpDir, "deer_test_force_a");
    await createFakeTaskDir(tmpDir, "deer_test_force_b");

    const result = await prune({ force: true });
    expect(result.tasksRemoved).toBe(2);

    const tasksDir = join(tmpDir, ".local", "share", "deer", "tasks");
    const exists = await Bun.file(tasksDir).exists();
    expect(exists).toBe(false);
  });

  test("force dry-run does not remove task dirs", async () => {
    await createFakeTaskDir(tmpDir, "deer_test_force_dryrun");

    const tasksDir = join(tmpDir, ".local", "share", "deer", "tasks");

    const result = await prune({ force: true, dryRun: true });
    expect(result.tasksRemoved).toBe(1);

    // Tasks dir should still exist
    const taskDirContents = await Bun.$`ls ${tasksDir}`.quiet().nothrow();
    expect(taskDirContents.exitCode).toBe(0);
    expect(taskDirContents.stdout.toString()).toContain("deer_test_force_dryrun");
  });
});
