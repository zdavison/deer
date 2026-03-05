import { test, expect, describe, afterEach } from "bun:test";
import { buildNonoArgs } from "../../src/sandbox/nono";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
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

function nonoRun(
  dir: string,
  cmd: string,
  extraOpts?: { extraReadPaths?: string[]; extraWritePaths?: string[] },
): ReturnType<typeof Bun.spawn> {
  const args = buildNonoArgs({
    worktreePath: dir,
    allowlist: [],
    ...extraOpts,
  });
  return Bun.spawn([...args, "sh", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

// ── B1: Symlink traversal must not reach ungranted paths ─────────────

describe("symlink traversal from worktree", () => {
  test("symlink to ~/.ssh/id_rsa is blocked", async () => {
    const home = process.env.HOME!;
    const sshKey = join(home, ".ssh", "id_rsa");

    if (!existsSync(sshKey)) {
      console.log("Skipping: no ~/.ssh/id_rsa found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(sshKey, join(dir, "stolen-key"));

    const proc = nonoRun(dir, `cat ${dir}/stolen-key 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("symlink to ~/.bashrc is blocked", async () => {
    const home = process.env.HOME!;
    const bashrc = join(home, ".bashrc");

    if (!existsSync(bashrc)) {
      console.log("Skipping: no ~/.bashrc found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(bashrc, join(dir, "stolen-bashrc"));

    const proc = nonoRun(dir, `cat ${dir}/stolen-bashrc 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("symlink to ~/.aws/credentials is blocked", async () => {
    const home = process.env.HOME!;
    const awsCreds = join(home, ".aws", "credentials");

    if (!existsSync(awsCreds)) {
      console.log("Skipping: no ~/.aws/credentials found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(awsCreds, join(dir, "stolen-aws"));

    const proc = nonoRun(dir, `cat ${dir}/stolen-aws 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });
});

// ── B2: Write isolation ──────────────────────────────────────────────

describe("write isolation", () => {
  test("cannot write to /etc", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(dir, "echo pwned > /etc/deer-escape-test; echo exit=$?");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/etc/deer-escape-test")).toBe(false);
  });

  test("cannot write to /usr", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(dir, "echo pwned > /usr/deer-escape-test; echo exit=$?");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/usr/deer-escape-test")).toBe(false);
  });

  test("can write to worktree (intended writable path)", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `echo "legit-write" > ${dir}/test-output.txt && cat ${dir}/test-output.txt`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toContain("legit-write");
  });

  test("repoGitDir is not writable", async () => {
    const dir = await makeTmpDir();

    const args = buildNonoArgs({
      worktreePath: dir,
      allowlist: [],
      repoGitDir: "/usr",
    });

    const proc = Bun.spawn(
      [...args, "sh", "-c", "echo pwned > /usr/deer-escape-test; echo exit=$?"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/usr/deer-escape-test")).toBe(false);
  });

  test("cannot write to HOME outside worktree", async () => {
    const home = process.env.HOME!;
    const dir = await makeTmpDir();
    const marker = `deer-escape-test-${Date.now()}`;

    const proc = nonoRun(dir, `echo pwned > ${home}/${marker} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(existsSync(join(home, marker))).toBe(false);
  });
});

// ── B3: Sensitive credential files must be blocked ───────────────────

describe("sensitive credential file isolation", () => {
  test("~/.ssh/id_rsa must not be readable", async () => {
    const home = process.env.HOME!;
    const sshKey = join(home, ".ssh", "id_rsa");

    if (!existsSync(sshKey)) {
      console.log("Skipping: no ~/.ssh/id_rsa found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${sshKey} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).not.toMatch(/-----BEGIN/);
    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });

  test("~/.gnupg must not be readable", async () => {
    const home = process.env.HOME!;
    const gnupg = join(home, ".gnupg");

    if (!existsSync(gnupg)) {
      console.log("Skipping: no ~/.gnupg found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `ls ${gnupg} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });

  test("~/.aws must not be readable", async () => {
    const home = process.env.HOME!;
    const awsDir = join(home, ".aws");

    if (!existsSync(awsDir)) {
      console.log("Skipping: no ~/.aws found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${awsDir}/credentials 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted|No such file/);
  });

  test("~/.docker/config.json must not be readable", async () => {
    const home = process.env.HOME!;
    const dockerConfig = join(home, ".docker", "config.json");

    if (!existsSync(dockerConfig)) {
      console.log("Skipping: no ~/.docker/config.json found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${dockerConfig} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });

  test("~/.kube/config must not be readable", async () => {
    const home = process.env.HOME!;
    const kubeConfig = join(home, ".kube", "config");

    if (!existsSync(kubeConfig)) {
      console.log("Skipping: no ~/.kube/config found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${kubeConfig} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });

  test("~/.npmrc must not be readable (may contain auth tokens)", async () => {
    const home = process.env.HOME!;
    const npmrc = join(home, ".npmrc");

    if (!existsSync(npmrc)) {
      console.log("Skipping: no ~/.npmrc found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${npmrc} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });
});

// ── B4: Environment variable isolation ────────────────────────────────

describe("env passthrough isolation", () => {
  test("only explicitly passthrough'd env vars reach the sandbox", async () => {
    const dir = await makeTmpDir();
    const args = buildNonoArgs({
      worktreePath: dir,
      allowlist: [],
    });

    // launchSandbox builds a clean env from the passthrough list.
    // Simulate by spawning with env -i plus only allowed vars.
    const allowedEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TERM: process.env.TERM ?? "xterm-256color",
      GH_TOKEN: "ghp_allowed_token",
    };

    const proc = Bun.spawn(
      [
        ...args,
        "sh", "-c",
        "cat /proc/self/environ | tr '\\0' '\\n' | sort",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: allowedEnv,
      },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // The allowed var should be present
    expect(stdout).toContain("GH_TOKEN=ghp_allowed_token");

    // Vars NOT in the passthrough list must be absent.
    // In a real scenario, the parent process may have AWS_SECRET_ACCESS_KEY,
    // DATABASE_URL, etc. — none of those should leak.
    expect(stdout).not.toContain("AWS_SECRET");
    expect(stdout).not.toContain("DATABASE_URL");
  });
});

// ── B5: ~/.claude is writable — config injection risk ────────────────

describe("~/.claude config isolation", () => {
  // ACCEPTED RISK: nono's claude-code profile grants rw to ~/.claude by design
  // (Claude Code needs it for session state, hooks, etc.). Isolation via
  // sandboxed HOME is being tracked upstream in nono.
  test.skip("~/.claude must not be writable by sandboxed agent", async () => {
    const home = process.env.HOME!;
    const claudeDir = join(home, ".claude");

    if (!existsSync(claudeDir)) {
      console.log("Skipping: no ~/.claude found");
      return;
    }

    const dir = await makeTmpDir();
    const marker = `deer-sec-test-${Date.now()}`;
    const proc = nonoRun(
      dir,
      `echo malicious > ${claudeDir}/${marker} 2>&1; echo exit=$?`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // ~/.claude is rw in the claude-code profile. If this test fails,
    // a compromised agent can inject malicious hooks, MCP servers,
    // or modify Claude Code settings that persist across sessions.
    const escaped = existsSync(join(claudeDir, marker));
    if (escaped) {
      // Clean up the test artifact
      await rm(join(claudeDir, marker)).catch(() => {});
    }
    expect(escaped).toBe(false);
  });

  // ACCEPTED RISK: same as above — nono claude-code profile grants rw.
  test.skip("~/.claude.json must not be writable by sandboxed agent", async () => {
    const home = process.env.HOME!;
    const claudeJson = join(home, ".claude.json");

    if (!existsSync(claudeJson)) {
      console.log("Skipping: no ~/.claude.json found");
      return;
    }

    const dir = await makeTmpDir();

    // Use a non-destructive test: try to append to the file rather than
    // overwriting it, so the test doesn't corrupt the real config.
    const proc = nonoRun(
      dir,
      `echo 'DEER_SECURITY_MARKER' >> ${claudeJson} 2>&1; echo exit=$?`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // Check the marker wasn't appended
    const currentContent = await readFile(claudeJson, "utf-8");
    const wasModified = currentContent.includes("DEER_SECURITY_MARKER");
    if (wasModified) {
      // Clean up: remove the marker line
      const cleaned = currentContent.replace(/\nDEER_SECURITY_MARKER\n?/g, "");
      await writeFile(claudeJson, cleaned);
    }
    expect(wasModified).toBe(false);
  });
});

// ── B6: Cargo/npm/pip registry cache as read vector ──────────────────

describe("package manager cache isolation", () => {
  test("~/.cargo is read-only, not writable", async () => {
    const home = process.env.HOME!;
    const cargoDir = join(home, ".cargo");

    if (!existsSync(cargoDir)) {
      console.log("Skipping: no ~/.cargo found");
      return;
    }

    const dir = await makeTmpDir();
    const marker = `deer-sec-test-${Date.now()}`;
    const proc = nonoRun(
      dir,
      `echo pwned > ${cargoDir}/${marker} 2>&1; echo exit=$?`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(existsSync(join(cargoDir, marker))).toBe(false);
  });
});

// ── B7: /tmp cross-sandbox data leakage ──────────────────────────────

describe("/tmp isolation between sandbox sessions", () => {
  // ACCEPTED RISK: nono shares the host's /tmp (no mount namespaces).
  // Cross-sandbox /tmp leakage is a known nono limitation being tracked upstream.
  test.skip("sandbox can write to /tmp (allowed by profile)", async () => {
    const dir = await makeTmpDir();
    const marker = `deer-sec-xsandbox-${Date.now()}`;
    const proc = nonoRun(dir, `echo leaked > /tmp/${marker} && cat /tmp/${marker}`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // /tmp is rw in the claude-code profile. Unlike bwrap (which used
    // --tmpfs /tmp for isolation), nono shares the host's /tmp.
    // A compromised agent can leave data in /tmp for other sandbox
    // sessions to read — cross-sandbox data leakage.
    const leaked = existsSync(`/tmp/${marker}`);
    if (leaked) {
      await rm(`/tmp/${marker}`).catch(() => {});
    }
    expect(leaked).toBe(false);
  });
});
