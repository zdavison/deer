---
title: Field Reference
outline: deep
---

# Field Reference

## `[defaults]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | `"claude"` | Agent to use. Currently only `claude` is supported. |
| `base_branch` | string | repo default branch | Base branch for PRs. |
| `timeout_ms` | integer | `1800000` | Agent timeout in milliseconds (default 30 min). Agents running longer are killed. |
| `setup_command` | string | none | Shell command run in the worktree before the agent starts (e.g. `pnpm install`). |

---

## `[network]`

| Field | Type | Default | Scope | Description |
|-------|------|---------|-------|-------------|
| `allowlist` | string[] | see below | global | Domains the sandbox can reach. Replaces the built-in list when set. |
| `allowlist_extra` | string[] | `[]` | repo-local | Additional domains appended to the allowlist. |

**Built-in allowlist:**

```
api.anthropic.com
claude.ai
statsig.anthropic.com
sentry.io
registry.npmjs.org
github.com
api.github.com
```

---

## `[sandbox]`

| Field | Type | Default | Scope | Description |
|-------|------|---------|-------|-------------|
| `runtime` | string | `"srt"` | global | Sandbox runtime. Only `"srt"` is supported. |
| `env_passthrough` | string[] | `[]` | global | Host env vars forwarded to the sandbox. |
| `env_passthrough_extra` | string[] | `[]` | repo-local | Additional env vars to forward. |
| `write_paths` | string[] | `[]` | global | Host paths to grant write access inside the sandbox. Paths starting with `~/` are resolved to `$HOME`. |
| `write_paths_extra` | string[] | `[]` | repo-local | Additional write paths to append. |
| `read_paths` | string[] | `[]` | global | Host paths to grant read access inside the sandbox. Paths starting with `~/` are resolved to `$HOME`. |
| `read_paths_extra` | string[] | `[]` | repo-local | Additional read paths to append. |
| `proxy_credentials` | ProxyCredential[] | (built-in) | global | Credentials for the MITM auth proxy. Replaces the built-in list when set. |
| `proxy_credentials_extra` | ProxyCredential[] | `[]` | repo-local | Additional proxy credentials to append. |
| `ecosystems_disabled` | string[] | `[]` | repo-local | Ecosystem plugins to disable (e.g. `["npm", "go"]`). |

---

## `[[sandbox.proxy_credentials]]` / `[[sandbox.proxy_credentials_extra]]`

Each entry defines a credential the auth proxy injects into requests. The sandbox never sees the real credential value.

| Field | Type | Description |
|-------|------|-------------|
| `domain` | string | Domain to intercept (e.g. `"npm.pkg.github.com"`). |
| `target` | string | Real upstream URL (e.g. `"https://npm.pkg.github.com"`). |
| `hostEnv.key` | string | Host env var holding the credential (e.g. `"GITHUB_TOKEN"`). |
| `headerTemplate` | table | Headers to inject. Use `${value}` for the env var value. (e.g. `authorization = "Bearer ${value}"`) |
| `sandboxEnv.key` | string | Env var name set inside the sandbox. |
| `sandboxEnv.value` | string | Env var value set inside the sandbox (usually an HTTP URL through the proxy). |

**Example:**

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

The sandbox receives `NPM_CONFIG_REGISTRY=http://npm.pkg.github.com`. The MITM proxy intercepts requests to `npm.pkg.github.com`, injects the real `Authorization: Bearer <token>` header, and forwards over HTTPS. The actual `GITHUB_TOKEN` never enters the sandbox.
