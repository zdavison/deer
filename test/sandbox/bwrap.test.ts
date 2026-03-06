import { test, expect, describe } from "bun:test";
import { createBwrapRuntime } from "../../src/sandbox/bwrap";
import type { SandboxRuntimeOptions } from "../../src/sandbox/runtime";

describe("bwrapRuntime.buildCommand", () => {
  const defaults: SandboxRuntimeOptions = {
    worktreePath: "/home/user/project",
    allowlist: ["api.anthropic.com", "github.com"],
  };

  test("returns bwrap as first arg", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(defaults, ["echo", "test"]);
    expect(args[0]).toBe("bwrap");
  });

  test("mounts worktree read-write", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(defaults, ["echo", "test"]);
    const bindIdx = args.lastIndexOf("--bind");
    // The last --bind should be the worktree (must overlay any prior ro-bind)
    expect(args[bindIdx + 1]).toBe(defaults.worktreePath);
    expect(args[bindIdx + 2]).toBe(defaults.worktreePath);
  });

  test("includes --die-with-parent", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(defaults, ["echo", "test"]);
    expect(args).toContain("--die-with-parent");
  });

  test("sets HOME env var", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(defaults, ["echo", "test"]);
    const idx = args.indexOf("HOME");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe("--setenv");
  });

  test("unsets CLAUDECODE", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(defaults, ["echo", "test"]);
    const idx = args.indexOf("CLAUDECODE");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe("--unsetenv");
  });

  test("uses tmpfs for /tmp", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(defaults, ["echo", "test"]);
    const idx = args.indexOf("/tmp");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe("--tmpfs");
  });

  test("mounts repoGitDir read-only when provided", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(
      { ...defaults, repoGitDir: "/usr" },
      ["echo", "test"],
    );
    // Find --ro-bind /usr /usr
    const roBind = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--ro-bind" && args[i + 1] === "/usr") acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(roBind.length).toBeGreaterThan(0);
  });

  test("passes env vars via --setenv", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(
      { ...defaults, env: { MY_TOKEN: "secret123" } },
      ["echo", "test"],
    );
    const idx = args.indexOf("MY_TOKEN");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe("--setenv");
    expect(args[idx + 1]).toBe("secret123");
  });

  test("inner command comes after -- separator", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(defaults, ["claude", "--model", "sonnet"]);
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(args.slice(sepIdx + 1)).toEqual(["claude", "--model", "sonnet"]);
  });

  test("does not pass ANTHROPIC_API_KEY from host env via --setenv", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-sentinel";
    try {
      const runtime = createBwrapRuntime();
      const args = runtime.buildCommand(defaults, ["claude"]);
      const setenvKeys: string[] = [];
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === "--setenv") setenvKeys.push(args[i + 1]);
      }
      expect(setenvKeys).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("does not embed ANTHROPIC_API_KEY value anywhere in args", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-sentinel";
    try {
      const runtime = createBwrapRuntime();
      const args = runtime.buildCommand(defaults, ["claude"]);
      const joined = args.join(" ");
      expect(joined).not.toContain("sk-ant-test-sentinel");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });
});

