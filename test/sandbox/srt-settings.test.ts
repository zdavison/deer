/**
 * Tests that srt-settings.json allows writes to the worktree's gitdir,
 * which lives inside the main repo's .git/worktrees/<name>/ directory.
 *
 * Git worktrees store their metadata (index, HEAD, etc.) in the main repo's
 * .git/worktrees/<name>/ — not inside the worktree itself. The sandbox must
 * allow writes there so git operations (add, commit) succeed.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { createSrtRuntime } from "../../packages/deerbox/src/index";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("srt settings - worktree gitdir write permission", () => {
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

  test("worktree gitdir is included in allowWrite when .git file is present", async () => {
    // Simulate the main repo's .git directory
    const repoGitDir = await makeTmpDir();
    // Git creates .git/worktrees/<name>/ to store worktree-specific metadata
    const worktreeGitDir = join(repoGitDir, "worktrees", "task1");
    await mkdir(worktreeGitDir, { recursive: true });

    // The worktree directory has a .git FILE (not dir) pointing to the gitdir
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

    expect(allowWrite).toContain(worktreeGitDir);
  });

  test("allowWrite does not include non-existent gitdir when .git file is absent", async () => {
    // A plain worktree dir with no .git file (e.g., the main worktree itself)
    const worktreeDir = await makeTmpDir();

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(worktreeDir, "..", "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const allowWrite: string[] = settings.filesystem.allowWrite;

    // No extra paths added beyond the defaults
    expect(allowWrite).toContain(worktreeDir);
    // No path from a missing .git file should sneak in
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
