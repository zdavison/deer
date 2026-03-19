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
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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
