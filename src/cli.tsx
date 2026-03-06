#!/usr/bin/env bun

// Detect credential mode before stripping, then isolate the active credential.
// Only one type should reach any subprocess: API key XOR OAuth token.
const _hasApiKey = !!process.env.ANTHROPIC_API_KEY;
if (_hasApiKey) {
  // API key mode: prevent OAuth credentials from reaching subprocesses.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
} else {
  // OAuth mode (or none): prevent API key from reaching subprocesses.
  delete process.env.ANTHROPIC_API_KEY;
}

import { render } from "ink";
import React from "react";
import { detectRepo } from "./git/worktree.ts";
import Dashboard from "./dashboard.tsx";
import type { CredentialMode } from "./credentials.ts";

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

  const initialCredentialMode: CredentialMode = _hasApiKey ? "api-key" : "none";

  const instance = render(<Dashboard cwd={repoRoot} initialCredentialMode={initialCredentialMode} />);

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
