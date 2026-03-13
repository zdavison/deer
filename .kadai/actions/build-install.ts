#!/usr/bin/env bun
// kadai:name Build & Install
// kadai:emoji 🔨
// kadai:description Build deer binary and install it to ~/.local/bin/deer

import { $ } from "bun";
import { join } from "node:path";
import { homedir } from "node:os";

const repoRoot = import.meta.dir.replace("/.kadai/actions", "");
const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const binaryName = `deer-${os}-${arch}`;
const builtPath = join(repoRoot, "dist", binaryName);
const installDir = join(homedir(), ".local", "bin");
const installPath = join(installDir, "deer");

console.log(`Building deer for ${os}/${arch}...`);
await $`bun run build`.cwd(repoRoot);

console.log(`\nInstalling to ${installPath}...`);
await $`mkdir -p ${installDir}`.quiet();
await $`cp ${builtPath} ${installPath}`.quiet();
await $`chmod +x ${installPath}`.quiet();

const stat = Bun.file(installPath);
const sizeMB = ((await stat.size) / 1024 / 1024).toFixed(1);
console.log(`Installed to ${installPath} (${sizeMB} MB)`);

// Warn if not in PATH
const pathDirs = (process.env.PATH ?? "").split(":");
if (!pathDirs.includes(installDir)) {
  console.log(
    `\nNote: ${installDir} is not in your PATH. Add this to your shell profile:`,
  );
  console.log(`  export PATH="$HOME/.local/bin:$PATH"`);
}
