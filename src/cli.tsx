#!/usr/bin/env bun

// Startup crash logger — catches errors that Ink swallows via process.exit(1)
{
  const fs = require("node:fs");
  const path = require("node:path");
  const logPath = path.join(process.env.HOME ?? "/tmp", ".local", "share", "deer", "crash.log");
  const log = (label: string, err: unknown) => {
    try {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${label}: ${msg}\n`);
    } catch { /* ignore */ }
  };
  process.on("uncaughtException", (err) => log("uncaughtException", err));
  process.on("unhandledRejection", (err) => log("unhandledRejection", err));
  const origExit = process.exit.bind(process);
  (process as any).exit = (code?: number) => {
    if (code && code !== 0) {
      log("process.exit", `code=${code}\n${new Error().stack}`);
    }
    origExit(code);
  };
}

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
import { setLang, detectLang } from "./i18n.ts";

setLang(detectLang());

async function main() {
  const isDemo = process.argv.includes("--demo");

  if (isDemo) {
    // Enter alternate screen buffer
    process.stdout.write("\x1b[?1049h");

    const instance = render(<DemoDashboard />, {
      kittyKeyboard: { flags: ["disambiguateEscapeCodes", "reportEventTypes"] },
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
    kittyKeyboard: { flags: ["disambiguateEscapeCodes", "reportEventTypes"] },
  });

  await instance.waitUntilExit();

  // Restore terminal
  process.stdout.write("\x1b[?1049l");
}

main().catch((err) => {
  // Restore terminal on unexpected crash
  process.stdout.write("\x1b[?1049l");
  console.error(err);
  // Log to file so errors aren't swallowed by the alternate screen buffer
  const fs = require("node:fs");
  const path = require("node:path");
  const logPath = path.join(process.env.HOME ?? "/tmp", ".local", "share", "deer", "crash.log");
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${err?.stack ?? err}\n`);
  } catch { /* ignore */ }
  process.exit(1);
});
