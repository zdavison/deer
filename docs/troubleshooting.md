---
title: Troubleshooting
outline: deep
---

# Troubleshooting

## Preflight errors

### "@anthropic-ai/sandbox-runtime not installed"

SRT (Sandbox Runtime) is required for deer to function. It should be installed automatically during deer installation.

If it is missing, try reinstalling deer:

```sh
curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash
```

### "sandbox-exec not available" (macOS)

`sandbox-exec` is a built-in macOS utility that SRT uses for filesystem isolation. If it is missing, your macOS version may not be supported. deer requires macOS 12 (Monterey) or later.

### "bwrap not available" (Linux)

Bubblewrap is required on Linux for filesystem isolation. Install it with your package manager:

```sh
# Debian / Ubuntu
apt install bubblewrap

# Fedora / RHEL
dnf install bubblewrap
```

### "claude CLI not available"

deer requires the Claude Code CLI. Install it by following the official instructions at [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code).

### "gh auth not configured"

The GitHub CLI is required for PR creation and git operations through the proxy. Authenticate it:

```sh
gh auth login
```

### "No credentials"

deer could not find any Claude credentials. You have several options:

- Set the `CLAUDE_CODE_OAUTH_TOKEN` environment variable
- Create a file at `~/.claude/agent-oauth-token` containing your token
- Set the `ANTHROPIC_API_KEY` environment variable
- If you have Claude Code installed, run `claude` once to ensure credentials are stored

See [Authentication](/authentication) for the full credential resolution order.

### "Claude OAuth token expired"

Your OAuth token has passed its expiry time. Refresh it:

```sh
claude /login
```

## Common issues

### Agent stuck in "setup"

If an agent stays in the setup status and never transitions to running:

- Run `deerbox preflight` to check for dependency or credential errors.
- Ensure tmux is installed and working: `tmux new-session -d -s test && tmux kill-session -t test`
- Check if SRT can launch: `srt --version`
- Look at the tmux pane output by pressing Enter on the agent in the dashboard to attach.

### Network requests failing in sandbox

The sandbox only allows outbound requests to domains on the allowlist. If the agent needs to reach a domain that is not on the default list, add it to your `deer.toml`:

```toml
[network]
allowlist_extra = ["example.com", "api.example.com"]
```

See [Network & Auth Proxy](/security/network) for the default allowlist and proxy configuration.

### Dependencies not available in sandbox

If the agent cannot find project dependencies inside the sandbox:

- **Check ecosystem detection** -- deer looks for lockfiles (`package-lock.json`, `yarn.lock`, `bun.lockb`, `Pipfile.lock`, `Cargo.lock`, etc.) in the repo root. If your lockfile is in a subdirectory, ecosystem detection may miss it.
- **Use a setup command** -- configure a custom setup command in `deer.toml`:

  ```toml
  [agent]
  setup_command = "cd packages/myapp && npm install"
  ```

- **Disable a conflicting ecosystem** -- if deer detects the wrong ecosystem, disable it:

  ```toml
  [agent]
  ecosystems_disabled = ["npm"]
  ```

### PR creation fails

If pressing `p` to create a PR results in an error:

- Ensure `gh auth token` returns a valid token.
- Check that you have push access to the repository.
- Verify the agent made actual changes -- an empty diff produces no PR.
- Check the error message in the dashboard for specifics (authentication, branch conflicts, etc.).

### Worktrees piling up

Old worktrees from previous tasks can accumulate on disk. Clean them up:

```sh
# Remove dangling worktrees and task directories
deerbox prune

# Force cleanup: kill all deer tmux sessions and remove everything
deerbox prune --force
```

### Multiple deer instances conflicting

Running multiple deer instances against the same repository is supported. deer uses SQLite WAL mode for concurrent database access and `poller_pid` claims to prevent duplicate polling.

If you experience issues with multiple instances:

- Check that all instances are running the same version of deer.
- Restart all instances -- stale PID claims from crashed processes are cleaned up on startup.
- As a last resort, run `deerbox prune --force` to reset all state and kill all sessions.
