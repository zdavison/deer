#!/usr/bin/env bun
// kadai:name Setup Development Environment
// kadai:emoji 🔧
// kadai:description Install prerequisites for deer (srt, tmux, claude, gh)

import { $ } from "bun";

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

interface Tool {
  name: string;
  /** Restrict this tool to a specific platform. Omit for cross-platform tools. */
  os?: "darwin" | "linux";
  check: () => Promise<boolean>;
  install: () => Promise<void>;
  note?: string;
}

function log(msg: string) {
  console.log(msg);
}

function heading(msg: string) {
  console.log(`\n── ${msg} ${"─".repeat(Math.max(0, 60 - msg.length))}`);
}

async function commandExists(cmd: string): Promise<boolean> {
  const result = await $`which ${cmd}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function detectPackageManager(): Promise<"apt" | "dnf" | "pacman" | "brew" | null> {
  if (isMac) {
    return (await commandExists("brew")) ? "brew" : null;
  }
  if (await commandExists("apt")) return "apt";
  if (await commandExists("dnf")) return "dnf";
  if (await commandExists("pacman")) return "pacman";
  return null;
}

const tools: Tool[] = [
  {
    name: "sandbox-exec (required by srt on macOS)",
    os: "darwin",
    check: () => commandExists("sandbox-exec"),
    async install() {
      log("  sandbox-exec is built into macOS — it should already be available.");
      log("  If missing, ensure /usr/bin is in your PATH.");
    },
    note: "Built into macOS (used by srt for filesystem/network sandboxing)",
  },
  {
    name: "bwrap (required by srt on Linux)",
    os: "linux",
    check: () => commandExists("bwrap"),
    async install() {
      const pm = await detectPackageManager();
      switch (pm) {
        case "apt":
          await $`sudo apt update && sudo apt install -y bubblewrap`;
          break;
        case "dnf":
          await $`sudo dnf install -y bubblewrap`;
          break;
        case "pacman":
          await $`sudo pacman -S --noconfirm bubblewrap`;
          break;
        default:
          log("  Could not detect package manager. Install bubblewrap manually.");
      }
    },
    note: "Used by srt for mount-namespace sandboxing on Linux",
  },
  {
    name: "tmux",
    check: () => commandExists("tmux"),
    async install() {
      const pm = await detectPackageManager();
      switch (pm) {
        case "apt":
          await $`sudo apt update && sudo apt install -y tmux`;
          break;
        case "dnf":
          await $`sudo dnf install -y tmux`;
          break;
        case "pacman":
          await $`sudo pacman -S --noconfirm tmux`;
          break;
        case "brew":
          await $`brew install tmux`;
          break;
        default:
          log("  Could not detect package manager. Install tmux manually.");
      }
    },
  },
  {
    name: "gh (GitHub CLI)",
    check: () => commandExists("gh"),
    async install() {
      const pm = await detectPackageManager();
      switch (pm) {
        case "apt":
          await $`sudo mkdir -p /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && sudo apt update && sudo apt install -y gh`;
          break;
        case "dnf":
          await $`sudo dnf install -y gh`;
          break;
        case "pacman":
          await $`sudo pacman -S --noconfirm github-cli`;
          break;
        case "brew":
          await $`brew install gh`;
          break;
        default:
          log("  Could not detect package manager. Install gh from https://cli.github.com");
      }
    },
  },
  {
    name: "srt (@anthropic-ai/sandbox-runtime)",
    check: () => commandExists("srt"),
    async install() {
      if (await commandExists("npm")) {
        log("  Installing srt via npm...");
        await $`npm install -g @anthropic-ai/sandbox-runtime`;
      } else if (await commandExists("bun")) {
        log("  Installing srt via bun...");
        await $`bun add -g @anthropic-ai/sandbox-runtime`;
      } else {
        log("  Could not find npm or bun. Install @anthropic-ai/sandbox-runtime manually.");
      }
    },
    note: "Required by deer for sandboxing (macOS: seatbelt, Linux: bubblewrap)",
  },
  {
    name: "claude (Claude Code CLI)",
    check: () => commandExists("claude"),
    async install() {
      if (await commandExists("npm")) {
        log("  Installing Claude Code via npm...");
        await $`npm install -g @anthropic-ai/claude-code`;
      } else if (await commandExists("bun")) {
        log("  Installing Claude Code via bun...");
        await $`bun add -g @anthropic-ai/claude-code`;
      } else {
        log("  Could not find npm or bun. Install @anthropic-ai/claude-code manually.");
      }
    },
  },
  {
    name: "bun",
    check: () => commandExists("bun"),
    async install() {
      log("  Installing bun...");
      await $`curl -fsSL https://bun.sh/install | bash`;
    },
  },
];

// ── Post-install checks ──────────────────────────────────────────────

async function checkGhAuth(): Promise<boolean> {
  const result = await $`gh auth token`.quiet().nothrow();
  return result.exitCode === 0;
}

async function checkCredentials(): Promise<"subscription" | "api-token" | "none"> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "subscription";
  const home = process.env.HOME ?? "/root";
  const tokenFile = `${home}/.claude/agent-oauth-token`;
  try {
    const f = Bun.file(tokenFile);
    if (await f.exists()) return "subscription";
  } catch { /* ignore */ }
  if (process.env.ANTHROPIC_API_KEY) return "api-token";
  return "none";
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("🦌 deer — Development Environment Setup\n");
  console.log(`Platform: ${process.platform} (${process.arch})`);

  const pm = await detectPackageManager();
  console.log(`Package manager: ${pm ?? "none detected"}`);

  // ── Install tools ──────────────────────────────────────────────────

  const results: Array<{ name: string; status: "installed" | "already" | "skipped" | "failed" }> = [];

  const currentOS = process.platform;
  for (const tool of tools) {
    if (tool.os && tool.os !== currentOS) continue;

    heading(tool.name);

    const exists = await tool.check();
    if (exists) {
      log(`  ✓ Already installed`);
      results.push({ name: tool.name, status: "already" });
      continue;
    }

    log(`  ✗ Not found — installing...`);
    if (tool.note) log(`  Note: ${tool.note}`);

    try {
      await tool.install();
      const nowExists = await tool.check();
      if (nowExists) {
        log(`  ✓ Installed successfully`);
        results.push({ name: tool.name, status: "installed" });
      } else {
        log(`  ⚠ Installation ran but tool not found in PATH`);
        results.push({ name: tool.name, status: "failed" });
      }
    } catch (err) {
      log(`  ✗ Installation failed: ${err}`);
      results.push({ name: tool.name, status: "failed" });
    }
  }

  // ── Post-install checks ────────────────────────────────────────────

  heading("Post-install checks");

  if (await commandExists("gh")) {
    const authed = await checkGhAuth();
    if (authed) {
      log("  ✓ gh is authenticated");
    } else {
      log("  ⚠ gh is not authenticated — run 'gh auth login'");
    }
  }

  const cred = await checkCredentials();
  switch (cred) {
    case "subscription":
      log("  ✓ Claude credentials found (OAuth token)");
      break;
    case "api-token":
      log("  ✓ Claude credentials found (API key)");
      break;
    case "none":
      log("  ⚠ No Claude credentials — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
      break;
  }

  // ── Summary ────────────────────────────────────────────────────────

  heading("Summary");

  for (const r of results) {
    const icon =
      r.status === "already" ? "✓" :
      r.status === "installed" ? "✓" :
      r.status === "skipped" ? "–" :
      "✗";
    log(`  ${icon} ${r.name}: ${r.status}`);
  }

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    console.log(`\n⚠ ${failed.length} tool(s) failed to install. Review the output above.`);
    process.exit(1);
  } else {
    console.log("\n✓ All prerequisites are ready.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
