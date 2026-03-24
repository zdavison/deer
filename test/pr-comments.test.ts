import { test, expect, describe } from "bun:test";
import { formatPRComments, fetchPRComments } from "deerbox";
import type { PRReviewComment, PRIssueComment, GhApiRunner } from "deerbox";

// ── formatPRComments ──────────────────────────────────────────────────

describe("formatPRComments", () => {
  test("returns null when both arrays are empty", () => {
    expect(formatPRComments([], [])).toBeNull();
  });

  test("formats inline review comments with file and line", () => {
    const reviewComments: PRReviewComment[] = [
      { user: { login: "alice" }, body: "Add a null check here.", path: "src/auth.ts", line: 42 },
    ];
    const result = formatPRComments(reviewComments, []);
    expect(result).toContain("PR Review Comments:");
    expect(result).toContain("[Review by @alice on src/auth.ts line 42]");
    expect(result).toContain("Add a null check here.");
  });

  test("formats inline review comments without line number", () => {
    const reviewComments: PRReviewComment[] = [
      { user: { login: "bob" }, body: "Consider a helper.", path: "src/utils.ts" },
    ];
    const result = formatPRComments(reviewComments, []);
    expect(result).toContain("[Review by @bob on src/utils.ts]");
    expect(result).toContain("Consider a helper.");
  });

  test("formats issue-level comments", () => {
    const issueComments: PRIssueComment[] = [
      { user: { login: "carol" }, body: "Overall LGTM but please add tests." },
    ];
    const result = formatPRComments([], issueComments);
    expect(result).toContain("PR Review Comments:");
    expect(result).toContain("[Comment by @carol]");
    expect(result).toContain("Overall LGTM but please add tests.");
  });

  test("formats mixed review and issue comments", () => {
    const reviewComments: PRReviewComment[] = [
      { user: { login: "alice" }, body: "Inline note.", path: "src/foo.ts", line: 10 },
    ];
    const issueComments: PRIssueComment[] = [
      { user: { login: "bob" }, body: "General comment." },
    ];
    const result = formatPRComments(reviewComments, issueComments);
    expect(result).toContain("[Review by @alice on src/foo.ts line 10]");
    expect(result).toContain("[Comment by @bob]");
  });

  test("skips comments with empty body", () => {
    const reviewComments: PRReviewComment[] = [
      { user: { login: "alice" }, body: "" },
      { user: { login: "bob" }, body: "Keep this." },
    ];
    const result = formatPRComments(reviewComments, []);
    expect(result).not.toContain("@alice");
    expect(result).toContain("@bob");
  });

  test("trims whitespace from comment bodies", () => {
    const reviewComments: PRReviewComment[] = [
      { user: { login: "alice" }, body: "  spaced out  " },
    ];
    const result = formatPRComments(reviewComments, []);
    expect(result).toContain("spaced out");
    expect(result).not.toContain("  spaced out  ");
  });
});

// ── fetchPRComments ───────────────────────────────────────────────────

describe("fetchPRComments", () => {
  const prUrl = "https://github.com/acme/myrepo/pull/7";

  function makeRunner(responses: Record<string, { exitCode: number; stdout: string }>): GhApiRunner {
    return async (endpoint) => responses[endpoint] ?? { exitCode: 1, stdout: "" };
  }

  test("returns null when both API calls fail", async () => {
    const runner = makeRunner({});
    const result = await fetchPRComments(prUrl, runner);
    expect(result).toBeNull();
  });

  test("returns null when both API calls return empty arrays", async () => {
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: "[]" },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: "[]" },
    });
    const result = await fetchPRComments(prUrl, runner);
    expect(result).toBeNull();
  });

  test("returns formatted string when review comments exist", async () => {
    const reviewComments: PRReviewComment[] = [
      { user: { login: "alice" }, body: "Null check needed.", path: "src/auth.ts", line: 5 },
    ];
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: JSON.stringify(reviewComments) },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: "[]" },
    });
    const result = await fetchPRComments(prUrl, runner);
    expect(result).not.toBeNull();
    expect(result).toContain("[Review by @alice on src/auth.ts line 5]");
    expect(result).toContain("Null check needed.");
  });

  test("returns formatted string when issue comments exist", async () => {
    const issueComments: PRIssueComment[] = [
      { user: { login: "bob" }, body: "Please add tests." },
    ];
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: "[]" },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: JSON.stringify(issueComments) },
    });
    const result = await fetchPRComments(prUrl, runner);
    expect(result).not.toBeNull();
    expect(result).toContain("[Comment by @bob]");
    expect(result).toContain("Please add tests.");
  });

  test("gracefully handles malformed JSON from API", async () => {
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: "not json" },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: "[]" },
    });
    const result = await fetchPRComments(prUrl, runner);
    expect(result).toBeNull();
  });

  test("parses owner/repo/number correctly from URL", async () => {
    const calls: string[] = [];
    const runner: GhApiRunner = async (endpoint) => {
      calls.push(endpoint);
      return { exitCode: 0, stdout: "[]" };
    };
    await fetchPRComments("https://github.com/my-org/cool-repo/pull/99", runner);
    expect(calls).toContain("/repos/my-org/cool-repo/pulls/99/comments");
    expect(calls).toContain("/repos/my-org/cool-repo/issues/99/comments");
  });
});
