---
title: Installation
outline: deep
---

# Installation

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash
```

This installs both `deer` (the TUI dashboard) and `deerbox` (the standalone CLI).

## Supported platforms

| OS    | Architecture |
|-------|-------------|
| macOS | x64, arm64  |
| Linux | x64, arm64  |

## Prerequisites

deer requires the following tools to be installed and available on your `PATH`:

| Tool | Why | Install |
|------|-----|---------|
| **tmux** | Each agent runs in a tmux session | `brew install tmux` or `apt install tmux` |
| **gh** (GitHub CLI) | PR creation and GitHub API access | [cli.github.com](https://cli.github.com/) |
| **Claude Code CLI** | The agent runtime | [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code) |

Make sure `gh` is authenticated (`gh auth login`) and Claude Code is logged in (`claude` should launch without prompting for credentials).

## Verify the installation

```sh
deer --version
deerbox --version
```

Both commands should print a version number.

## Building from source

If you prefer to build from source, you need [Bun](https://bun.sh/) installed:

```sh
git clone https://github.com/zdavison/deer.git
cd deer
bun install
bun run build
```

The compiled binaries are written to `dist/`.
