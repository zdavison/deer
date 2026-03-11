#!/usr/bin/env bun
// kadai:name Screenshot Demo
// kadai:emoji 📸
// kadai:description Launch deer in demo mode with mock tasks for README screenshots

import { $ } from "bun";
import { join } from "node:path";

const TERM_COLS = 120;
const TERM_ROWS = 32;

async function main() {
  const repoRoot = import.meta.dir.replace("/.kadai/actions", "");
  const cliPath = join(repoRoot, "src", "cli.tsx");

  console.log("🦌 Launching deer in demo mode...");
  console.log(`   Terminal: ${TERM_COLS}×${TERM_ROWS}`);
  console.log(`   Press q to quit\n`);
  console.log("Tip: resize your terminal to exactly 120×32 for the cleanest screenshot.");
  console.log("     On macOS, use: printf '\\e[8;32;120t' to resize iTerm2/Terminal.\n");

  // Resize terminal via ANSI escape (works in most terminal emulators)
  process.stdout.write(`\x1b[8;${TERM_ROWS};${TERM_COLS}t`);

  // Small pause to let the terminal resize before rendering
  await Bun.sleep(300);

  await $`bun run ${cliPath} --demo`.env({
    ...process.env,
    COLUMNS: String(TERM_COLS),
    LINES: String(TERM_ROWS),
    FORCE_COLOR: "1",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
