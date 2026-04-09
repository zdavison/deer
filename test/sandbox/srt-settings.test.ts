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
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, realpath } from "node:fs/promises";
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

describe("srt settings - cross-repo isolation", () => {
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

  test("sibling repo directories are blocked via denyRead", async () => {
    // tasks/
    //   my-repo/current-task/worktree/   <- this task
    //   other-repo/other-task/worktree/  <- must not be readable
    const tasksRoot = await makeTmpDir();
    const currentRepoDir = join(tasksRoot, "my-repo");
    const currentTaskDir = join(currentRepoDir, "current-task");
    const siblingRepoDir = join(tasksRoot, "other-repo");
    const siblingTaskDir = join(siblingRepoDir, "other-task");
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

    // Sibling repo dir must be denied
    expect(denyRead).toContain(siblingRepoDir);
    // Current repo dir must NOT be denied
    expect(denyRead).not.toContain(currentRepoDir);
    // Tasks root must NOT be denied (SRT doesn't support allowRead overrides)
    expect(denyRead).not.toContain(tasksRoot);
  });

  test("same-repo sibling tasks are visible", async () => {
    // tasks/
    //   my-repo/task-a/worktree/   <- this task
    //   my-repo/task-b/worktree/   <- same repo, should be visible
    const tasksRoot = await makeTmpDir();
    const repoDir = join(tasksRoot, "my-repo");
    const taskADir = join(repoDir, "task-a");
    const taskBDir = join(repoDir, "task-b");
    const worktreeDir = join(taskADir, "worktree");
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(join(taskBDir, "worktree"), { recursive: true });

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskADir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;

    // Neither the repo dir nor sibling task dir should be denied
    expect(denyRead).not.toContain(repoDir);
    expect(denyRead).not.toContain(taskBDir);
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
    // Use realpath to normalize /tmp -> /private/tmp on macOS
    expect(result).toContain(await realpath(target));
  });

  test("resolves symlinks in immediate subdirectories", async () => {
    const claudeDir = await makeTmpDir();
    const subdir = join(claudeDir, "skills");
    await mkdir(subdir);
    const target = await makeTmpDir();
    await symlink(target, join(subdir, "my-skill"));

    const result = resolveSymlinkTargets(claudeDir);
    // Use realpath to normalize /tmp -> /private/tmp on macOS
    expect(result).toContain(await realpath(target));
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

describe("srt settings - filesystem denyRead", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-sec-"));
    tmpDirs.push(d);
    return d;
  }

  async function makeSettings(home: string): Promise<Record<string, unknown>> {
    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({ worktreePath: worktreeDir, allowlist: [] });

    const settingsPath = join(taskDir, "srt-settings.json");
    return JSON.parse(await readFile(settingsPath, "utf-8"));
  }

  test("denies /etc/shadow", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    expect(settings.filesystem.denyRead).toContain("/etc/shadow");
  });

  test("denies /etc/sudoers", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    expect(settings.filesystem.denyRead).toContain("/etc/sudoers");
  });

  test("denies /etc/sudoers.d", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    expect(settings.filesystem.denyRead).toContain("/etc/sudoers.d");
  });

  test("denies /root", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    expect(settings.filesystem.denyRead).toContain("/root");
  });

  test("denies other users under /home", async () => {
    // Use a synthetic /home parent by placing the fake home under a tmp subdir
    const fakeHomeParent = await makeTmpDir();
    const currentUserHome = join(fakeHomeParent, "currentuser");
    const otherUserHome = join(fakeHomeParent, "otheruser");
    await mkdir(currentUserHome, { recursive: true });
    await mkdir(otherUserHome, { recursive: true });

    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);

    const runtime = createSrtRuntime({ home: currentUserHome });
    await runtime.prepare?.({ worktreePath: worktreeDir, allowlist: [] });

    const settingsPath = join(taskDir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;

    expect(denyRead).toContain(otherUserHome);
    expect(denyRead).not.toContain(currentUserHome);
  });

  test("denies sensitive dirs under .local/share", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const denyRead: string[] = settings.filesystem.denyRead;

    expect(denyRead).toContain(join(home, ".local", "share", "keyrings"));
    expect(denyRead).toContain(join(home, ".local", "share", "gnome-keyring"));
    expect(denyRead).toContain(join(home, ".local", "share", "pass"));
  });
});
