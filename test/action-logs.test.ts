import { test, expect, describe } from "bun:test";
import { parseActionUrl, formatActionLogs, fetchActionLogs } from "deerbox";
import type { GhRunner } from "deerbox";

// ── parseActionUrl ───────────────────────────────────────────────────

describe("parseActionUrl", () => {
  test("parses run-only URL", () => {
    const result = parseActionUrl("https://github.com/acme/myrepo/actions/runs/12345");
    expect(result).toEqual({ owner: "acme", repo: "myrepo", runId: "12345", jobId: undefined });
  });

  test("parses run + job URL (singular /job/)", () => {
    const result = parseActionUrl("https://github.com/acme/myrepo/actions/runs/12345/job/67890");
    expect(result).toEqual({ owner: "acme", repo: "myrepo", runId: "12345", jobId: "67890" });
  });

  test("parses run + job URL (plural /jobs/)", () => {
    const result = parseActionUrl("https://github.com/acme/myrepo/actions/runs/12345/jobs/67890");
    expect(result).toEqual({ owner: "acme", repo: "myrepo", runId: "12345", jobId: "67890" });
  });

  test("handles org/repo with hyphens and dots", () => {
    const result = parseActionUrl("https://github.com/my-org/cool.repo/actions/runs/999");
    expect(result).toEqual({ owner: "my-org", repo: "cool.repo", runId: "999", jobId: undefined });
  });

  test("returns null for PR URL", () => {
    expect(parseActionUrl("https://github.com/acme/myrepo/pull/42")).toBeNull();
  });

  test("returns null for non-GitHub URL", () => {
    expect(parseActionUrl("https://gitlab.com/acme/myrepo/actions/runs/123")).toBeNull();
  });

  test("returns null for plain branch name", () => {
    expect(parseActionUrl("feature/my-branch")).toBeNull();
  });

  test("returns null for bare number", () => {
    expect(parseActionUrl("42")).toBeNull();
  });
});

// ── formatActionLogs ─────────────────────────────────────────────────

describe("formatActionLogs", () => {
  test("returns null for empty logs", () => {
    expect(formatActionLogs("")).toBeNull();
  });

  test("returns null for whitespace-only logs", () => {
    expect(formatActionLogs("   \n  \n  ")).toBeNull();
  });

  test("wraps logs with header", () => {
    const result = formatActionLogs("Error: test failed\nexit code 1");
    expect(result).toContain("GitHub Actions Failed Job Logs:");
    expect(result).toContain("Error: test failed");
    expect(result).toContain("exit code 1");
  });

  test("includes job name in header when provided", () => {
    const result = formatActionLogs("some error", "build-and-test");
    expect(result).toContain("Job: build-and-test");
  });

  test("truncates logs exceeding 500 lines and adds notice", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = formatActionLogs(lines);
    expect(result).not.toBeNull();
    // Should contain the last 500 lines, not the first
    expect(result).toContain("line 600");
    expect(result).toContain("line 101");
    expect(result).not.toContain("\nline 100\n");
    expect(result).toContain("truncated");
  });

  test("does not add truncation notice for logs under 500 lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = formatActionLogs(lines);
    expect(result).not.toContain("truncated");
  });
});

// ── fetchActionLogs ──────────────────────────────────────────────────

describe("fetchActionLogs", () => {
  const runUrl = "https://github.com/acme/myrepo/actions/runs/12345";
  const jobUrl = "https://github.com/acme/myrepo/actions/runs/12345/job/67890";

  function makeRunner(responses: Record<string, { exitCode: number; stdout: string }>): GhRunner {
    return async (args: string[]) => {
      const key = args.join(" ");
      return responses[key] ?? { exitCode: 1, stdout: "" };
    };
  }

  test("resolves branch from run metadata", async () => {
    const runner = makeRunner({
      "run view 12345 --repo acme/myrepo --json headBranch,event,headSha": {
        exitCode: 0,
        stdout: JSON.stringify({ headBranch: "feature/fix-auth", event: "push", headSha: "abc123" }),
      },
      "run view 12345 --repo acme/myrepo --log-failed": {
        exitCode: 0,
        stdout: "Error: test failed",
      },
    });
    const result = await fetchActionLogs(runUrl, "main", runner);
    expect(result.branch).toBe("feature/fix-auth");
    expect(result.baseBranch).toBe("main");
  });

  test("resolves PR URL and baseBranch for pull_request events", async () => {
    const runner = makeRunner({
      "run view 12345 --repo acme/myrepo --json headBranch,event,headSha": {
        exitCode: 0,
        stdout: JSON.stringify({ headBranch: "feature/fix-auth", event: "pull_request", headSha: "abc123" }),
      },
      "api /repos/acme/myrepo/commits/abc123/pulls": {
        exitCode: 0,
        stdout: JSON.stringify([{ number: 42, html_url: "https://github.com/acme/myrepo/pull/42", base: { ref: "develop" } }]),
      },
      "run view 12345 --repo acme/myrepo --log-failed": {
        exitCode: 0,
        stdout: "Error: test failed",
      },
    });
    const result = await fetchActionLogs(runUrl, "main", runner);
    expect(result.branch).toBe("feature/fix-auth");
    expect(result.prUrl).toBe("https://github.com/acme/myrepo/pull/42");
    expect(result.baseBranch).toBe("develop");
  });

  test("fetches job-specific logs when jobId is in URL", async () => {
    const runner = makeRunner({
      "run view 12345 --repo acme/myrepo --json headBranch,event,headSha": {
        exitCode: 0,
        stdout: JSON.stringify({ headBranch: "fix/ci", event: "push", headSha: "def456" }),
      },
      "api /repos/acme/myrepo/actions/jobs/67890/logs": {
        exitCode: 0,
        stdout: "Step 3: npm test\nError: 2 tests failed",
      },
    });
    const result = await fetchActionLogs(jobUrl, "main", runner);
    expect(result.formatted).toContain("2 tests failed");
  });

  test("uses --log-failed when no jobId in URL", async () => {
    const runner = makeRunner({
      "run view 12345 --repo acme/myrepo --json headBranch,event,headSha": {
        exitCode: 0,
        stdout: JSON.stringify({ headBranch: "fix/ci", event: "push", headSha: "def456" }),
      },
      "run view 12345 --repo acme/myrepo --log-failed": {
        exitCode: 0,
        stdout: "build\tRun npm test\nError: compilation failed",
      },
    });
    const result = await fetchActionLogs(runUrl, "main", runner);
    expect(result.formatted).toContain("compilation failed");
  });

  test("returns null formatted when no logs found", async () => {
    const runner = makeRunner({
      "run view 12345 --repo acme/myrepo --json headBranch,event,headSha": {
        exitCode: 0,
        stdout: JSON.stringify({ headBranch: "fix/ci", event: "push", headSha: "abc" }),
      },
      "run view 12345 --repo acme/myrepo --log-failed": {
        exitCode: 0,
        stdout: "",
      },
    });
    const result = await fetchActionLogs(runUrl, "main", runner);
    expect(result.formatted).toBeNull();
  });

  test("throws when URL is not a valid action URL", async () => {
    const runner = makeRunner({});
    await expect(fetchActionLogs("https://github.com/acme/myrepo/pull/42", "main", runner))
      .rejects.toThrow("Not a valid GitHub Actions URL");
  });

  test("throws when metadata fetch fails", async () => {
    const runner = makeRunner({
      "run view 12345 --repo acme/myrepo --json headBranch,event,headSha": {
        exitCode: 1,
        stdout: "",
      },
    });
    await expect(fetchActionLogs(runUrl, "main", runner))
      .rejects.toThrow("fetch run metadata");
  });

  test("falls back to defaultBranch when PR lookup fails", async () => {
    const runner = makeRunner({
      "run view 12345 --repo acme/myrepo --json headBranch,event,headSha": {
        exitCode: 0,
        stdout: JSON.stringify({ headBranch: "feature/x", event: "pull_request", headSha: "abc" }),
      },
      "api /repos/acme/myrepo/commits/abc/pulls": {
        exitCode: 1,
        stdout: "",
      },
      "run view 12345 --repo acme/myrepo --log-failed": {
        exitCode: 0,
        stdout: "some error",
      },
    });
    const result = await fetchActionLogs(runUrl, "main", runner);
    expect(result.baseBranch).toBe("main");
    expect(result.prUrl).toBeNull();
  });
});
