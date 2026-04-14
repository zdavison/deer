---
title: Ecosystems
outline: deep
---

# Ecosystems

deerbox detects your project's package manager and optimizes the sandbox accordingly. This avoids re-downloading dependencies on every agent run.

## Supported ecosystems

| Ecosystem | Detected by | Cache strategy |
|-----------|-------------|----------------|
| uv (Python) | `uv.lock` | Read-only mount of `~/.cache/uv`, env `UV_CACHE_DIR` |
| pnpm | `pnpm-lock.yaml` | Read-only mount of `~/.pnpm-store`, prepopulate `node_modules` |
| npm | `package-lock.json` | Read-only mount of `~/.npm`, prepopulate `node_modules` |
| Go | `go.mod` | Read-only mount of `~/go/pkg/mod`, env `GOMODCACHE` |
| Bun | `bun.lockb` or `bun.lock` | Env `BUN_INSTALL_CACHE_DIR`, prepopulate `node_modules` |

Multiple ecosystems can be detected in the same repo (e.g. a Go backend with an npm frontend). All detected strategies are applied.

## Strategy types

### readonly-cache

Bind-mounts the host's package cache directory into the sandbox as read-only. The agent can read cached packages but cannot modify the host cache. This avoids re-downloading packages that are already present on the host.

### prepopulate

Copies `node_modules` (or `.venv`) from the host repo into the worktree before the agent launches, but only if the lockfiles match. This gives the agent a working dependency install from the start, so it can run tests and linters immediately without waiting for an install step.

### env

Sets environment variables inside the sandbox so the package manager uses a worktree-relative cache directory. This prevents the package manager from attempting to write to host-owned paths that are read-only in the sandbox.

### git-exclude

Adds cache directories to `.git/info/exclude` inside the worktree. This prevents the agent from accidentally committing cache directories like `node_modules` or `.venv`.

## Disabling ecosystems

If an ecosystem strategy causes problems, you can disable it in your `deer.toml`:

```toml
[sandbox]
ecosystems_disabled = ["npm", "go"]
```

This accepts an array of ecosystem names. Disabled ecosystems are skipped entirely -- no cache mounts, no prepopulation, no env vars.
