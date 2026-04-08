# deer

Unattended coding agent — runs Claude Code in sandboxed tmux sessions against git worktrees, with a TUI dashboard.

## Monorepo Structure

Bun workspace monorepo with three packages:

- **`packages/shared/`** — Shared utilities used by both deerbox and the TUI (private, never published)
- **`packages/deerbox/`** — Core sandbox orchestration library (no TUI dependencies)
- **Root (`src/`)** — Ink/React TUI dashboard

```
deer/                          # workspace root
  package.json                 # "workspaces": ["packages/*"]
  src/                         # deer TUI source (imports from "@deer/shared")
  packages/
    shared/
      src/                     # shared utilities: constants, i18n, credentials, git/detect, git/finalize
      package.json             # name: "@deer/shared", private: true
      tsconfig.json
    deerbox/
      src/                     # core modules (agent, sandbox, config, etc.)
      package.json
      tsconfig.json
```

## Stack

- **Runtime**: Bun (required — uses `Bun.$`, `Bun.file`, `Bun.spawn`, etc.)
- **Language**: TypeScript (ESM)
- **UI**: Ink + React (terminal TUI)
- **Sandbox**: Anthropic SRT (`@anthropic-ai/sandbox-runtime`) — bwrap on Linux, seatbelt on macOS
- **Config**: TOML via `@iarna/toml`

## Commands

```sh
bun test          # run all tests
bun run dev       # run CLI from source (must be inside a git repo)
bun run build     # compile Linux x64 binary to dist/
```

## Architecture

Each agent task:
1. deer TUI invokes deerbox as a subprocess (via `src/deerbox.ts`) — deerbox outputs JSON to stdout
2. deerbox (`session.ts`) prepares a sandboxed session: worktree → ecosystem detection → gitconfig → auth proxy → SRT command
3. deer TUI launches the prepared command in a tmux session (`deer-<taskId>`) via `src/sandbox/index.ts`
4. Finalizes by creating a GitHub PR and cleaning up

### @deer/shared (shared utilities)

Private package — never published. Both deerbox and the TUI depend on it.

| File                                         | Purpose                                                        |
|----------------------------------------------|----------------------------------------------------------------|
| `packages/shared/src/index.ts`               | Barrel export for all shared APIs                              |
| `packages/shared/src/constants.ts`           | Shared constants (HOME, DEFAULT_MODEL, BYPASS_DIALOG_*, MAX_DIFF_FOR_PR_METADATA, PR_METADATA_MODEL) |
| `packages/shared/src/i18n.ts`                | Language detection, setLang/getLang/getPRLanguage/detectLang   |
| `packages/shared/src/credentials.ts`         | resolveCredentials() — OAuth/API key resolution from env/files/keychain |
| `packages/shared/src/git/detect.ts`          | detectRepo() — git repo detection by walking up from a directory |
| `packages/shared/src/git/finalize.ts`        | PR creation: createPullRequest, updatePullRequest, pushBranchUpdates, hasChanges |

### deerbox (core library)

deer treats deerbox as a black box — all interaction happens through CLI subcommands (`packages/deerbox/src/cli.ts`) that output JSON to stdout.

| File                                         | Purpose                                                        |
|----------------------------------------------|----------------------------------------------------------------|
| `packages/deerbox/src/index.ts`              | Barrel export for all public APIs                              |
| `packages/deerbox/src/cli.ts`               | CLI entry point — subcommands (incl. `prune`, `--from` flag) output JSON to stdout |
| `packages/deerbox/src/session.ts`           | Main entrypoint: worktree → ecosystem → gitconfig → auth proxy → SRT command; supports `fromBranch` for `--from` |
| `packages/deerbox/src/post-session.ts`      | Post-session interactive menu: create PR, update PR, keep worktree, open shell, discard |
| `packages/deerbox/src/prune.ts`             | `prune()` — removes dangling task dirs/worktrees; force mode kills all deer tmux sessions and processes |
| `packages/deerbox/src/proxy.ts`             | Credential resolution for the MITM auth proxy                  |
| `packages/deerbox/src/config.ts`            | Config loading/merging (global + repo-local + CLI)             |
| `packages/deerbox/src/constants.ts`         | VERSION + re-exports shared constants from @deer/shared        |
| `packages/deerbox/src/preflight.ts`         | Preflight checks (srt/bwrap/tmux/claude/gh); re-exports resolveCredentials from @deer/shared |
| `packages/deerbox/src/task.ts`              | Task ID generation, data directory                             |
| `packages/deerbox/src/ecosystems.ts`        | Ecosystem-aware dependency strategies                          |
| `packages/deerbox/src/i18n.ts`              | Re-exports i18n from @deer/shared                              |
| `packages/deerbox/src/sandbox/index.ts`     | Sandbox launch orchestration                                   |
| `packages/deerbox/src/sandbox/runtime.ts`   | `SandboxRuntime` interface                                     |
| `packages/deerbox/src/sandbox/resolve.ts`   | `resolveRuntime()` — maps config string to `SandboxRuntime`   |
| `packages/deerbox/src/sandbox/srt.ts`       | SRT runtime implementation                                     |
| `packages/deerbox/src/sandbox/auth-proxy.ts` | Host-side MITM proxy for credential injection                 |
| `packages/deerbox/src/git/worktree.ts`      | Git worktree create/remove/cleanup; `checkoutWorktree()` for `--from`; re-exports detectRepo from @deer/shared |

### deer (TUI dashboard)

| File                                    | Purpose                                                      |
|-----------------------------------------|--------------------------------------------------------------|
| `src/cli.tsx`                           | Entry point — detects repo, renders dashboard                |
| `src/deerbox.ts`                        | Subprocess wrapper for invoking deerbox CLI                  |
| `src/types.ts`                          | Shared types matching the JSON contract with deerbox CLI     |
| `src/dashboard.tsx`                     | Ink TUI dashboard                                            |
| `src/demo-dashboard.tsx`                | Demo mode dashboard using mock agents                        |
| `src/agent-state.ts`                   | `AgentState` type, `agentFromDbRow()` constructor            |
| `src/db.ts`                             | SQLite database module — single source of truth for state    |
| `src/state-machine.ts`                 | Per-task state machine: statuses, events, actions, keybindings |
| `src/constants.ts`                      | TUI constants (re-exports core constants from deerbox)       |
| `src/i18n.ts`                           | Locale detection and UI string translations (TUI-side)       |
| `src/preflight.ts`                      | Repo detection (`RepoInfo`, `repoPath`, `defaultBranch`)     |
| `src/task.ts`                           | Prompt input history (load/save)                             |
| `src/github.ts`                         | GitHub token retrieval, PR URL parsing, PR state queries     |
| `src/git/detect.ts`                     | Git repo detection helpers                                   |
| `src/git/finalize.ts`                  | PR creation and worktree cleanup                             |
| `src/git/worktree.ts`                  | Worktree helpers (TUI-side)                                  |
| `src/sandbox/index.ts`                 | Tmux session management: launch, lifecycle, pane capture     |
| `src/dashboard-utils.ts`               | Shared TUI helpers: formatting, ANSI stripping               |
| `src/fuzzy.ts`                          | Fuzzy search for agent list filtering                        |
| `src/pane-idle.ts`                      | Tmux pane idle detection heuristics                          |
| `src/updater.ts`                        | Self-update check logic                                      |
| `src/mock-agents.ts`                   | Static mock agent data for demo mode                         |
| `src/context/types.ts`                 | Context system types (`ContextChip`, `ContextSource`)        |
| `src/context/resolve.ts`               | Translates context chips into agent run option overrides     |
| `src/context/sources/index.ts`         | Registry of all available context sources for the @ picker   |
| `src/context/sources/branch.ts`        | Branch context source (fuzzy search over git branches)       |
| `src/hooks/useAgentSync.ts`            | Cross-instance state sync via SQLite polling                 |
| `src/hooks/useAgentActions.ts`         | Action dispatch for TUI agent cards                          |
| `src/hooks/useKeyboardInput.ts`        | Global keyboard input handling for the dashboard             |
| `src/hooks/usePromptHistory.ts`        | Prompt input history load/save/navigation                    |
| `src/hooks/useLivePRState.ts`          | Live GitHub PR state polling                                 |
| `src/components/ContextChipBar.tsx`    | Displays selected context chips in the prompt area           |
| `src/components/ContextPicker.tsx`     | @ context picker UI with unified fuzzy search                |
| `src/components/LogDetailPanel.tsx`    | Expanded log detail panel component                          |
| `src/components/PromptInput.tsx`       | Multi-line prompt input with bracketed paste support         |
| `src/components/ShortcutsBar.tsx`      | Contextual keyboard shortcuts bar                            |

### Data layout

```
~/.local/share/deer/
  deer.db                    # SQLite database — single source of truth for all task state
  tasks/<repoSlug>/<taskId>/
    worktree/                # git worktree (only writable path in sandbox)
    srt-settings.json        # SRT sandbox config
    gitconfig                # minimal gitconfig for sandbox
    claude-config/           # per-task Claude config (CLAUDE_CONFIG_DIR)
  prompt-history.json        # TUI prompt input history
  node_modules/              # srt binary location for compiled binary
```

### Config hierarchy (later wins)

1. Built-in defaults (`packages/deerbox/src/config.ts` `DEFAULT_CONFIG`)
2. `~/.config/deer/config.toml` (global)
3. `<repo>/deer.toml` (repo-local, see `deer.toml.example`)
4. CLI overrides

### Security model

- Sandbox gets no host secrets — credentials stay on the host
- MITM auth proxy on a Unix socket injects real auth headers per-domain
- Sandbox receives HTTP base URLs routed through SRT proxy → MITM → real HTTPS
- Only `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` needed on host; OAuth takes priority

## Releases

Tagged pushes (`v*`) trigger `.github/workflows/release.yml` which builds binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64 and publishes a GitHub release.
