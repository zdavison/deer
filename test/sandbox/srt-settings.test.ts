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
        !p.includes(".claude") &&
        p !== "/tmp" &&
        p !== "/private/tmp"
    );
    expect(extraPaths).toHaveLength(0);
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

describe("srt settings - symlink targets in allowed dirs are reachable", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-sym-int-"));
    tmpDirs.push(d);
    return d;
  }

  test("symlink targets within home are excluded from denyRead", async () => {
    // Build a fake home dir:
    //   <home>/.external-data/     <- would normally be denied
    //   <home>/.claude/skills/my-skill -> <home>/.external-data/
    const home = await makeTmpDir();
    const externalData = join(home, ".external-data");
    await mkdir(externalData);
    const claudeSkillsDir = join(home, ".claude", "skills");
    await mkdir(claudeSkillsDir, { recursive: true });
    await symlink(externalData, join(claudeSkillsDir, "my-skill"));

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

    const denied = denyRead.some((p) => p === externalData || p.startsWith(externalData + "/"));
    expect(denied).toBe(false);
  });

  test("symlinks in agents and commands subdirs are also resolved", async () => {
    const home = await makeTmpDir();
    const agentTarget = join(home, ".my-agents");
    const commandTarget = join(home, ".my-commands");
    await mkdir(agentTarget);
    await mkdir(commandTarget);
    await mkdir(join(home, ".claude", "agents"), { recursive: true });
    await mkdir(join(home, ".claude", "commands"), { recursive: true });
    await symlink(agentTarget, join(home, ".claude", "agents", "my-agent"));
    await symlink(commandTarget, join(home, ".claude", "commands", "my-cmd"));

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

    expect(denyRead).not.toContain(agentTarget);
    expect(denyRead).not.toContain(commandTarget);
  });
});
