/**
 * Tests that srt-settings.json allows writes to the specific git paths
 * needed for worktree operations (objects, refs, worktree metadata).
 *
 * Git worktrees share objects and refs with the main repo, but we scope
 * write access tightly to avoid exposing .git/config, .git/hooks, or
 * other worktrees' metadata.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { createSrtRuntime } from "../../packages/deerbox/src/index";
import { resolveSymlinkTargets } from "../../packages/deerbox/src/sandbox/srt";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("srt settings - git write permissions", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-test-"));
    tmpDirs.push(d);
    return d;
  }

  test("worktree gitdir and shared git subdirs are in allowWrite", async () => {
    // Simulate the main repo's .git directory
    const repoGitDir = await makeTmpDir();
    const worktreeGitDir = join(repoGitDir, "worktrees", "task1");
    await mkdir(worktreeGitDir, { recursive: true });
    await mkdir(join(repoGitDir, "objects"), { recursive: true });
    await mkdir(join(repoGitDir, "refs"), { recursive: true });

    // The worktree directory has a .git FILE pointing to the gitdir
    const worktreeDir = await makeTmpDir();
    await writeFile(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      repoGitDir,
      allowlist: [],
    });

    const settingsPath = join(worktreeDir, "..", "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const allowWrite: string[] = settings.filesystem.allowWrite;

    // Per-worktree metadata
    expect(allowWrite).toContain(worktreeGitDir);
    // Shared git subdirectories needed for git add/commit
    expect(allowWrite).toContain(join(repoGitDir, "objects"));
    expect(allowWrite).toContain(join(repoGitDir, "refs"));
    expect(allowWrite).toContain(join(repoGitDir, "logs"));
    // Should NOT include the entire .git dir or sensitive paths
    expect(allowWrite).not.toContain(repoGitDir);
    expect(allowWrite).not.toContain(join(repoGitDir, "config"));
    expect(allowWrite).not.toContain(join(repoGitDir, "hooks"));
    // packed-refs is not included (non-essential optimization, and
    // packed-refs.lock can't be bind-mounted since it doesn't exist
    // at sandbox launch time)
    expect(allowWrite).not.toContain(join(repoGitDir, "packed-refs"));
  });

  test("allowWrite has no git paths when repoGitDir and .git file are absent", async () => {
    const worktreeDir = await makeTmpDir();

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(worktreeDir, "..", "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).toContain(worktreeDir);
    // No extra git paths
    const extraPaths = allowWrite.filter(
      (p) =>
        p !== worktreeDir &&
        !p.includes("claude-config") &&
        p !== "/tmp" &&
        p !== "/private/tmp"
    );
    expect(extraPaths).toHaveLength(0);
  });
});

describe("srt settings - cross-task isolation", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-isolation-"));
    tmpDirs.push(d);
    return d;
  }

  test("sibling task directories are blocked via denyRead/allowRead", async () => {
    // tasks/
    //   current-task/worktree/   <- this task
    //   sibling-task/worktree/   <- must not be readable
    const tasksRoot = await makeTmpDir();
    const currentTaskDir = join(tasksRoot, "current-task");
    const siblingTaskDir = join(tasksRoot, "sibling-task");
    const worktreeDir = join(currentTaskDir, "worktree");
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(join(siblingTaskDir, "worktree"), { recursive: true });

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(currentTaskDir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;
    const allowRead: string[] = settings.filesystem.allowRead;

    // The tasks root must be denied to block sibling tasks
    expect(denyRead).toContain(tasksRoot);
    // The current task dir must be re-allowed
    expect(allowRead).toContain(currentTaskDir);
    // Sibling task dir must not appear in allowRead
    expect(allowRead).not.toContain(siblingTaskDir);
  });
});

describe("resolveSymlinkTargets", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-sym-"));
    tmpDirs.push(d);
    return d;
  }

  test("resolves symlinks in root dir", async () => {
    const claudeDir = await makeTmpDir();
    const target = await makeTmpDir();
    await symlink(target, join(claudeDir, "my-skill"));

    const result = resolveSymlinkTargets(claudeDir);
    expect(result).toContain(target);
  });

  test("resolves symlinks in immediate subdirectories", async () => {
    const claudeDir = await makeTmpDir();
    const subdir = join(claudeDir, "skills");
    await mkdir(subdir);
    const target = await makeTmpDir();
    await symlink(target, join(subdir, "my-skill"));

    const result = resolveSymlinkTargets(claudeDir);
    expect(result).toContain(target);
  });

  test("does not recurse deeper than one level", async () => {
    const claudeDir = await makeTmpDir();
    const subdir = join(claudeDir, "skills");
    const subsubdir = join(subdir, "nested");
    await mkdir(subsubdir, { recursive: true });
    const target = await makeTmpDir();
    await symlink(target, join(subsubdir, "deep-link"));

    const result = resolveSymlinkTargets(claudeDir);
    expect(result).not.toContain(target);
  });

  test("skips non-symlinks", async () => {
    const claudeDir = await makeTmpDir();
    await writeFile(join(claudeDir, "regular-file"), "hello");
    await mkdir(join(claudeDir, "regular-dir"));

    const result = resolveSymlinkTargets(claudeDir);
    expect(result).toHaveLength(0);
  });

  test("returns empty array when directory does not exist", () => {
    const result = resolveSymlinkTargets("/nonexistent/path/that/cannot/exist");
    expect(result).toEqual([]);
  });
});

describe("srt settings - per-task claude config dir isolation", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-claude-cfg-"));
    tmpDirs.push(d);
    return d;
  }

  async function makeSettings(home: string): Promise<Record<string, unknown>> {
    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskDir, "srt-settings.json");
    return JSON.parse(await readFile(settingsPath, "utf-8"));
  }

  test("~/.claude is denied for reading", async () => {
    const home = await makeTmpDir();
    await mkdir(join(home, ".claude"));

    const settings = await makeSettings(home);
    const denyRead: string[] = settings.filesystem.denyRead;

    expect(denyRead).toContain(join(home, ".claude"));
  });

  test("~/.claude is denied for writing", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const denyWrite: string[] = settings.filesystem.denyWrite;

    expect(denyWrite).toContain(join(home, ".claude"));
  });

  test("~/.claude.json is denied for writing", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const denyWrite: string[] = settings.filesystem.denyWrite;

    expect(denyWrite).toContain(join(home, ".claude.json"));
  });

  test("~/.claude is not in allowWrite", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).not.toContain(join(home, ".claude"));
  });

  test("~/.claude.json is not in allowWrite", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).not.toContain(join(home, ".claude.json"));
  });

  test("per-task claude-config dir is in allowWrite", async () => {
    const home = await makeTmpDir();
    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskDir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).toContain(join(taskDir, "claude-config"));
  });

  test("credential files inside claude-config are denied for reading", async () => {
    const home = await makeTmpDir();
    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskDir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;

    expect(denyRead).toContain(join(taskDir, "claude-config", ".credentials.json"));
    expect(denyRead).toContain(join(taskDir, "claude-config", "agent-oauth-token"));
  });
});
