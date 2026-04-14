---
title: Overview
outline: deep
---

# Overview

## Monorepo structure

deer is a Bun workspace monorepo with three packages:

```
deer/
├── src/                    # deer TUI (Ink + React)
├── packages/
│   ├── shared/             # @deer/shared — utilities used by both
│   │   └── src/            # credentials, git, i18n, constants
│   └── deerbox/            # deerbox CLI — core sandbox orchestration
│       └── src/            # session, config, sandbox, ecosystems, git
├── docs/                   # This documentation (Jekyll)
└── package.json            # Bun workspaces
```

The root `package.json` declares `"workspaces": ["packages/*"]`, which lets Bun resolve cross-package imports at development time without publishing anything.

## Technology stack

| Component | Technology |
|-----------|-----------|
| Runtime | Bun (uses `Bun.$`, `Bun.file`, `Bun.spawn`) |
| Language | TypeScript (ESM) |
| TUI | Ink + React (terminal rendering) |
| Sandbox | Anthropic SRT (`@anthropic-ai/sandbox-runtime`) |
| Config | TOML via `@iarna/toml` |
| Database | SQLite via `bun:sqlite` |
| Terminal | tmux for agent session management |
| Git | git worktrees for isolation |
| GitHub | `gh` CLI for PR creation |

## Package responsibilities

### @deer/shared

Shared utilities used by both deerbox and the TUI. This is a **private** package -- it is never published to any registry.

- Credential resolution (OAuth tokens, API keys, keychain)
- Git repo detection (walk up from a directory to find `.git`)
- PR creation and update (`createPullRequest`, `updatePullRequest`, `pushBranchUpdates`)
- Language detection and i18n helpers
- Shared constants (`DEFAULT_MODEL`, `MAX_DIFF_FOR_PR_METADATA`, etc.)

### deerbox

Core sandbox orchestration library. Published as a standalone CLI.

- Session preparation (worktree creation, ecosystem detection, gitconfig, auth proxy, SRT command assembly)
- Sandbox runtime resolution and launch
- Ecosystem detection (npm, pip, cargo, etc.) and dependency installation strategies
- Git worktree create/remove/cleanup
- Host-side MITM auth proxy for credential injection
- Config loading and merging (global + repo-local + CLI)
- Preflight checks (SRT, bwrap, tmux, claude, gh)
- Pruning dangling worktrees and task directories

### deer (root)

TUI dashboard. Published as a standalone CLI.

- Ink + React terminal dashboard for monitoring agents
- Agent state management backed by SQLite
- tmux session lifecycle (create, attach, capture, destroy)
- Keyboard input handling and contextual shortcuts
- Context system (`@branch`, `@file` pickers for prompt enrichment)
- Prompt input with history, bracketed paste, and multi-line editing
- Cross-instance state sync via SQLite polling
- Live GitHub PR state polling
- Self-update checks
