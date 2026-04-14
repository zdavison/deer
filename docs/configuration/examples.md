---
title: deer.toml Examples
outline: deep
---

# deer.toml Examples

Common `deer.toml` configurations for different project types. Place the file in your repository root and commit it so the whole team shares the same settings.

## Monorepo with pnpm

```toml
setup_command = "pnpm install"

[network]
allowlist_extra = ["registry.yarnpkg.com"]
```

---

## Python project with uv

```toml
setup_command = "uv sync"

[network]
allowlist_extra = ["pypi.org", "files.pythonhosted.org"]
```

---

## Private npm registry (GitHub Packages)

```toml
[network]
allowlist_extra = ["npm.pkg.github.com"]

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

The sandbox gets `NPM_CONFIG_REGISTRY=http://npm.pkg.github.com`. The auth proxy intercepts requests to that domain and injects the real token via the `Authorization` header. The actual `GITHUB_TOKEN` never enters the sandbox.

---

## Custom timeout (1 hour)

```toml
[defaults]
timeout_ms = 3600000
```

---

## Forwarding env vars

```toml
[sandbox]
env_passthrough_extra = ["NODE_ENV", "DATABASE_URL"]
```

Be careful forwarding sensitive variables into the sandbox. If the variable holds a secret (like a database password), consider using `proxy_credentials_extra` instead so the real value stays on the host.

---

## Different base branch

```toml
base_branch = "develop"
```
