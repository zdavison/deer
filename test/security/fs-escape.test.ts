/**
 * Filesystem security tests for the SRT sandbox runtime.
 *
 * SRT handles filesystem isolation via the underlying platform primitives
 * (sandbox-exec on macOS, bwrap on Linux). These tests verify that the
 * sandbox enforces write restrictions correctly.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { createSrtRuntime } from "../../src/sandbox/srt";
import type { SandboxCleanup } from "../../src/sandbox/runtime";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
const cleanups: SandboxCleanup[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

async function makeTmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "deer-sec-test-"));
  tmpDirs.push(d);
  return d;
}

async function srtRun(dir: string, cmd: string) {
  const runtime = createSrtRuntime();
  cleanups.push(await runtime.prepare!({ worktreePath: dir, allowlist: [] }));
  const args = runtime.buildCommand(
    { worktreePath: dir, allowlist: [] },
    ["sh", "-c", cmd],
  );
  return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
}

// ── Write isolation ──────────────────────────────────────────────────

describe("srt: write isolation", () => {
  test("can write to worktree (intended writable path)", async () => {
    const dir = await makeTmpDir();
    const proc = await srtRun(
      dir,
      `echo "legit-write" > ${dir}/test-output.txt && cat ${dir}/test-output.txt`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toContain("legit-write");
  });

  test("cannot write to /etc", async () => {
    const dir = await makeTmpDir();
    const proc = await srtRun(dir, "echo pwned > /etc/deer-escape-test; echo exit=$?");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/etc/deer-escape-test")).toBe(false);
  });

  test("cannot write to /usr", async () => {
    const dir = await makeTmpDir();
    const proc = await srtRun(dir, "echo pwned > /usr/deer-escape-test; echo exit=$?");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/usr/deer-escape-test")).toBe(false);
  });

  test("cannot write to HOME outside worktree", async () => {
    const home = process.env.HOME!;
    const dir = await makeTmpDir();
    const marker = `deer-escape-test-${Date.now()}`;

    const proc = await srtRun(dir, `echo pwned > ${home}/${marker} 2>&1; echo exit=$?`);
    await new Response(proc.stdout).text();
    await proc.exited;

    expect(existsSync(join(home, marker))).toBe(false);
  });

  test("cannot modify ~/.bashrc", async () => {
    const home = process.env.HOME!;
    const dir = await makeTmpDir();
    const proc = await srtRun(dir, `echo 'evil' >> ${home}/.bashrc 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
  });

  test("cannot modify ~/.zshrc", async () => {
    const home = process.env.HOME!;
    const dir = await makeTmpDir();
    const proc = await srtRun(dir, `echo 'evil' >> ${home}/.zshrc 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
  });
});

// ── Sensitive file read protection ───────────────────────────────────

describe("srt: sensitive file exfiltration prevention", () => {
  test("cannot read SSH private keys", async () => {
    const home = process.env.HOME!;
    const sshDir = join(home, ".ssh");
    if (!existsSync(sshDir)) return; // skip if no .ssh dir

    const dir = await makeTmpDir();
    const proc = await srtRun(
      dir,
      `cat ${home}/.ssh/id_* > ${dir}/stolen.txt 2>&1 || echo DENIED > ${dir}/stolen.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "stolen.txt"), "utf-8");
    expect(content).not.toContain("PRIVATE KEY");
  });

  test("cannot read AWS credentials", async () => {
    const home = process.env.HOME!;
    const awsDir = join(home, ".aws");
    if (!existsSync(awsDir)) return; // skip if no .aws dir

    const dir = await makeTmpDir();
    const proc = await srtRun(
      dir,
      `cat ${home}/.aws/credentials > ${dir}/stolen.txt 2>&1 || echo DENIED > ${dir}/stolen.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "stolen.txt"), "utf-8");
    expect(content).not.toContain("aws_secret_access_key");
  });

  test("cannot read docker config", async () => {
    const home = process.env.HOME!;
    const dockerConfig = join(home, ".docker", "config.json");
    if (!existsSync(join(home, ".docker"))) return; // skip if no .docker dir

    const dir = await makeTmpDir();
    const proc = await srtRun(
      dir,
      `cat ${dockerConfig} > ${dir}/stolen.txt 2>&1 || echo DENIED > ${dir}/stolen.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "stolen.txt"), "utf-8");
    expect(content).not.toContain("auths");
  });

  test("cannot read kube config", async () => {
    const home = process.env.HOME!;
    const kubeConfig = join(home, ".kube", "config");
    if (!existsSync(join(home, ".kube"))) return; // skip if no .kube dir

    const dir = await makeTmpDir();
    const proc = await srtRun(
      dir,
      `cat ${kubeConfig} > ${dir}/stolen.txt 2>&1 || echo DENIED > ${dir}/stolen.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "stolen.txt"), "utf-8");
    expect(content).not.toContain("clusters");
  });
});
