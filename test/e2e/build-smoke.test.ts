/**
 * Build smoke E2E tests.
 *
 * Verify the compiled binary works correctly, preventing broken releases.
 * These tests only run when DEER_BINARY_PATH is set (pointing to the compiled binary).
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";

import { startDeerSession, createTestRepo } from "./helpers";

setDefaultTimeout(60_000);

const e2e = process.env.DEER_E2E ? describe : describe.skip;

const BINARY_PATH = process.env.DEER_BINARY_PATH;
const binaryTest = BINARY_PATH ? test : test.skip;

const CLI_PATH = join(import.meta.dir, "../../src/cli.tsx");

e2e("build smoke", () => {
  // These source-based tests always run (when DEER_E2E is set)
  test("source exits with error when not in a git repo", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_PATH], {
      cwd: "/tmp",
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).not.toBe(0);
    expect((stdout + stderr).toLowerCase()).toMatch(/error|not a git/i);
  });

  test("source produces no startup crash in a git repo", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      const deer = await startDeerSession(repoPath);
      try {
        await deer.waitForPane("deer");
        // If we got here, the TUI started without crashing
      } finally {
        await deer.stop();
      }
    } finally {
      await cleanup();
    }
  });

  // These binary tests only run when DEER_BINARY_PATH is set
  binaryTest("binary exits with error when not in a git repo", async () => {
    const proc = Bun.spawn([BINARY_PATH!], {
      cwd: "/tmp",
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).not.toBe(0);
    expect((stdout + stderr).toLowerCase()).toMatch(/error|not a git/i);
  });

  binaryTest("binary produces no startup crash in a git repo", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      const deer = await startDeerSession(repoPath, {}, { command: [BINARY_PATH!] });
      try {
        await deer.waitForPane("deer");
      } finally {
        await deer.stop();
      }
    } finally {
      await cleanup();
    }
  });
});
