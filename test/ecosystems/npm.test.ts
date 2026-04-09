/**
 * Verify the npm ecosystem plugin allows the sandbox to read
 * Node.js toolchain paths required for `npm install`.
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

describe("npm ecosystem - sandbox toolchain paths (issue #192)", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-npm-test-"));
    tmpDirs.push(d);
    return d;
  }

  const npmPlugin = BUILTIN_PLUGINS.find((p) => p.name === "npm")!;

  test("npm plugin declares readonly-cache for ~/.npm", async () => {
    const hasCacheStrategy = npmPlugin.strategies.some(
      (s) => s.type === "readonly-cache" && s.hostPath === "~/.npm",
    );
    expect(hasCacheStrategy).toBe(true);
  });

  test("npm ecosystem produces extraReadPaths for ~/.npm", async () => {
    const repoPath = await makeTmpDir();
    const worktreePath = await makeTmpDir();
    await writeFile(join(repoPath, "package-lock.json"), "{}");

    const result = await applyEcosystems(repoPath, worktreePath);
    expect(result.extraReadPaths).toContain(join(HOME, ".npm"));
  });

  test("~/.npm is excluded from sandbox denyRead when npm ecosystem active", async () => {
    const worktreeDir = await makeTmpDir();
    const repoGitDir = await makeTmpDir();
    const worktreeGitDir = join(repoGitDir, "worktrees", "task1");
    await mkdir(worktreeGitDir, { recursive: true });
    await mkdir(join(repoGitDir, "objects"), { recursive: true });
    await mkdir(join(repoGitDir, "refs"), { recursive: true });
    await writeFile(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const npmCachePath = join(HOME, ".npm");

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      repoGitDir,
      allowlist: [],
      extraReadPaths: [npmCachePath],
    });

    const settingsPath = join(worktreeDir, "..", "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;

    if (existsSync(npmCachePath)) {
      expect(denyRead).not.toContain(npmCachePath);
    }
  });
});
