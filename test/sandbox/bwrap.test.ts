import { test, expect, describe, afterEach } from "bun:test";
import { buildBwrapArgs, type BwrapOptions } from "../../src/sandbox/bwrap";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildBwrapArgs", () => {
  const defaults: BwrapOptions = {
    worktreePath: "/home/user/project",
    proxyPort: 8080,
    env: {},
  };

  test("returns bwrap as first arg", () => {
    const args = buildBwrapArgs(defaults);
    expect(args[0]).toBe("bwrap");
  });

  test("bind-mounts worktree as read-write", () => {
    const args = buildBwrapArgs(defaults);
    const idx = args.indexOf("--bind");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx + 1]).toBe(defaults.worktreePath);
    expect(args[idx + 2]).toBe(defaults.worktreePath);
  });

  test("includes system paths (/usr ro-bind, /bin as ro-bind or symlink)", () => {
    const args = buildBwrapArgs(defaults);
    // /usr should always be ro-bind
    const roBinds = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--ro-bind" && args[i + 1] === args[i + 2]) acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(roBinds).toContain("/usr");

    // /bin may be a symlink on some systems, or a real dir on others
    const hasRoBind = roBinds.includes("/bin");
    const hasSymlink = args.some((arg, i) => arg === "--symlink" && args[i + 2] === "/bin");
    expect(hasRoBind || hasSymlink).toBe(true);
  });

  test("sets HTTPS_PROXY and HTTP_PROXY env vars", () => {
    const args = buildBwrapArgs(defaults);
    const proxyVal = `http://127.0.0.1:${defaults.proxyPort}`;
    const envPairs = args.reduce<Record<string, string>>((acc, arg, i) => {
      if (arg === "--setenv") acc[args[i + 1]] = args[i + 2];
      return acc;
    }, {});
    expect(envPairs["HTTPS_PROXY"]).toBe(proxyVal);
    expect(envPairs["HTTP_PROXY"]).toBe(proxyVal);
  });

  test("includes custom env vars", () => {
    const args = buildBwrapArgs({
      ...defaults,
      env: { NODE_ENV: "test", FOO: "bar" },
    });
    const envPairs = args.reduce<Record<string, string>>((acc, arg, i) => {
      if (arg === "--setenv") acc[args[i + 1]] = args[i + 2];
      return acc;
    }, {});
    expect(envPairs["NODE_ENV"]).toBe("test");
    expect(envPairs["FOO"]).toBe("bar");
  });

  test("includes --die-with-parent", () => {
    const args = buildBwrapArgs(defaults);
    expect(args).toContain("--die-with-parent");
  });

  test("ro-binds repoGitDir when provided", () => {
    const args = buildBwrapArgs({
      ...defaults,
      repoGitDir: "/usr", // use /usr as a path that exists
    });
    // Find the ro-bind for the repoGitDir (before the worktree rw bind)
    const roBinds = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--ro-bind" && args[i + 1] === "/usr" && args[i + 2] === "/usr") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(roBinds.length).toBeGreaterThanOrEqual(1);
  });

  test("skips repoGitDir when path does not exist", () => {
    const args = buildBwrapArgs({
      ...defaults,
      repoGitDir: "/nonexistent-repo-git-dir-xyz",
    });
    expect(args.join(" ")).not.toContain("/nonexistent-repo-git-dir-xyz");
  });

  test("sets --chdir to worktree path", () => {
    const args = buildBwrapArgs(defaults);
    const idx = args.indexOf("--chdir");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx + 1]).toBe(defaults.worktreePath);
  });

  test("mounts /proc and /dev", () => {
    const args = buildBwrapArgs(defaults);
    expect(args).toContain("--proc");
    expect(args).toContain("--dev");
  });

  test("ro-binds ~/.claude for config access", () => {
    const args = buildBwrapArgs(defaults);
    const home = process.env.HOME!;
    const claudeDir = join(home, ".claude");
    const idx = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === claudeDir);
    expect(idx).toBeGreaterThan(0);
  });

  test("includes extra ro-binds when paths exist", () => {
    // Use paths that exist on the host
    const args = buildBwrapArgs({
      ...defaults,
      extraRoBinds: ["/usr/share", "/nonexistent-path-xyz"],
    });
    const roBinds = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--ro-bind") acc.push(args[i + 1]);
      return acc;
    }, []);
    // /usr/share exists and should be included
    expect(roBinds).toContain("/usr/share");
    // nonexistent path should be skipped
    expect(roBinds).not.toContain("/nonexistent-path-xyz");
  });
});

describe("bwrap integration", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-bwrap-test-"));
    tmpDirs.push(d);
    return d;
  }

  test("bwrap can run a simple command in the sandbox", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "test.txt"), "hello");

    const args = buildBwrapArgs({
      worktreePath: dir,
      proxyPort: 0,
      env: {},
    });

    const proc = Bun.spawn([...args, "cat", join(dir, "test.txt")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("hello");
  });

  test("bwrap can write files inside the worktree", async () => {
    const dir = await makeTmpDir();
    const args = buildBwrapArgs({
      worktreePath: dir,
      proxyPort: 0,
      env: {},
    });

    const proc = Bun.spawn([...args, "sh", "-c", `echo "written" > ${dir}/output.txt`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const content = await readFile(join(dir, "output.txt"), "utf-8");
    expect(content.trim()).toBe("written");
  });

  test("bwrap cannot write outside the worktree", async () => {
    const dir = await makeTmpDir();
    const args = buildBwrapArgs({
      worktreePath: dir,
      proxyPort: 0,
      env: {},
    });

    // /usr is mounted read-only — writes there should fail
    const proc = Bun.spawn([...args, "sh", "-c", "echo bad > /usr/escape-test-deer 2>&1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).not.toBe(0);

    // Writes to sandbox /tmp succeed but don't escape to host /tmp
    const markerFile = `/tmp/deer-escape-check-${Date.now()}`;
    const proc2 = Bun.spawn([...args, "sh", "-c", `echo marker > ${markerFile}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc2.exited;
    // The file should NOT exist on the host
    const escaped = await Bun.file(markerFile).exists();
    expect(escaped).toBe(false);
  });

  test("bwrap passes environment variables", async () => {
    const dir = await makeTmpDir();
    const args = buildBwrapArgs({
      worktreePath: dir,
      proxyPort: 12345,
      env: { MY_VAR: "deer_test_value" },
    });

    const proc = Bun.spawn([...args, "sh", "-c", "echo $MY_VAR"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout.trim()).toBe("deer_test_value");
  });

  test("bwrap has access to /usr/bin tools", async () => {
    const dir = await makeTmpDir();
    const args = buildBwrapArgs({
      worktreePath: dir,
      proxyPort: 0,
      env: {},
    });

    const proc = Bun.spawn([...args, "which", "git"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
