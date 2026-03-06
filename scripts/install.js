#!/usr/bin/env node

import { writeFile, chmod, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { homedir, platform, arch } from "os";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const REPO = "mm-zacharydavison/deer";
const VERSION = pkg.version;

const PLATFORM_MAP = {
  linux: "linux",
  darwin: "darwin",
};

const ARCH_MAP = {
  x64: "x64",
  arm64: "arm64",
};

async function install() {
  const os = PLATFORM_MAP[platform()];
  const cpuArch = ARCH_MAP[arch()];

  if (!os) {
    throw new Error(
      `Unsupported platform: ${platform()}. Supported: linux, darwin.`
    );
  }
  if (!cpuArch) {
    throw new Error(
      `Unsupported architecture: ${arch()}. Supported: x64, arm64.`
    );
  }

  const binaryName = `deer-${os}-${cpuArch}`;
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${binaryName}`;
  const installDir = join(homedir(), ".local", "bin");
  const installPath = join(installDir, "deer");

  console.log(`Downloading deer v${VERSION} for ${os}/${cpuArch}...`);
  console.log(`From: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}\nURL: ${url}`
    );
  }

  await mkdir(installDir, { recursive: true });

  const buffer = await response.arrayBuffer();
  await writeFile(installPath, Buffer.from(buffer));
  await chmod(installPath, 0o755);

  console.log(`\nInstalled to: ${installPath}`);

  // Warn if installDir is not in PATH
  const pathDirs = (process.env.PATH ?? "").split(":");
  if (!pathDirs.includes(installDir)) {
    console.log(
      `\nNote: ${installDir} is not in your PATH. Add this to your shell profile:`
    );
    console.log(`  export PATH="$HOME/.local/bin:$PATH"`);
  }
}

const args = process.argv.slice(2);

if (args[0] === "install") {
  install().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  console.log("Usage: bunx @zdavison/deer install");
  console.log("");
  console.log("Commands:");
  console.log("  install    Download and install the deer binary");
}
