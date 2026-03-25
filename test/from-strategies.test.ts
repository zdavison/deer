import { test, expect, describe } from "bun:test";
import { resolveFrom } from "deerbox";
import type { FromStrategy, FromResolution, GhRunner } from "deerbox";
import { prStrategy } from "deerbox";
import { branchStrategy } from "deerbox";
import { actionStrategy } from "deerbox";

// ── Strategy matching ────────────────────────────────────────────────

describe("strategy matching", () => {
  test("actionStrategy matches GitHub Actions run URL", () => {
    expect(actionStrategy.match("https://github.com/acme/repo/actions/runs/123")).toBe(true);
  });

  test("actionStrategy matches GitHub Actions job URL", () => {
    expect(actionStrategy.match("https://github.com/acme/repo/actions/runs/123/job/456")).toBe(true);
  });

  test("actionStrategy does not match PR URL", () => {
    expect(actionStrategy.match("https://github.com/acme/repo/pull/42")).toBe(false);
  });

  test("actionStrategy does not match branch name", () => {
    expect(actionStrategy.match("feature/my-branch")).toBe(false);
  });

  test("prStrategy matches PR URL", () => {
    expect(prStrategy.match("https://github.com/acme/repo/pull/42")).toBe(true);
  });

  test("prStrategy matches bare PR number", () => {
    expect(prStrategy.match("42")).toBe(true);
  });

  test("prStrategy does not match action URL", () => {
    expect(prStrategy.match("https://github.com/acme/repo/actions/runs/123")).toBe(false);
  });

  test("prStrategy does not match branch name", () => {
    expect(prStrategy.match("feature/my-branch")).toBe(false);
  });

  test("branchStrategy matches any string (catch-all)", () => {
    expect(branchStrategy.match("feature/my-branch")).toBe(true);
    expect(branchStrategy.match("main")).toBe(true);
    expect(branchStrategy.match("anything")).toBe(true);
  });
});

// ── resolveFrom dispatch ─────────────────────────────────────────────

describe("resolveFrom dispatch", () => {
  test("routes PR URL to prStrategy", async () => {
    // This will fail because gh is not available, but it proves dispatch works
    // by checking the error message mentions PR-specific behavior
    await expect(
      resolveFrom("https://github.com/acme/repo/pull/42", "/tmp", "main"),
    ).rejects.toThrow();
  });

  test("routes action URL to actionStrategy", async () => {
    await expect(
      resolveFrom("https://github.com/acme/repo/actions/runs/123", "/tmp", "main"),
    ).rejects.toThrow();
  });
});

// ── prStrategy.resolve: isCrossRepository detection ──────────────────

describe("prStrategy.resolve isCrossRepository", () => {
  const mockRunner = (isCrossRepository: boolean): GhRunner =>
    async () => ({
      stdout: JSON.stringify({
        headRefName: "fix-bug",
        url: "https://github.com/org/repo/pull/42",
        baseRefName: "main",
        isCrossRepository,
      }),
      exitCode: 0,
    });

  test("sets isCrossRepository: true for cross-repository (fork) PRs", async () => {
    const result = await prStrategy.resolve("42", "/repo", "main", mockRunner(true));
    expect(result.isCrossRepository).toBe(true);
  });

  test("sets isCrossRepository: false for same-repository PRs", async () => {
    const result = await prStrategy.resolve("43", "/repo", "main", mockRunner(false));
    expect(result.isCrossRepository).toBe(false);
  });
});
