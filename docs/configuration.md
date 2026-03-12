---
layout: default
title: Configuration
nav_order: 2
---

# Configuration
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

Configuration is layered — later sources override earlier ones:

1. Built-in defaults
2. `~/.config/deer/config.toml` — global config (applies to all repos)
3. `deer.toml` in your repo root — repo-local config (safe to commit)
4. CLI flags

---

## CLI flags

| Flag | Description |
|------|-------------|
| `--lang=<code>` | Set the display language. See supported values below. Omit for English (default). Also localises generated PR titles and descriptions; branch names stay ASCII. |

**Supported languages:**

| Language | `--lang=` value | LLM-translated |
|----------|----------------|:--------------:|
| English | *(default)* | |
| Japanese (日本語) | `ja` | ✓ |
| Chinese Simplified (简体中文) | `zh` | ✓ |
| Korean (한국어) | `ko` | ✓ |
| Russian (русский) | `ru` | ✓ |

LLM-translated languages may contain errors. PRs to improve translations are welcome — edit the relevant block in [`src/i18n.ts`](https://github.com/zdavison/deer/blob/main/src/i18n.ts).

**Language detection priority** (first match wins):

1. `--lang=<code>` CLI flag
2. `CLAUDE_CODE_LOCALE` environment variable (e.g. `CLAUDE_CODE_LOCALE=zh`)
3. System `LANG` environment variable (e.g. `LANG=zh_CN.UTF-8`)
4. Default: English

---

## Global config

**Location:** `~/.config/deer/config.toml`

Applies to all repos. Replaces built-in defaults for any field you set.

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

## Repo-local config

**Location:** `<repo>/deer.toml`

Extends the global config for a specific repository. Uses `_extra` variants to append to lists rather than replace them. Safe to commit.

```toml
# Override the base branch for this repo
base_branch = "master"

# Run a setup command inside the worktree before the agent starts
setup_command = "pnpm install"

# Extend the network allowlist (merged with global allowlist)
[network]
allowlist_extra = ["npm.pkg.github.com", "your-registry.example.com"]

# Forward additional host env vars into the sandbox
[sandbox]
env_passthrough_extra = ["NODE_ENV", "CI"]

# Inject extra credentials via the host-side auth proxy
[[sandbox.proxy_credentials_extra]]
domain = "your-registry.example.com"
target = "https://your-registry.example.com"
[sandbox.proxy_credentials_extra.hostEnv]
key = "MY_REGISTRY_TOKEN"
[sandbox.proxy_credentials_extra.headerTemplate]
authorization = "Bearer ${value}"
[sandbox.proxy_credentials_extra.sandboxEnv]
key = "NPM_CONFIG_REGISTRY"
value = "http://your-registry.example.com"
```

---

## Field reference

### `[defaults]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `base_branch` | string | *(repo default branch)* | Base branch used when creating PRs. |
| `timeout_ms` | integer | `1800000` | Agent timeout in milliseconds. Agents that run longer than this are killed. Default is 30 minutes. |
| `setup_command` | string | *(none)* | Shell command run inside the worktree before the agent starts. Useful for installing dependencies (e.g. `pnpm install`). |

---

### `[network]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowlist` | string[] | See below | Domains the sandbox is permitted to reach. **Replaces** the built-in list entirely when set in global config. |
| `allowlist_extra` | string[] | `[]` | *(repo-local only)* Additional domains to append to the allowlist. Does not replace the existing list. |

**Built-in allowlist defaults:**

```toml
allowlist = [
  "api.anthropic.com",
  "claude.ai",
  "statsig.anthropic.com",
  "sentry.io",
  "registry.npmjs.org",
]
```

---

### `[sandbox]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `runtime` | string | `"srt"` | Sandbox runtime for process isolation. `"srt"` (Anthropic Sandbox Runtime) is the only supported value. Uses `bwrap` on Linux and `seatbelt` on macOS. |
| `env_passthrough` | string[] | `[]` | Host environment variable names to forward into the sandbox. Only listed vars (plus `PATH`, `HOME`, `TERM`) reach the sandboxed process. |
| `env_passthrough_extra` | string[] | `[]` | *(repo-local only)* Additional env vars to forward. Appended to `env_passthrough`. |
| `proxy_credentials` | ProxyCredential[] | See below | Credentials proxied via the host-side auth proxy. Replaces the built-in list when set in global config. |
| `proxy_credentials_extra` | ProxyCredential[] | `[]` | *(repo-local only)* Additional proxy credentials to append to the list. |

**Built-in proxy credentials** handle `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` for `api.anthropic.com` automatically. You do not need to configure these.

---

### `[[sandbox.proxy_credentials]]`

Each entry maps a host environment variable to an upstream API, injecting auth headers transparently. The sandbox never sees the real credential.

| Field | Type | Description |
|-------|------|-------------|
| `domain` | string | Domain to intercept (e.g. `"your-registry.example.com"`). Requests to this domain are routed through the MITM proxy. |
| `target` | string | Real upstream origin (e.g. `"https://your-registry.example.com"`). The proxy forwards to this over HTTPS. |
| `hostEnv.key` | string | Name of the host environment variable that holds the credential (e.g. `"MY_REGISTRY_TOKEN"`). |
| `headerTemplate` | table | Map of header name → value template. Use `${value}` to interpolate the env var (e.g. `authorization = "Bearer ${value}"`). |
| `sandboxEnv.key` | string | Env var name set inside the sandbox (e.g. `"NPM_CONFIG_REGISTRY"`). |
| `sandboxEnv.value` | string | Env var value set inside the sandbox. Should be an HTTP URL routed through the SRT proxy (e.g. `"http://your-registry.example.com"`). |

**Example — private npm registry:**

```toml
[[sandbox.proxy_credentials_extra]]
domain = "npm.pkg.github.com"
target = "https://npm.pkg.github.com"
[sandbox.proxy_credentials_extra.hostEnv]
key = "GITHUB_TOKEN"
[sandbox.proxy_credentials_extra.headerTemplate]
authorization = "Bearer ${value}"
[sandbox.proxy_credentials_extra.sandboxEnv]
key = "NPM_CONFIG_REGISTRY"
value = "http://npm.pkg.github.com"
```

The sandbox gets `NPM_CONFIG_REGISTRY=http://npm.pkg.github.com` and `GITHUB_TOKEN=proxy-managed`. The MITM proxy intercepts requests to `npm.pkg.github.com`, injects `Authorization: Bearer <real-token>`, and forwards over HTTPS. The real token never enters the sandbox.
