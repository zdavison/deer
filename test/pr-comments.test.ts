import { test, expect, describe } from "bun:test";
import { formatPRComments, fetchPRComments } from "deerbox";
import type { PRReviewComment, PRIssueComment, GhApiRunner, GhGraphqlRunner, FetchPRCommentsResult, ThreadStatusMap } from "deerbox";

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

  test("annotates resolved comments via threadStatus", () => {
    const reviewComments: PRReviewComment[] = [
      { id: 1, user: { login: "alice" }, body: "Fix this.", path: "src/foo.ts", line: 10 },
    ];
    const threadStatus: ThreadStatusMap = new Map([[1, { isResolved: true, isOutdated: false }]]);
    const result = formatPRComments(reviewComments, [], threadStatus);
    expect(result).toContain("[Review by @alice on src/foo.ts line 10 — RESOLVED]");
  });

  test("annotates outdated comments via threadStatus", () => {
    const reviewComments: PRReviewComment[] = [
      { id: 2, user: { login: "bob" }, body: "Old issue.", path: "src/bar.ts", line: 5 },
    ];
    const threadStatus: ThreadStatusMap = new Map([[2, { isResolved: false, isOutdated: true }]]);
    const result = formatPRComments(reviewComments, [], threadStatus);
    expect(result).toContain("[Review by @bob on src/bar.ts line 5 — OUTDATED]");
  });

  test("annotates outdated comments via REST position=null when no threadStatus", () => {
    const reviewComments: PRReviewComment[] = [
      { id: 3, user: { login: "carol" }, body: "Stale note.", path: "src/baz.ts", line: 1, position: null },
    ];
    const result = formatPRComments(reviewComments, []);
    expect(result).toContain("[Review by @carol on src/baz.ts line 1 — OUTDATED]");
  });

  test("does not annotate active comments with position set", () => {
    const reviewComments: PRReviewComment[] = [
      { id: 4, user: { login: "dave" }, body: "Active.", path: "src/qux.ts", line: 7, position: 3 },
    ];
    const result = formatPRComments(reviewComments, []);
    expect(result).toContain("[Review by @dave on src/qux.ts line 7]");
    expect(result).not.toContain("OUTDATED");
    expect(result).not.toContain("RESOLVED");
  });

  test("threadStatus takes priority over REST position for outdated detection", () => {
    // position is null (would normally mean outdated) but thread says it's resolved
    const reviewComments: PRReviewComment[] = [
      { id: 5, user: { login: "eve" }, body: "Done.", path: "src/x.ts", line: 2, position: null },
    ];
    const threadStatus: ThreadStatusMap = new Map([[5, { isResolved: true, isOutdated: false }]]);
    const result = formatPRComments(reviewComments, [], threadStatus);
    expect(result).toContain("— RESOLVED");
    expect(result).not.toContain("OUTDATED");
  });
});

// ── fetchPRComments ───────────────────────────────────────────────────

describe("fetchPRComments", () => {
  const prUrl = "https://github.com/acme/myrepo/pull/7";

  /** No-op graphql runner — simulates GraphQL being unavailable */
  const noopGraphql: GhGraphqlRunner = async () => ({ exitCode: 1, stdout: "" });

  function makeRunner(responses: Record<string, { exitCode: number; stdout: string }>): GhApiRunner {
    return async (endpoint) => responses[endpoint] ?? { exitCode: 1, stdout: "" };
  }

  test("returns null formatted and zero counts when both API calls fail", async () => {
    const runner = makeRunner({});
    const result = await fetchPRComments(prUrl, runner, noopGraphql);
    expect(result.formatted).toBeNull();
    expect(result.reviewCount).toBe(0);
    expect(result.issueCount).toBe(0);
  });

  test("returns null formatted and zero counts when both API calls return empty arrays", async () => {
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: "[]" },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: "[]" },
    });
    const result = await fetchPRComments(prUrl, runner, noopGraphql);
    expect(result.formatted).toBeNull();
    expect(result.reviewCount).toBe(0);
    expect(result.issueCount).toBe(0);
  });

  test("returns formatted string and correct counts when review comments exist", async () => {
    const reviewComments: PRReviewComment[] = [
      { user: { login: "alice" }, body: "Null check needed.", path: "src/auth.ts", line: 5 },
    ];
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: JSON.stringify(reviewComments) },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: "[]" },
    });
    const result = await fetchPRComments(prUrl, runner, noopGraphql);
    expect(result.formatted).not.toBeNull();
    expect(result.formatted).toContain("[Review by @alice on src/auth.ts line 5]");
    expect(result.formatted).toContain("Null check needed.");
    expect(result.reviewCount).toBe(1);
    expect(result.issueCount).toBe(0);
  });

  test("returns formatted string and correct counts when issue comments exist", async () => {
    const issueComments: PRIssueComment[] = [
      { user: { login: "bob" }, body: "Please add tests." },
    ];
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: "[]" },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: JSON.stringify(issueComments) },
    });
    const result = await fetchPRComments(prUrl, runner, noopGraphql);
    expect(result.formatted).not.toBeNull();
    expect(result.formatted).toContain("[Comment by @bob]");
    expect(result.formatted).toContain("Please add tests.");
    expect(result.reviewCount).toBe(0);
    expect(result.issueCount).toBe(1);
  });

  test("counts only non-empty comments", async () => {
    const reviewComments: PRReviewComment[] = [
      { user: { login: "alice" }, body: "Keep this." },
      { user: { login: "bob" }, body: "" },
    ];
    const issueComments: PRIssueComment[] = [
      { user: { login: "carol" }, body: "LGTM" },
      { user: { login: "dave" }, body: "   " },
    ];
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: JSON.stringify(reviewComments) },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: JSON.stringify(issueComments) },
    });
    const result = await fetchPRComments(prUrl, runner, noopGraphql);
    expect(result.reviewCount).toBe(1);
    expect(result.issueCount).toBe(1);
  });

  test("gracefully handles malformed JSON from API", async () => {
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: "not json" },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: "[]" },
    });
    const result = await fetchPRComments(prUrl, runner, noopGraphql);
    expect(result.formatted).toBeNull();
    expect(result.reviewCount).toBe(0);
    expect(result.issueCount).toBe(0);
  });

  test("parses owner/repo/number correctly from URL", async () => {
    const calls: string[] = [];
    const runner: GhApiRunner = async (endpoint) => {
      calls.push(endpoint);
      return { exitCode: 0, stdout: "[]" };
    };
    await fetchPRComments("https://github.com/my-org/cool-repo/pull/99", runner, noopGraphql);
    expect(calls).toContain("/repos/my-org/cool-repo/pulls/99/comments");
    expect(calls).toContain("/repos/my-org/cool-repo/issues/99/comments");
  });

  test("applies resolved/outdated status from graphql runner", async () => {
    const reviewComments: PRReviewComment[] = [
      { id: 101, user: { login: "alice" }, body: "Fix me.", path: "src/a.ts", line: 1, position: 5 },
      { id: 102, user: { login: "bob" }, body: "Already done.", path: "src/b.ts", line: 2, position: 8 },
    ];
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: JSON.stringify(reviewComments) },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: "[]" },
    });
    const graphqlRunner: GhGraphqlRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 101 }] } },
                  { isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 102 }] } },
                ],
              },
            },
          },
        },
      }),
    });
    const result = await fetchPRComments(prUrl, runner, graphqlRunner);
    expect(result.formatted).toContain("[Review by @alice on src/a.ts line 1]");
    expect(result.formatted).not.toMatch(/alice.*RESOLVED|alice.*OUTDATED/);
    expect(result.formatted).toContain("[Review by @bob on src/b.ts line 2 — RESOLVED]");
  });

  test("falls back to REST position=null for outdated when graphql fails", async () => {
    const reviewComments: PRReviewComment[] = [
      { id: 200, user: { login: "carol" }, body: "Stale.", path: "src/c.ts", line: 3, position: null },
    ];
    const runner = makeRunner({
      "/repos/acme/myrepo/pulls/7/comments": { exitCode: 0, stdout: JSON.stringify(reviewComments) },
      "/repos/acme/myrepo/issues/7/comments": { exitCode: 0, stdout: "[]" },
    });
    const result = await fetchPRComments(prUrl, runner, noopGraphql);
    expect(result.formatted).toContain("[Review by @carol on src/c.ts line 3 — OUTDATED]");
  });
});
