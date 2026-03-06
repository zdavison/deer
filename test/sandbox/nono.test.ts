import { test, expect, describe } from "bun:test";
import { nonoRuntime } from "../../src/sandbox/nono";
import type { SandboxRuntimeOptions } from "../../src/sandbox/runtime";

describe("nonoRuntime.buildCommand", () => {
  const defaults: SandboxRuntimeOptions = {
    worktreePath: "/home/user/project",
    allowlist: ["api.anthropic.com", "github.com"],
  };

  function buildArgs(opts = defaults) {
    return nonoRuntime.buildCommand(opts, ["echo", "test"]);
  }

  test("returns nono as first arg", () => {
    const args = buildArgs();
    expect(args[0]).toBe("nono");
    expect(args[1]).toBe("run");
  });

  test("includes --silent flag", () => {
    const args = buildArgs();
    expect(args).toContain("--silent");
  });

  test("uses claude-code profile", () => {
    const args = buildArgs();
    const idx = args.indexOf("--profile");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx + 1]).toBe("claude-code");
  });

  test("grants read-write access to worktree", () => {
    const args = buildArgs();
    const idx = args.indexOf("--allow");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx + 1]).toBe(defaults.worktreePath);
  });

  test("does not include --workdir (nono v0.10.0 bug)", () => {
    const args = buildArgs();
    expect(args).not.toContain("--workdir");
  });

  test("includes --allow-cwd", () => {
    const args = buildArgs();
    expect(args).toContain("--allow-cwd");
  });

  test("adds --proxy-allow for each allowlist entry", () => {
    const args = buildArgs();
    const proxyAllows = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--proxy-allow") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(proxyAllows).toContain("api.anthropic.com");
    expect(proxyAllows).toContain("github.com");
  });

  test("adds --read for repoGitDir when provided and exists", () => {
    const args = buildArgs({
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
    const args = buildArgs({
      ...defaults,
      repoGitDir: "/nonexistent-repo-git-dir-xyz",
    });
    expect(args.join(" ")).not.toContain("/nonexistent-repo-git-dir-xyz");
  });

  test("adds extra read paths", () => {
    const args = buildArgs({
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
    const args = buildArgs({
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

  test("includes -- separator before inner command", () => {
    const args = buildArgs();
    expect(args).toContain("--");
    const sepIdx = args.indexOf("--");
    // After --, the command is: sh -c 'cd ... && exec ...'
    expect(args[sepIdx + 1]).toBe("sh");
    expect(args[sepIdx + 2]).toBe("-c");
  });

  test("wraps inner command in cd + exec", () => {
    const args = nonoRuntime.buildCommand(defaults, ["claude", "--model", "sonnet"]);
    const shCmd = args[args.length - 1];
    expect(shCmd).toContain("cd '/home/user/project'");
    expect(shCmd).toContain("exec 'claude' '--model' 'sonnet'");
  });
});

