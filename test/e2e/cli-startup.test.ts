/**
 * CLI startup E2E tests.
 *
 * Verify that deer launches, renders the TUI, and exits cleanly.
 * Uses tmux to drive the TUI as a real terminal process.
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";

import { startDeerSession, createTestRepo } from "./helpers";

setDefaultTimeout(60_000);

const e2e = process.env.DEER_E2E ? describe : describe.skip;

const CLI_PATH = join(import.meta.dir, "../../src/cli.tsx");

e2e("CLI startup", () => {
  test("renders the dashboard header in a git repo", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      const deer = await startDeerSession(repoPath);
      try {
        // "🦌 deer" is the header_title i18n string rendered in the TUI
        await deer.waitForPane("deer");
      } finally {
        await deer.stop();
      }
    } finally {
      await cleanup();
    }
  });

  test("exits with error when not in a git repo", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_PATH], {
      cwd: "/tmp",
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const output = stdout + stderr;

    expect(exitCode).not.toBe(0);
    expect(output.toLowerCase()).toMatch(/error|not a git/i);
  });

  test("preflight error shown in TUI when claude is missing", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      // Build a PATH that excludes any claude binary
      const pathWithoutClaude = "/usr/bin:/bin";

      const deer = await startDeerSession(repoPath, { PATH: pathWithoutClaude });
      try {
        // "claude CLI not available" is the preflight_claude_missing i18n string
        await deer.waitForPane("claude CLI not available");
      } finally {
        await deer.stop();
      }
    } finally {
      await cleanup();
    }
  });

  test("preflight shows subscription credential type", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      const deer = await startDeerSession(repoPath, {
        CLAUDE_CODE_OAUTH_TOKEN: "fake-token-for-testing",
      });
      try {
        // "subscription" is the cred_subscription i18n string shown in the shortcuts bar
        await deer.waitForPane("subscription");
      } finally {
        await deer.stop();
      }
    } finally {
      await cleanup();
    }
  });
});
