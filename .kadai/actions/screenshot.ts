#!/usr/bin/env bun
// kadai:name Screenshot Demo
// kadai:emoji 📸
// kadai:description Launch deer in demo mode with mock tasks for README screenshots

import { $ } from "bun";
import { join } from "node:path";

async function main() {
  const repoRoot = import.meta.dir.replace("/.kadai/actions", "");
  const cliPath = join(repoRoot, "src", "cli.tsx");

  console.log("🦌 Launching deer in demo mode...");
  console.log(`   Press q to quit\n`);

  await $`bun run ${cliPath} --demo`.env({
    ...process.env,
    FORCE_COLOR: "1",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
