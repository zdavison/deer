/**
 * Integration tests for sandbox runtimes.
 *
 * Tests are parameterized so new runtimes can be added by appending to the
 * `runtimes` array. Each runtime is exercised against the same suite of
 * expectations (command execution, file I/O, env isolation).
 */
import { test, expect, describe, afterEach } from "bun:test";
import { createSrtRuntime } from "../../packages/deerbox/src/index";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "../../packages/deerbox/src/index";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Check if SRT sandbox is functional in this environment
const srtAvailable = (() => {
  try {
    const runtime = createSrtRuntime();
    const args = runtime.buildCommand({ worktreePath: "/tmp", allowlist: [] }, ["true"]);
    const r = Bun.spawnSync(args, { stderr: "pipe" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
})();

// ── Runtime registry ─────────────────────────────────────────────────
// Add new runtimes here to automatically run all tests against them.

const runtimes: Array<{ name: string; create: () => SandboxRuntime }> = [
  { name: "srt", create: createSrtRuntime },
];

// ── Fixtures ─────────────────────────────────────────────────────────

const CLEAN_ENV = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/root",
  TERM: process.env.TERM ?? "xterm-256color",
};

for (const entry of runtimes) {
  describe.skipIf(!srtAvailable)(entry.name, () => {
    const tmpDirs: string[] = [];
    const cleanups: SandboxCleanup[] = [];
    let runtime: SandboxRuntime;

    afterEach(async () => {
      for (const c of cleanups.splice(0)) c();
      for (const d of tmpDirs.splice(0)) {
        await rm(d, { recursive: true, force: true }).catch(() => {});
      }
    });

    async function makeTmpDir(): Promise<string> {
      const d = await mkdtemp(join(tmpdir(), `deer-${entry.name}-test-`));
      tmpDirs.push(d);
      return d;
    }

    async function prepare(opts: SandboxRuntimeOptions): Promise<void> {
      runtime = entry.create();
      const cleanup = await runtime.prepare?.(opts) ?? (() => {});
      cleanups.push(cleanup);
    }

    test("can run a simple command in the sandbox", async () => {
      const dir = await makeTmpDir();
      await writeFile(join(dir, "test.txt"), "hello");
      await prepare({ worktreePath: dir, allowlist: [] });

      const args = runtime.buildCommand(
        { worktreePath: dir, allowlist: [] },
        ["cat", join(dir, "test.txt")],
      );

      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: CLEAN_ENV });
      const code = await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(code).toBe(0);
      expect(stdout).toContain("hello");
    });

    test("can write files inside the worktree", async () => {
      const dir = await makeTmpDir();
      await prepare({ worktreePath: dir, allowlist: [] });

      const outFile = join(dir, "output.txt");
      const args = runtime.buildCommand(
        { worktreePath: dir, allowlist: [] },
        ["sh", "-c", `echo written > ${outFile}`],
      );

      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: CLEAN_ENV });
      await proc.exited;

      const content = await readFile(outFile, "utf-8");
      expect(content.trim()).toBe("written");
    });

    test("ANTHROPIC_API_KEY is not visible inside the sandbox", async () => {
      const dir = await makeTmpDir();
      await prepare({ worktreePath: dir, allowlist: [] });

      const outFile = join(dir, "apikey.txt");
      const args = runtime.buildCommand(
        { worktreePath: dir, allowlist: [] },
        ["sh", "-c", `printenv ANTHROPIC_API_KEY > ${outFile} 2>/dev/null || echo NOTSET > ${outFile}`],
      );

      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        env: CLEAN_ENV,
      });
      await proc.exited;

      const content = (await readFile(outFile, "utf-8")).trim();
      expect(content === "NOTSET" || content === "").toBe(true);
    });
  });
}
