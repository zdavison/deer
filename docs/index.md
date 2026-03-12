---
layout: default
title: Home
nav_order: 1
---

<div class="home-hero">
  <h1>deer</h1>
  <p class="tagline">Run multiple Claude Code agents safely in parallel — unattended.</p>
  <div class="badges">
    <a href="https://github.com/zdavison/deer/releases"><img src="https://img.shields.io/github/v/release/zdavison/deer" alt="Latest release"></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="Platform">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  </div>
</div>

`deer` is the simplest tool for running multiple unattended `claude` instances safely. Each agent gets its own git worktree and sandbox — isolated filesystem, filtered network, no credential leakage.

```sh
bunx @zdavison/deer install
```

---

## How it works

<div class="feature-grid">
  <div class="feature-card">
    <div class="feature-icon">Send a prompt</div>
    <h3>Type and submit</h3>
    <p>Type a task in the dashboard prompt bar and press Enter. deer creates a git worktree and launches an agent.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">Sandboxed</div>
    <h3>Isolated execution</h3>
    <p>Each agent runs in an SRT sandbox — write access limited to its worktree, network filtered by domain allowlist.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">Secure</div>
    <h3>Credential safety</h3>
    <p>Secrets never enter the sandbox. A host-side MITM proxy injects auth headers for approved domains only.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">Parallel</div>
    <h3>Multiple agents</h3>
    <p>Run as many agents as you like. Monitor all of them from the TUI dashboard and attach to any live session.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">PRs</div>
    <h3>GitHub integration</h3>
    <p>Press <code>p</code> when an agent is done. deer generates a branch, title, and description and opens the PR.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">Subscription</div>
    <h3>Uses your plan</h3>
    <p>Uses your Claude Code OAuth token automatically on macOS — no API key needed.</p>
  </div>
</div>

---

## Quick start

```sh
# Install
bunx @zdavison/deer install

# Run from inside any git repo
cd your-project
deer
```

Type a task prompt and press `Enter`. deer handles the rest.

---

## Keyboard shortcuts

**Input mode** (prompt bar focused):

| Key | Action |
|-----|--------|
| `Enter` | Submit prompt |
| `↑` / `↓` | Navigate prompt history |
| `Tab` | Switch to agent list |

**Agent list mode** (`Tab` to enter):

| Key | Action |
|-----|--------|
| `Enter` | Attach to agent's tmux session |
| `j` / `k` | Select next / previous agent |
| `/` | Fuzzy-search agents |
| `x` | Kill running agent |
| `r` | Retry agent |
| `p` | Create / open PR |
| `u` | Update existing PR |
| `s` | Open shell in worktree |
| `l` | Toggle log panel |
| `Backspace` | Delete agent entry |
| `q` | Quit |

---

## Authentication

deer checks for credentials in this order:

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. `~/.claude/agent-oauth-token` file
3. macOS Keychain (Claude Code's stored credentials — no extra setup on macOS)
4. `ANTHROPIC_API_KEY` environment variable

If you have Claude Code installed and logged in on macOS, deer will use your subscription automatically.

---

## Configuration

Configuration is layered — later sources override earlier ones:

1. Built-in defaults
2. `~/.config/deer/config.toml` — global
3. `deer.toml` in your repo root — repo-local
4. CLI flags

```toml
# deer.toml (repo-local, safe to commit)
base_branch = "master"
setup_command = "pnpm install"

[network]
allowlist_extra = ["npm.pkg.github.com"]
```

---

## Security model

<div class="callout">
<p><strong>deer runs each agent in an Anthropic SRT sandbox.</strong> The agent cannot access your host filesystem, cannot reach arbitrary network endpoints, and never sees your credentials.</p>
</div>

- **Filesystem** — agent writes only to its git worktree
- **Network** — domain allowlist, all other traffic blocked
- **Credentials** — injected by host-side proxy; never forwarded to the sandbox
- **Environment** — only explicitly listed vars are passed through
