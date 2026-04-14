---
title: Config Files
outline: deep
---

# Config Files

## Global config (`~/.config/deer/config.toml`)

The global config applies to all repositories. Any field you set here replaces the built-in default for that field.

Note that list fields like `allowlist` replace the built-in list entirely -- they are not additive.

```toml
[defaults]
base_branch = "main"
timeout_ms = 1800000
setup_command = "npm install"

[network]
allowlist = [
  "api.anthropic.com",
  "claude.ai",
  "statsig.anthropic.com",
  "sentry.io",
  "registry.npmjs.org",
]

[sandbox]
runtime = "srt"
env_passthrough = ["NODE_ENV", "CI"]
```

---

## Repo-local config (`deer.toml`)

Place this file in your repository root. It is safe to commit.

Top-level fields (like `base_branch`) override the global config directly. For list fields, use the `_extra` suffix to append to (rather than replace) the global list.

```toml
base_branch = "master"
setup_command = "pnpm install"

[network]
allowlist_extra = ["npm.pkg.github.com"]

[sandbox]
env_passthrough_extra = ["NODE_ENV"]
```

---

## The `_extra` convention

Global config uses bare field names. Repo-local config uses `_extra` suffixed fields to extend lists without replacing them.

| Global field | Repo-local field | Behavior |
|---|---|---|
| `allowlist` | `allowlist_extra` | Global replaces built-in list; repo-local appends to it |
| `env_passthrough` | `env_passthrough_extra` | Global replaces built-in list; repo-local appends to it |
| `proxy_credentials` | `proxy_credentials_extra` | Global replaces built-in list; repo-local appends to it |

This means a repo-local `deer.toml` never accidentally removes domains or credentials that the global config provides.

---

## CLI flags

CLI flags have the highest priority and override all config file values.

| Flag | Description |
|------|-------------|
| `--model` | Override the model used by the agent |
| `--base-branch` | Override the base branch for PRs |
| `--from` | Start the worktree from a specific branch instead of the base branch |
| `--keep` | Keep the worktree after the agent finishes |
| `--continue` | Continue a previous agent session |
