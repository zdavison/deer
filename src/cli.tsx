#!/usr/bin/env bun

// Strip ANTHROPIC_API_KEY immediately so it never leaks to any subprocess.
// Deer must use CLAUDE_CODE_OAUTH_TOKEN for all Claude API access.
delete process.env.ANTHROPIC_API_KEY;

if (process.argv[2] === "install") {
  const { installDeer } = await import("./install.ts");
  await installDeer();
  process.exit(0);
}

import { render } from "ink";
import React from "react";
import { detectRepo } from "./git/worktree.ts";
import Dashboard from "./dashboard.tsx";

async function main() {
  const startDir = process.cwd();

  let repoRoot: string;
  try {
    const repo = await detectRepo(startDir);
    repoRoot = repo.repoPath;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Enter alternate screen buffer
  process.stdout.write("\x1b[?1049h");

  const instance = render(<Dashboard cwd={repoRoot} />);

  await instance.waitUntilExit();

  // Restore terminal
  process.stdout.write("\x1b[?1049l");
}

main().catch((err) => {
  // Restore terminal on unexpected crash
  process.stdout.write("\x1b[?1049l");
  console.error(err);
  process.exit(1);
});
