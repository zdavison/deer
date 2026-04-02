/**
 * Verify the pnpm ecosystem plugin allows the sandbox to read
 * Node.js toolchain paths required for `pnpm install`.
 *
 * Issue: https://github.com/zdavison/deer/issues/192
 */
import { test, expect, describe, afterEach } from "bun:test";
import { createSrtRuntime, BUILTIN_PLUGINS, applyEcosystems } from "../../packages/deerbox/src/index";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = process.env.HOME!;

describe("pnpm ecosystem - sandbox toolchain paths (issue #192)", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-pnpm-test-"));
    tmpDirs.push(d);
    return d;
  }

  const pnpmPlugin = BUILTIN_PLUGINS.find((p) => p.name === "pnpm")!;

  test("pnpm plugin declares readonly-cache for ~/.pnpm-store", async () => {
    const hasCacheStrategy = pnpmPlugin.strategies.some(
      (s) => s.type === "readonly-cache" && s.hostPath === "~/.pnpm-store",
    );
    expect(hasCacheStrategy).toBe(true);
  });

  test("pnpm ecosystem produces extraReadPaths for ~/.pnpm-store", async () => {
    const repoPath = await makeTmpDir();
    const worktreePath = await makeTmpDir();
    await writeFile(join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");

    const result = await applyEcosystems(repoPath, worktreePath);
    expect(result.extraReadPaths).toContain(join(HOME, ".pnpm-store"));
  });

  test("~/.pnpm-store is excluded from sandbox denyRead when pnpm ecosystem active", async () => {
    const worktreeDir = await makeTmpDir();
    const repoGitDir = await makeTmpDir();
    const worktreeGitDir = join(repoGitDir, "worktrees", "task1");
    await mkdir(worktreeGitDir, { recursive: true });
    await mkdir(join(repoGitDir, "objects"), { recursive: true });
    await mkdir(join(repoGitDir, "refs"), { recursive: true });
    await writeFile(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const pnpmStorePath = join(HOME, ".pnpm-store");

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      repoGitDir,
      allowlist: [],
      extraReadPaths: [pnpmStorePath],
    });

    const settingsPath = join(worktreeDir, "..", "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;

    if (existsSync(pnpmStorePath)) {
      expect(denyRead).not.toContain(pnpmStorePath);
    }
  });
});
