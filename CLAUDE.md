# deer

Unattended coding agent — runs Claude Code in sandboxed tmux sessions against git worktrees, with a TUI dashboard.

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
1. Creates a git worktree (`deer/<taskId>` branch) under `~/.local/share/deer/tasks/<taskId>/worktree`
2. Launches an SRT sandbox with a network allowlist and MITM auth proxy
3. Runs `claude --dangerously-skip-permissions` inside a tmux session (`deer-<taskId>`)
4. Finalizes by creating a GitHub PR and cleaning up

### Key files

| File | Purpose |
|------|---------|
| `src/cli.tsx` | Entry point — detects repo, renders dashboard |
| `src/dashboard.tsx` | Ink TUI dashboard |
| `src/agent.ts` | Agent lifecycle: worktree → sandbox → tmux → finalize |
| `src/config.ts` | Config loading/merging (global + repo-local + CLI) |
| `src/task.ts` | Task ID generation, history persistence (JSONL) |
| `src/sandbox/index.ts` | Sandbox launch, tmux session management |
| `src/sandbox/srt.ts` | SRT runtime implementation |
| `src/sandbox/auth-proxy.ts` | Host-side MITM proxy for credential injection |
| `src/git/worktree.ts` | Git worktree create/remove/detect |
| `src/git/finalize.ts` | PR creation and worktree cleanup |
| `src/state-machine.ts` | Per-task state machine |
| `src/constants.ts` | All tunable constants (poll intervals, model, etc.) |

### Data layout

```
~/.local/share/deer/
  tasks/<taskId>/worktree/   # git worktree (only writable path in sandbox)
  history/<repohash>.jsonl   # per-repo task history
  prompt-history.json        # TUI prompt input history
```

### Config hierarchy (later wins)

1. Built-in defaults (`src/config.ts` `DEFAULT_CONFIG`)
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
