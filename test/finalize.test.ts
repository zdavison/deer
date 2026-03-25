import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ensureDeerEmojiPrefix, findPRTemplate, parsePRMetadataResponse, buildClaudeSubprocessEnv, isPRAuthorFromLogins } from "deerbox";

describe("ensureDeerEmojiPrefix", () => {
  test("adds deer emoji to plain title", () => {
    expect(ensureDeerEmojiPrefix("Fix login redirect loop")).toBe("🦌 Fix login redirect loop");
  });

  test("does not double-add deer emoji", () => {
    expect(ensureDeerEmojiPrefix("🦌 Fix login redirect loop")).toBe("🦌 Fix login redirect loop");
  });

  test("handles empty string", () => {
    expect(ensureDeerEmojiPrefix("")).toBe("🦌 ");
  });

  test("handles title that already starts with emoji and space", () => {
    expect(ensureDeerEmojiPrefix("🦌 Add user search endpoint")).toBe("🦌 Add user search endpoint");
  });
});

describe("findPRTemplate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no template exists", async () => {
    expect(await findPRTemplate(tmpDir)).toBeNull();
  });

  test("finds .github/PULL_REQUEST_TEMPLATE.md", async () => {
    await mkdir(join(tmpDir, ".github"));
    await writeFile(join(tmpDir, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Summary\n\n## Changes\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Summary\n\n## Changes\n");
  });

  test("finds .github/pull_request_template.md (lowercase)", async () => {
    await mkdir(join(tmpDir, ".github"));
    await writeFile(join(tmpDir, ".github", "pull_request_template.md"), "## Description\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Description\n");
  });

  test("finds docs/pull_request_template.md", async () => {
    await mkdir(join(tmpDir, "docs"));
    await writeFile(join(tmpDir, "docs", "pull_request_template.md"), "## Docs template\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Docs template\n");
  });

  test("finds pull_request_template.md at root", async () => {
    await writeFile(join(tmpDir, "pull_request_template.md"), "## Root template\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Root template\n");
  });

  test("finds first file in .github/PULL_REQUEST_TEMPLATE/ directory", async () => {
    await mkdir(join(tmpDir, ".github", "PULL_REQUEST_TEMPLATE"), { recursive: true });
    await writeFile(join(tmpDir, ".github", "PULL_REQUEST_TEMPLATE", "feature.md"), "## Feature template\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Feature template\n");
  });

  test("prefers .github/PULL_REQUEST_TEMPLATE.md over docs/pull_request_template.md", async () => {
    await mkdir(join(tmpDir, ".github"));
    await mkdir(join(tmpDir, "docs"));
    await writeFile(join(tmpDir, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Primary\n");
    await writeFile(join(tmpDir, "docs", "pull_request_template.md"), "## Secondary\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Primary\n");
  });
});

describe("parsePRMetadataResponse", () => {
  test("parses valid claude --output-format json wrapper", () => {
    const rawOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ branchName: "fix-login", title: "Fix login", body: "## Summary\nFix" }),
    });
    const parsed = parsePRMetadataResponse(rawOutput);
    expect(parsed.branchName).toBe("fix-login");
    expect(parsed.title).toBe("Fix login");
    expect(parsed.body).toBe("## Summary\nFix");
  });

  test("parses unwrapped JSON (fallback when not wrapped)", () => {
    const rawOutput = JSON.stringify({ branchName: "add-search", title: "Add search", body: "## Summary\nAdded" });
    const parsed = parsePRMetadataResponse(rawOutput);
    expect(parsed.branchName).toBe("add-search");
    expect(parsed.title).toBe("Add search");
  });

  test("parses multiline body correctly", () => {
    const body = "## Task\n> Fix it\n\n## Summary\nFixed the issue\n\n## Changes\n- src/foo.ts\n\n---\n> Created by deer";
    const rawOutput = JSON.stringify({
      type: "result",
      result: JSON.stringify({ branchName: "fix-it", title: "Fix it", body }),
    });
    const parsed = parsePRMetadataResponse(rawOutput);
    expect(parsed.body).toBe(body);
    expect(parsed.body.split("\n").length).toBeGreaterThan(3);
  });

  test("throws when no JSON object found", () => {
    expect(() => parsePRMetadataResponse("not json at all")).toThrow("No JSON found");
  });

  test("throws when required fields are missing", () => {
    const rawOutput = JSON.stringify({ type: "result", result: JSON.stringify({ branchName: "test" }) });
    expect(() => parsePRMetadataResponse(rawOutput)).toThrow("Missing required fields");
  });

  test("throws when result field is empty string", () => {
    const rawOutput = JSON.stringify({ type: "result", result: "" });
    expect(() => parsePRMetadataResponse(rawOutput)).toThrow();
  });

  test("handles body containing unbalanced braces in code blocks", () => {
    const body = "## Changes\n- Updated `Config { value: 1 }` struct\n```ts\nfunction() {\n  return 1;\n}\n```";
    const rawOutput = JSON.stringify({
      type: "result",
      result: JSON.stringify({ branchName: "fix-config", title: "Fix config struct", body }),
    });
    const parsed = parsePRMetadataResponse(rawOutput);
    expect(parsed.branchName).toBe("fix-config");
    expect(parsed.body).toBe(body);
  });

  test("extracts first JSON object when surrounded by extra text", () => {
    const rawOutput = 'Here is the metadata:\n{"branchName": "fix", "title": "Fix it", "body": "done"}\nDone!';
    const parsed = parsePRMetadataResponse(rawOutput);
    expect(parsed.branchName).toBe("fix");
  });

  test("handles body with nested JSON-like content", () => {
    const body = '## Changes\nUpdated config: {"key": "value"}\nAlso changed {other} stuff';
    const inner = JSON.stringify({ branchName: "update-config", title: "Update config", body });
    const parsed = parsePRMetadataResponse(inner);
    expect(parsed.branchName).toBe("update-config");
    expect(parsed.body).toBe(body);
  });
});

describe("CreatePROptions / UpdatePROptions prompt nullability", () => {
  test("CreatePROptions accepts null prompt", () => {
    const opts: import("deerbox").CreatePROptions = {
      repoPath: "/repo",
      worktreePath: "/repo/worktree",
      branch: "deer/some-branch",
      baseBranch: "main",
      prompt: null,
    };
    expect(opts.prompt).toBeNull();
  });

  test("UpdatePROptions accepts null prompt", () => {
    const opts: import("deerbox").UpdatePROptions = {
      repoPath: "/repo",
      worktreePath: "/repo/worktree",
      finalBranch: "deer/some-branch",
      baseBranch: "main",
      prompt: null,
      prUrl: "https://github.com/org/repo/pull/1",
    };
    expect(opts.prompt).toBeNull();
  });
});

describe("buildClaudeSubprocessEnv", () => {
  test("strips ANTHROPIC_BASE_URL (sandbox proxy URL)", () => {
    const env = buildClaudeSubprocessEnv({ ANTHROPIC_BASE_URL: "http://api.anthropic.com", HOME: "/home/z" });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.HOME).toBe("/home/z");
  });

  test("strips CLAUDE_CODE_HOST_HTTP_PROXY_PORT", () => {
    const env = buildClaudeSubprocessEnv({ CLAUDE_CODE_HOST_HTTP_PROXY_PORT: "43547", PATH: "/usr/bin" });
    expect(env.CLAUDE_CODE_HOST_HTTP_PROXY_PORT).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("strips CLAUDE_CODE_HOST_SOCKS_PROXY_PORT", () => {
    const env = buildClaudeSubprocessEnv({ CLAUDE_CODE_HOST_SOCKS_PROXY_PORT: "44589" });
    expect(env.CLAUDE_CODE_HOST_SOCKS_PROXY_PORT).toBeUndefined();
  });

  test("strips CLAUDE_CODE_OAUTH_TOKEN when it is the proxy-managed placeholder", () => {
    const env = buildClaudeSubprocessEnv({ CLAUDE_CODE_OAUTH_TOKEN: "proxy-managed" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("keeps CLAUDE_CODE_OAUTH_TOKEN when it is a real token", () => {
    const env = buildClaudeSubprocessEnv({ CLAUDE_CODE_OAUTH_TOKEN: "real-token-abc123" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("real-token-abc123");
  });

  test("sets PWD to /tmp", () => {
    const env = buildClaudeSubprocessEnv({ PWD: "/some/project" });
    expect(env.PWD).toBe("/tmp");
  });

  test("preserves other env vars", () => {
    const env = buildClaudeSubprocessEnv({ HOME: "/home/user", PATH: "/usr/bin", TERM: "xterm" });
    expect(env.HOME).toBe("/home/user");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TERM).toBe("xterm");
  });

  test("excludes undefined values from process.env", () => {
    const env = buildClaudeSubprocessEnv({ DEFINED: "yes", UNDEFINED: undefined } as Record<string, string | undefined>);
    expect(env.DEFINED).toBe("yes");
    expect("UNDEFINED" in env).toBe(false);
  });
});

describe("isPRAuthorFromLogins", () => {
  test("returns true when logins match", () => {
    expect(isPRAuthorFromLogins("alice", "alice")).toBe(true);
  });

  test("returns false when logins differ", () => {
    expect(isPRAuthorFromLogins("alice", "bob")).toBe(false);
  });

  test("returns true when current user login is unknown (empty string)", () => {
    expect(isPRAuthorFromLogins("", "alice")).toBe(true);
  });

  test("returns true when PR author login is unknown (empty string)", () => {
    expect(isPRAuthorFromLogins("alice", "")).toBe(true);
  });

  test("returns true when both logins are empty", () => {
    expect(isPRAuthorFromLogins("", "")).toBe(true);
  });

  test("is case-sensitive", () => {
    expect(isPRAuthorFromLogins("Alice", "alice")).toBe(false);
  });
});
