/**
 * Shared integration tests run against every sandbox runtime.
 *
 * Uses describe.each to execute the same behavioural assertions for both
 * nono (Landlock) and bwrap (mount namespaces) runtimes. Runtime-specific
 * behaviours (e.g. bwrap /tmp isolation, nono network proxy) live in their
 * own describe blocks below.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { nonoRuntime } from "../../src/sandbox/nono";
import { createBwrapRuntime } from "../../src/sandbox/bwrap";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "../../src/sandbox/runtime";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Fixtures ─────────────────────────────────────────────────────────

/**
 * Minimal env passed to Bun.spawn, mirroring what launchSandbox provides.
 * Intentionally excludes ANTHROPIC_API_KEY and other host secrets.
 */
const CLEAN_ENV = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/root",
  TERM: process.env.TERM ?? "xterm-256color",
};

const runtimeFixtures: Array<[string, () => SandboxRuntime]> = [
  ["nono", () => nonoRuntime],
  ["bwrap", () => createBwrapRuntime()],
];

// ── Shared suite ──────────────────────────────────────────────────────

describe.each(runtimeFixtures)("%s", (_name, getRuntime) => {
  const tmpDirs: string[] = [];
  const cleanups: SandboxCleanup[] = [];
  let runtime: SandboxRuntime;

  beforeEach(() => {
    runtime = getRuntime();
  });

  afterEach(async () => {
    for (const c of cleanups.splice(0)) c();
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-runtime-test-"));
    tmpDirs.push(d);
    return d;
  }

  async function prepare(opts: SandboxRuntimeOptions): Promise<void> {
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

    // Simulate ANTHROPIC_API_KEY being present on the host but excluded
    // by launchSandbox's env-i preamble. CLEAN_ENV does not include it.
    const outFile = join(dir, "apikey.txt");
    const args = runtime.buildCommand(
      { worktreePath: dir, allowlist: [] },
      ["sh", "-c", `printenv ANTHROPIC_API_KEY > ${outFile} 2>/dev/null || echo NOTSET > ${outFile}`],
    );

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: CLEAN_ENV, // no ANTHROPIC_API_KEY
    });
    await proc.exited;

    const content = (await readFile(outFile, "utf-8")).trim();
    expect(content).toSatisfy(
      (v: string) => v === "NOTSET" || v === "",
      `expected ANTHROPIC_API_KEY to be absent inside sandbox, got: "${content}"`,
    );
  });
});

// ── nono-specific integration ─────────────────────────────────────────

describe("nono", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-nono-test-"));
    tmpDirs.push(d);
    return d;
  }

  test("env vars injected via spawning process are visible inside", async () => {
    // nono inherits the caller's env; launchSandbox controls what's injected
    const dir = await makeTmpDir();
    const outFile = join(dir, "env-result.txt");
    const args = nonoRuntime.buildCommand(
      { worktreePath: dir, allowlist: [] },
      ["sh", "-c", `echo $DEER_TEST_VAR > ${outFile}`],
    );

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...CLEAN_ENV, DEER_TEST_VAR: "nono_works" },
    });
    await proc.exited;

    const content = await readFile(outFile, "utf-8");
    expect(content.trim()).toBe("nono_works");
  });

  test("blocks direct network access (Landlock TCP)", async () => {
    const dir = await makeTmpDir();
    const outFile = join(dir, "out.txt");
    const args = nonoRuntime.buildCommand(
      { worktreePath: dir, allowlist: ["example.com"] },
      ["sh", "-c", `curl --noproxy '*' --max-time 3 -s https://example.com > ${outFile} 2>&1 || echo BLOCKED > ${outFile}`],
    );

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: CLEAN_ENV });
    await proc.exited;

    const content = await readFile(outFile, "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);

  test("allows proxied access to allowlisted hosts", async () => {
    const dir = await makeTmpDir();
    const outFile = join(dir, "out.txt");
    const args = nonoRuntime.buildCommand(
      { worktreePath: dir, allowlist: ["example.com"] },
      ["sh", "-c", `curl -s --max-time 5 https://example.com > ${outFile} 2>&1`],
    );

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: CLEAN_ENV });
    await proc.exited;

    const content = await readFile(outFile, "utf-8");
    expect(content).toContain("Example Domain");
  }, 10000);
});

// ── bwrap-specific integration ────────────────────────────────────────

describe("bwrap", () => {
  const tmpDirs: string[] = [];
  const cleanups: SandboxCleanup[] = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) c();
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-bwrap-test-"));
    tmpDirs.push(d);
    return d;
  }

  test("env vars injected via options.env are visible inside (--setenv)", async () => {
    // bwrap strips the spawning process's env; vars must be passed via options.env
    const dir = await makeTmpDir();
    const runtime = createBwrapRuntime();
    cleanups.push(await runtime.prepare!({ worktreePath: dir, allowlist: [] }));

    const args = runtime.buildCommand(
      { worktreePath: dir, allowlist: [], env: { DEER_TEST_VAR: "bwrap_works" } },
      ["sh", "-c", "echo $DEER_TEST_VAR"],
    );

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout.trim()).toBe("bwrap_works");
  });

  test("ANTHROPIC_API_KEY from host env is not visible even without CLEAN_ENV", async () => {
    // bwrap's own isolation (not env -i) prevents host env leakage.
    // This verifies the runtime-level guarantee, independent of launchSandbox.
    const dir = await makeTmpDir();
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-bwrap-leak-sentinel";
    try {
      const runtime = createBwrapRuntime();
      cleanups.push(await runtime.prepare!({ worktreePath: dir, allowlist: [] }));

      const outFile = join(dir, "apikey.txt");
      const args = runtime.buildCommand(
        { worktreePath: dir, allowlist: [] },
        ["sh", "-c", `printenv ANTHROPIC_API_KEY > ${outFile} 2>/dev/null || echo NOTSET > ${outFile}`],
      );

      // Deliberately pass process.env (with ANTHROPIC_API_KEY) to the spawn — bwrap must still exclude it
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      await proc.exited;

      const content = (await readFile(outFile, "utf-8")).trim();
      expect(content).not.toBe("sk-ant-bwrap-leak-sentinel");
      expect(content).toSatisfy(
        (v: string) => v === "NOTSET" || v === "",
        `expected ANTHROPIC_API_KEY to be absent inside bwrap sandbox, got: "${content}"`,
      );
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("/tmp is isolated from the host (tmpfs)", async () => {
    const dir = await makeTmpDir();
    const marker = `deer-bwrap-test-${Date.now()}`;
    await writeFile(`/tmp/${marker}`, "host-side");

    const runtime = createBwrapRuntime();
    cleanups.push(await runtime.prepare!({ worktreePath: dir, allowlist: [] }));

    const args = runtime.buildCommand(
      { worktreePath: dir, allowlist: [] },
      ["sh", "-c", `ls /tmp/${marker} 2>&1; echo exit=$?`],
    );

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toContain("No such file");

    await rm(`/tmp/${marker}`).catch(() => {});
  });

  test("cannot write to /etc (read-only mount)", async () => {
    const dir = await makeTmpDir();
    const runtime = createBwrapRuntime();
    cleanups.push(await runtime.prepare!({ worktreePath: dir, allowlist: [] }));

    const args = runtime.buildCommand(
      { worktreePath: dir, allowlist: [] },
      ["sh", "-c", "echo pwned > /etc/deer-escape-test 2>&1; echo exit=$?"],
    );

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
  });
});
