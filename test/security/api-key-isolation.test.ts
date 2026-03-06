/**
 * Security tests: ANTHROPIC_API_KEY must never reach sandboxed Claude processes.
 *
 * Deer authenticates via CLAUDE_CODE_OAUTH_TOKEN (OAuth). ANTHROPIC_API_KEY is
 * deleted from the host env at CLI startup (src/cli.tsx) and must not leak into
 * the bwrap sandbox or the proxy via any code path.
 */
import { test, expect, describe } from "bun:test";
import { createBwrapRuntime } from "../../src/sandbox/bwrap";
import type { SandboxRuntimeOptions } from "../../src/sandbox/runtime";

const defaults: SandboxRuntimeOptions = {
  worktreePath: "/home/user/project",
  allowlist: ["api.anthropic.com"],
};

/** Collect all values set via --setenv in a bwrap arg array. */
function getSetenvKeys(args: string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--setenv") keys.push(args[i + 1]);
  }
  return keys;
}

describe("credential isolation — bwrap command construction", () => {
  test("ANTHROPIC_API_KEY from host env does not appear in --setenv args", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-isolation-sentinel";
    try {
      const runtime = createBwrapRuntime();
      const args = runtime.buildCommand(defaults, ["claude"]);
      expect(getSetenvKeys(args)).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("ANTHROPIC_API_KEY value does not appear anywhere in bwrap args", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-isolation-sentinel";
    try {
      const runtime = createBwrapRuntime();
      const args = runtime.buildCommand(defaults, ["claude"]);
      // Use NUL-delimited join to catch the value even as a substring of another arg
      expect(args.join("\0")).not.toContain("sk-ant-isolation-sentinel");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("ANTHROPIC_API_KEY is not set even when other env vars are forwarded", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-isolation-sentinel";
    try {
      const runtime = createBwrapRuntime();
      // Simulate a caller forwarding OAuth token but not the API key
      const args = runtime.buildCommand(
        { ...defaults, env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok-test" } },
        ["claude"],
      );
      expect(getSetenvKeys(args)).not.toContain("ANTHROPIC_API_KEY");
      expect(getSetenvKeys(args)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("CLAUDE_CODE_OAUTH_TOKEN is passed via --setenv when provided in env", () => {
    const runtime = createBwrapRuntime();
    const args = runtime.buildCommand(
      { ...defaults, env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok-test" } },
      ["claude"],
    );

    const idx = args.indexOf("CLAUDE_CODE_OAUTH_TOKEN");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe("--setenv");
    expect(args[idx + 1]).toBe("oauth-tok-test");
  });
});
