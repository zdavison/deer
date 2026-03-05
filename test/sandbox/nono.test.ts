import { test, expect, describe, afterEach } from "bun:test";
import { buildNonoArgs, type NonoOptions } from "../../src/sandbox/nono";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildNonoArgs", () => {
  const defaults: NonoOptions = {
    worktreePath: "/home/user/project",
    allowlist: ["api.anthropic.com", "github.com"],
  };

  test("returns nono as first arg", () => {
    const args = buildNonoArgs(defaults);
    expect(args[0]).toBe("nono");
    expect(args[1]).toBe("run");
  });

  test("includes --silent flag", () => {
    const args = buildNonoArgs(defaults);
    expect(args).toContain("--silent");
  });

  test("uses claude-code profile", () => {
    const args = buildNonoArgs(defaults);
    const idx = args.indexOf("--profile");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx + 1]).toBe("claude-code");
  });

  test("grants read-write access to worktree", () => {
    const args = buildNonoArgs(defaults);
    const idx = args.indexOf("--allow");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx + 1]).toBe(defaults.worktreePath);
  });

  test("does not include --workdir (nono v0.10.0 bug)", () => {
    const args = buildNonoArgs(defaults);
    expect(args).not.toContain("--workdir");
  });

  test("includes --allow-cwd", () => {
    const args = buildNonoArgs(defaults);
    expect(args).toContain("--allow-cwd");
  });

  test("adds --proxy-allow for each allowlist entry", () => {
    const args = buildNonoArgs(defaults);
    const proxyAllows = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--proxy-allow") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(proxyAllows).toContain("api.anthropic.com");
    expect(proxyAllows).toContain("github.com");
  });

  test("adds --read for repoGitDir when provided and exists", () => {
    const args = buildNonoArgs({
      ...defaults,
      repoGitDir: "/usr", // use /usr as a path that exists
    });
    const reads = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--read") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(reads).toContain("/usr");
  });

  test("skips repoGitDir when path does not exist", () => {
    const args = buildNonoArgs({
      ...defaults,
      repoGitDir: "/nonexistent-repo-git-dir-xyz",
    });
    expect(args.join(" ")).not.toContain("/nonexistent-repo-git-dir-xyz");
  });

  test("adds extra read paths", () => {
    const args = buildNonoArgs({
      ...defaults,
      extraReadPaths: ["/usr/share", "/nonexistent-path-xyz"],
    });
    const reads = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--read") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(reads).toContain("/usr/share");
    expect(reads).not.toContain("/nonexistent-path-xyz");
  });

  test("adds extra write paths", () => {
    const args = buildNonoArgs({
      ...defaults,
      extraWritePaths: ["/tmp"],
    });
    // Find --allow flags (after the worktree one)
    const allows = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--allow") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(allows).toContain("/tmp");
  });

  test("ends with -- separator", () => {
    const args = buildNonoArgs(defaults);
    expect(args[args.length - 1]).toBe("--");
  });
});

describe("nono integration", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-nono-test-"));
    tmpDirs.push(d);
    return d;
  }

  test("nono can run a simple command in the sandbox", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "test.txt"), "hello");

    const args = buildNonoArgs({
      worktreePath: dir,
      allowlist: [],
    });

    const proc = Bun.spawn([...args, "cat", join(dir, "test.txt")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(code).toBe(0);
    expect(stdout).toContain("hello");
  });

  test("nono can write files inside the worktree", async () => {
    const dir = await makeTmpDir();
    const args = buildNonoArgs({
      worktreePath: dir,
      allowlist: [],
    });

    const proc = Bun.spawn([...args, "sh", "-c", `echo "written" > ${dir}/output.txt`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const content = await readFile(join(dir, "output.txt"), "utf-8");
    expect(content.trim()).toBe("written");
  });

  test("nono blocks direct network access when using proxy", async () => {
    const dir = await makeTmpDir();
    const args = buildNonoArgs({
      worktreePath: dir,
      allowlist: ["example.com"],
    });

    // curl --noproxy bypasses HTTP_PROXY — should fail with Landlock TCP restriction
    const proc = Bun.spawn([
      ...args,
      "sh", "-c",
      `curl --noproxy '*' --max-time 3 -s https://example.com > ${dir}/out.txt 2>&1 || echo "BLOCKED" > ${dir}/out.txt`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);

  test("nono allows proxied access to allowlisted hosts", async () => {
    const dir = await makeTmpDir();
    const args = buildNonoArgs({
      worktreePath: dir,
      allowlist: ["example.com"],
    });

    const proc = Bun.spawn([
      ...args,
      "sh", "-c",
      `curl -s --max-time 5 https://example.com > ${dir}/out.txt 2>&1`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content).toContain("Example Domain");
  }, 10000);

  test("nono passes environment variables", async () => {
    const dir = await makeTmpDir();
    const args = buildNonoArgs({
      worktreePath: dir,
      allowlist: [],
    });

    const proc = Bun.spawn([...args, "sh", "-c", "echo $MY_VAR"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MY_VAR: "deer_test_value" },
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toContain("deer_test_value");
  });
});
