#!/usr/bin/env bun
// kadai:name Simulate install.sh
// kadai:emoji 📦
// kadai:description Simulate 'curl | bash' install against locally-built binaries

import { $ } from "bun";
import { join } from "node:path";
import { tmpdir, platform, arch } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

const repoRoot = import.meta.dir.replace("/.kadai/actions", "");
const os = platform() === "darwin" ? "darwin" : "linux";
const cpuArch = arch() === "arm64" ? "arm64" : "x64";

const tempDir = await mkdtemp(join(tmpdir(), "deer-install-test-"));

async function cleanup() {
  console.log(`\nCleaning up ${tempDir}...`);
  await rm(tempDir, { recursive: true, force: true });
}

try {
  // Step 1: Build binaries
  console.log("=== Step 1: Building binaries ===");
  await $`bun run build`.cwd(repoRoot);
  console.log();

  // Step 2: Start a local HTTP server to serve built binaries (mimics GitHub releases)
  // and the GitHub API latest release endpoint
  console.log("=== Step 2: Starting local release server ===");
  const distDir = join(repoRoot, "dist");
  const pkg = await Bun.file(join(repoRoot, "package.json")).json();
  const version = pkg.version;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // Mock GitHub API: /repos/.../releases/latest
      if (url.pathname.includes("/repos/") && url.pathname.endsWith("/releases/latest")) {
        const assets = ["deer", "deerbox"].flatMap((bin) =>
          ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].map((suffix) => ({
            name: `${bin}-${suffix}`,
            browser_download_url: `http://localhost:${server.port}/download/${bin}-${suffix}`,
          }))
        );
        console.log(`  Serving: releases/latest (v${version})`);
        return Response.json({ tag_name: `v${version}`, assets });
      }

      // Serve binary downloads
      const dlMatch = url.pathname.match(/\/download\/(.+)/);
      if (dlMatch) {
        const file = Bun.file(join(distDir, dlMatch[1]));
        if (await file.exists()) {
          console.log(`  Serving: ${dlMatch[1]}`);
          return new Response(file);
        }
      }

      // Serve binaries via GitHub-style release URL pattern
      const releaseMatch = url.pathname.match(
        /\/zdavison\/deer\/releases\/download\/v[^/]+\/(.+)/,
      );
      if (releaseMatch) {
        const file = Bun.file(join(distDir, releaseMatch[1]));
        if (await file.exists()) {
          console.log(`  Serving: ${releaseMatch[1]}`);
          return new Response(file);
        }
      }

      console.log(`  404: ${url.pathname}`);
      return new Response("Not found", { status: 404 });
    },
  });
  const baseUrl = `http://localhost:${server.port}`;
  console.log(`Serving binaries at ${baseUrl}\n`);

  // Step 3: Run install.sh with patched URLs pointing to our local server
  console.log("=== Step 3: Running install.sh (against local server) ===");

  // Read install.sh and patch GitHub URLs to point to local server
  const installScript = await Bun.file(join(repoRoot, "install.sh")).text();
  const patchedScript = installScript
    .replace(
      "https://api.github.com/repos",
      `${baseUrl}/repos`,
    )
    .replace(
      "https://github.com/${REPO}/releases/download",
      `${baseUrl}/${`zdavison/deer`}/releases/download`,
    );

  const patchedPath = join(tempDir, "install.sh");
  await Bun.write(patchedPath, patchedScript);
  await $`chmod +x ${patchedPath}`;

  // Run with HOME pointing to temp so we don't clobber real install
  await $`bash ${patchedPath}`.env({
    ...process.env,
    HOME: tempDir,
  });

  server.stop();

  // Step 4: Verify
  console.log("\n=== Step 4: Verification ===");
  const expectedBinDir = join(tempDir, ".local", "bin");
  const deerBin = Bun.file(join(expectedBinDir, "deer"));
  const deerboxBin = Bun.file(join(expectedBinDir, "deerbox"));

  const deerExists = await deerBin.exists();
  const deerboxExists = await deerboxBin.exists();

  if (deerExists && deerboxExists) {
    const deerSize = (deerBin.size / 1024 / 1024).toFixed(1);
    const deerboxSize = (deerboxBin.size / 1024 / 1024).toFixed(1);
    console.log(`  deer:    ${expectedBinDir}/deer (${deerSize} MB)`);
    console.log(`  deerbox: ${expectedBinDir}/deerbox (${deerboxSize} MB)`);

    // Verify they're executable
    const deerVersion =
      await $`${join(expectedBinDir, "deer")} --version`.text();
    console.log(`  deer --version: ${deerVersion.trim()}`);

    console.log("\n✅ Install simulation passed!");
  } else {
    console.error(
      `\n❌ Install simulation failed! Missing binaries: ${[
        !deerExists && "deer",
        !deerboxExists && "deerbox",
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
    process.exit(1);
  }
} catch (err) {
  console.error(`\n❌ Error: ${err}`);
  process.exit(1);
} finally {
  await cleanup();
}
