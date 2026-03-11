/**
 * Security tests: ANTHROPIC_API_KEY must never reach sandboxed Claude processes.
 *
 * Deer authenticates via CLAUDE_CODE_OAUTH_TOKEN (OAuth). ANTHROPIC_API_KEY is
 * deleted from the host env at CLI startup (src/cli.tsx) and must not leak into
 * the sandbox via any code path.
 *
 * With SRT, env isolation is handled by the srt CLI's sandbox-exec / bwrap
 * wrapper + deer's env-i preamble in launchSandbox. These tests verify
 * the buildCommand output does not embed the key.
 */
import { test, expect, describe } from "bun:test";
import { createSrtRuntime } from "../../src/sandbox/srt";
import type { SandboxRuntimeOptions } from "../../src/sandbox/runtime";

const defaults: SandboxRuntimeOptions = {
  worktreePath: "/tmp/deer-test-worktree",
  allowlist: ["api.anthropic.com"],
};

describe("credential isolation — srt command construction", () => {
  test("ANTHROPIC_API_KEY from host env does not appear in srt args", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-isolation-sentinel";
    try {
      const runtime = createSrtRuntime();
      const args = runtime.buildCommand(defaults, ["claude"]);
      expect(args.join("\0")).not.toContain("sk-ant-isolation-sentinel");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("CLAUDE_CODE_OAUTH_TOKEN is passed when provided in env", () => {
    const runtime = createSrtRuntime();
    const args = runtime.buildCommand(
      { ...defaults, env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok-test" } },
      ["claude"],
    );

    const joined = args.join("\0");
    expect(joined).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(joined).toContain("oauth-tok-test");
  });

  test("ANTHROPIC_API_KEY is not set even when other env vars are forwarded", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-isolation-sentinel";
    try {
      const runtime = createSrtRuntime();
      const args = runtime.buildCommand(
        { ...defaults, env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok-test" } },
        ["claude"],
      );
      expect(args.join("\0")).not.toContain("sk-ant-isolation-sentinel");
      expect(args.join("\0")).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });
});
