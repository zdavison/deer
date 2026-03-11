#!/usr/bin/env bun

// Strip ANTHROPIC_API_KEY immediately — deer always prefers CLAUDE_CODE_OAUTH_TOKEN.
// The API key is only used as a fallback if no OAuth token is available.
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  delete process.env.ANTHROPIC_API_KEY;
}

import { render } from "ink";
import React from "react";
import { detectRepo } from "./git/worktree.ts";
import Dashboard from "./dashboard.tsx";
import DemoDashboard from "./demo-dashboard.tsx";
import { checkAndUpdate } from "./updater.ts";

async function main() {
  const isDemo = process.argv.includes("--demo");

  if (isDemo) {
    // Enter alternate screen buffer
    process.stdout.write("\x1b[?1049h");

    const instance = render(<DemoDashboard />, {
      kittyKeyboard: { flags: ["disambiguateEscapeCodes"] },
    });

    await instance.waitUntilExit();

    // Restore terminal
    process.stdout.write("\x1b[?1049l");
    return;
  }

  await checkAndUpdate();

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

  const instance = render(<Dashboard cwd={repoRoot} />, {
    kittyKeyboard: { flags: ["disambiguateEscapeCodes"] },
  });

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
