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
import { detectRepo } from "./git/detect";
import { setLang, detectLang } from "./i18n";
import { VERSION } from "./constants";
import Dashboard from "./dashboard.tsx";
import DemoDashboard from "./demo-dashboard.tsx";
import { checkAndUpdate } from "./updater.ts";
import { prune, isTmuxSessionAlive } from "deerbox";
import { getAllTasks, deleteTaskRow } from "./db.ts";

setLang(detectLang());

// ── Subcommand: prune ─────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["failed", "cancelled", "interrupted", "pr_failed"]);

async function cmdPrune(args: string[]) {
  const force = args.includes("--force");

  const tasks = getAllTasks();

  let dbRowsRemoved = 0;
  for (const task of tasks) {
    const isDangling =
      force ||
      TERMINAL_STATUSES.has(task.status) ||
      !(await isTmuxSessionAlive(`deer-${task.task_id}`));

    if (!isDangling) continue;

    deleteTaskRow(task.task_id);
    dbRowsRemoved++;
  }

  const result = await prune({ force, log: console.log });

  if (force) {
    // Also wipe prompt history when doing a full force prune
    const promptHistoryPath = `${process.env.HOME}/.local/share/deer/prompt-history.json`;
    await Bun.$`rm -f ${promptHistoryPath}`.quiet().nothrow();
  }

  console.log("\nDone:");
  if (dbRowsRemoved > 0) {
    console.log(`  DB rows removed:          ${dbRowsRemoved}`);
  }
  if (force) {
    console.log(`  sandbox processes killed: ${result.processesKilled}`);
    console.log(`  tmux sessions killed:     ${result.tmuxKilled}`);
  }
  console.log(`  worktrees removed:        ${result.worktreesRemoved}`);
  console.log(`  task dirs cleaned:        ${result.tasksRemoved}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(`deer ${VERSION}`);
    return;
  }

  if (process.argv[2] === "prune") {
    await cmdPrune(process.argv.slice(3));
    return;
  }

  const isDemo = process.argv.includes("--demo");

  if (isDemo) {
    // Enter alternate screen buffer
    process.stdout.write("\x1b[?1049h");

    const instance = render(<DemoDashboard />);

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

  const instance = render(<Dashboard cwd={repoRoot} />);

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
