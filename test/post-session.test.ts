import { test, expect, describe, beforeEach } from "bun:test";
import { runPostSession, parseChoice, renderPromptMenu } from "deerbox";
import type { PostSessionDeps, PostSessionContext, PostSessionChoice } from "deerbox";

// ── Helpers ──────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<PostSessionContext>): PostSessionContext {
  return {
    repoPath: "/repo",
    worktreePath: "/worktree",
    branch: "deer/abc123",
    baseBranch: "main",
    prompt: "fix the bug",
    ...overrides,
  };
}

interface MockTracker {
  cleanupCalled: boolean;
  destroyCalled: boolean;
  openShellPath: string | null;
  createPRCalled: boolean;
  updatePRCalled: boolean;
  logs: string[];
}

function makeDeps(overrides: {
  hasChanges?: boolean;
  choice?: PostSessionChoice;
  prUrl?: string;
  prError?: string;
  updatePRError?: string;
}): PostSessionDeps & { _tracker: MockTracker } {
  const tracker: MockTracker = {
    cleanupCalled: false,
    destroyCalled: false,
    openShellPath: null,
    createPRCalled: false,
    updatePRCalled: false,
    logs: [],
  };

  return {
    _tracker: tracker,
    hasChanges: async () => overrides.hasChanges ?? false,
    promptChoice: async () => overrides.choice ?? "k",
    createPR: async (opts) => {
      tracker.createPRCalled = true;
      if (overrides.prError) throw new Error(overrides.prError);
      return {
        prUrl: overrides.prUrl ?? "https://github.com/org/repo/pull/42",
        finalBranch: "deer/fix-the-bug",
      };
    },
    updatePR: async () => {
      tracker.updatePRCalled = true;
      if (overrides.updatePRError) throw new Error(overrides.updatePRError);
    },
    openShell: async (path) => {
      tracker.openShellPath = path;
    },
    cleanup: async () => {
      tracker.cleanupCalled = true;
    },
    destroy: async () => {
      tracker.destroyCalled = true;
    },
    log: (msg) => {
      tracker.logs.push(msg);
    },
  };
}

// ── parseChoice ──────────────────────────────────────────────────────

describe("parseChoice", () => {
  test("p → p", () => expect(parseChoice("p")).toBe("p"));
  test("P → p (case insensitive)", () => expect(parseChoice("P")).toBe("p"));
  test("k → k", () => expect(parseChoice("k")).toBe("k"));
  test("s → s", () => expect(parseChoice("s")).toBe("s"));
  test("d → d", () => expect(parseChoice("d")).toBe("d"));
  test("empty string → k (default)", () => expect(parseChoice("")).toBe("k"));
  test("whitespace → k (default)", () => expect(parseChoice("  ")).toBe("k"));
  test("unknown char → k (default)", () => expect(parseChoice("x")).toBe("k"));
  test("trims whitespace", () => expect(parseChoice("  p  ")).toBe("p"));
});

// ── runPostSession ───────────────────────────────────────────────────

describe("runPostSession", () => {
  test("no changes → destroys worktree, does not prompt", async () => {
    const deps = makeDeps({ hasChanges: false });
    const outcome = await runPostSession(makeCtx(), deps);

    expect(outcome.action).toBe("no_changes");
    expect(deps._tracker.destroyCalled).toBe(true);
    expect(deps._tracker.cleanupCalled).toBe(false);
    // Should log "no changes"
    expect(deps._tracker.logs.some((l) => l.includes("No changes"))).toBe(true);
  });

  test("changes exist → prompt is called", async () => {
    let prompted = false;
    const deps = makeDeps({ hasChanges: true, choice: "k" });
    const origPrompt = deps.promptChoice;
    deps.promptChoice = async () => {
      prompted = true;
      return origPrompt();
    };

    await runPostSession(makeCtx(), deps);
    expect(prompted).toBe(true);
  });

  test("choice k → cleanup (no destroy), logs worktree path", async () => {
    const deps = makeDeps({ hasChanges: true, choice: "k" });
    const ctx = makeCtx({ worktreePath: "/my/worktree" });
    const outcome = await runPostSession(ctx, deps);

    expect(outcome).toEqual({ action: "keep", worktreePath: "/my/worktree" });
    expect(deps._tracker.cleanupCalled).toBe(true);
    expect(deps._tracker.destroyCalled).toBe(false);
    expect(deps._tracker.logs.some((l) => l.includes("cd /my/worktree"))).toBe(true);
  });

  test("choice s → cleanup (no destroy), opens shell in worktree", async () => {
    const deps = makeDeps({ hasChanges: true, choice: "s" });
    const ctx = makeCtx({ worktreePath: "/my/worktree" });
    const outcome = await runPostSession(ctx, deps);

    expect(outcome).toEqual({ action: "shell", worktreePath: "/my/worktree" });
    expect(deps._tracker.cleanupCalled).toBe(true);
    expect(deps._tracker.destroyCalled).toBe(false);
    expect(deps._tracker.openShellPath).toBe("/my/worktree");
  });

  test("choice p → creates PR, logs URL, destroys worktree", async () => {
    const prUrl = "https://github.com/org/repo/pull/99";
    const deps = makeDeps({ hasChanges: true, choice: "p", prUrl });
    const outcome = await runPostSession(makeCtx(), deps);

    expect(outcome).toEqual({ action: "pr_created", prUrl });
    expect(deps._tracker.createPRCalled).toBe(true);
    expect(deps._tracker.destroyCalled).toBe(true);
    expect(deps._tracker.cleanupCalled).toBe(false);
    expect(deps._tracker.logs.some((l) => l.includes(prUrl))).toBe(true);
  });

  test("choice p with PR failure → cleanup (no destroy), logs error", async () => {
    const deps = makeDeps({ hasChanges: true, choice: "p", prError: "gh auth failed" });
    const ctx = makeCtx({ worktreePath: "/kept/worktree" });
    const outcome = await runPostSession(ctx, deps);

    expect(outcome).toEqual({ action: "pr_failed", error: "gh auth failed" });
    expect(deps._tracker.cleanupCalled).toBe(true);
    expect(deps._tracker.destroyCalled).toBe(false);
    expect(deps._tracker.logs.some((l) => l.includes("gh auth failed"))).toBe(true);
    expect(deps._tracker.logs.some((l) => l.includes("/kept/worktree"))).toBe(true);
  });

  test("choice d → destroys worktree", async () => {
    const deps = makeDeps({ hasChanges: true, choice: "d" });
    const outcome = await runPostSession(makeCtx(), deps);

    expect(outcome).toEqual({ action: "discard" });
    expect(deps._tracker.destroyCalled).toBe(true);
    expect(deps._tracker.cleanupCalled).toBe(false);
    expect(deps._tracker.logs.some((l) => l.includes("discarded"))).toBe(true);
  });

  test("updatePR receives correct context when fromPrUrl is set", async () => {
    const fromPrUrl = "https://github.com/org/repo/pull/42";
    let receivedOpts: Record<string, unknown> = {};
    const deps = makeDeps({ hasChanges: true, choice: "p" });
    deps.updatePR = async (opts) => {
      receivedOpts = opts as unknown as Record<string, unknown>;
    };

    const ctx = makeCtx({
      repoPath: "/my/repo",
      worktreePath: "/my/worktree",
      branch: "feature/auth-fix",
      baseBranch: "main",
      prompt: "add tests",
      fromPrUrl,
    });

    await runPostSession(ctx, deps);

    expect(receivedOpts.repoPath).toBe("/my/repo");
    expect(receivedOpts.worktreePath).toBe("/my/worktree");
    expect(receivedOpts.finalBranch).toBe("feature/auth-fix");
    expect(receivedOpts.baseBranch).toBe("main");
    expect(receivedOpts.prompt).toBe("add tests");
    expect(receivedOpts.prUrl).toBe(fromPrUrl);
  });

  test("PR creation receives correct context", async () => {
    let receivedOpts: Record<string, unknown> = {};
    const deps = makeDeps({ hasChanges: true, choice: "p" });
    deps.createPR = async (opts) => {
      receivedOpts = opts;
      return { prUrl: "https://example.com/pull/1", finalBranch: "deer/test" };
    };

    const ctx = makeCtx({
      repoPath: "/my/repo",
      worktreePath: "/my/worktree",
      branch: "deer/task-42",
      baseBranch: "develop",
      prompt: "add search",
    });

    await runPostSession(ctx, deps);

    expect(receivedOpts.repoPath).toBe("/my/repo");
    expect(receivedOpts.worktreePath).toBe("/my/worktree");
    expect(receivedOpts.branch).toBe("deer/task-42");
    expect(receivedOpts.baseBranch).toBe("develop");
    expect(receivedOpts.prompt).toBe("add search");
  });
});

// ── fromPrUrl (--from) ───────────────────────────────────────────────

describe("runPostSession with fromPrUrl", () => {
  test("choice p → calls updatePR instead of createPR", async () => {
    const fromPrUrl = "https://github.com/org/repo/pull/42";
    const deps = makeDeps({ hasChanges: true, choice: "p" });

    const ctx = makeCtx({ fromPrUrl, branch: "feature/auth-fix" });
    const outcome = await runPostSession(ctx, deps);

    expect(outcome.action).toBe("pr_updated");
    expect(deps._tracker.updatePRCalled).toBe(true);
    expect(deps._tracker.createPRCalled).toBe(false);
  });

  test("choice p → destroys worktree on success", async () => {
    const fromPrUrl = "https://github.com/org/repo/pull/42";
    const deps = makeDeps({ hasChanges: true, choice: "p" });

    const ctx = makeCtx({ fromPrUrl, branch: "feature/auth-fix" });
    const outcome = await runPostSession(ctx, deps);

    expect(outcome.action).toBe("pr_updated");
    expect(deps._tracker.destroyCalled).toBe(true);
    expect(deps._tracker.cleanupCalled).toBe(false);
  });

  test("choice p → update failure keeps worktree", async () => {
    const fromPrUrl = "https://github.com/org/repo/pull/42";
    const deps = makeDeps({ hasChanges: true, choice: "p", updatePRError: "push rejected" });

    const ctx = makeCtx({ fromPrUrl, branch: "feature/auth-fix" });
    const outcome = await runPostSession(ctx, deps);

    expect(outcome.action).toBe("pr_failed");
    expect(deps._tracker.cleanupCalled).toBe(true);
    expect(deps._tracker.destroyCalled).toBe(false);
    expect(deps._tracker.logs.some((l) => l.includes("push rejected"))).toBe(true);
  });
});

// ── renderPromptMenu ─────────────────────────────────────────────────

describe("renderPromptMenu", () => {
  test("shows 'Create a pull request' without fromPrUrl", () => {
    const menu = renderPromptMenu();
    expect(menu).toContain("Create a pull request");
  });

  test("shows 'Update existing PR' with fromPrUrl", () => {
    const menu = renderPromptMenu("https://github.com/org/repo/pull/42");
    expect(menu).toContain("Update existing PR");
    expect(menu).toContain("https://github.com/org/repo/pull/42");
  });

  test("does not show 'Create a pull request' when fromPrUrl is set", () => {
    const menu = renderPromptMenu("https://github.com/org/repo/pull/42");
    expect(menu).not.toContain("Create a pull request");
  });
});
