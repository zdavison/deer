---
title: Configuration
---

# Configuration

deer and deerbox share a layered configuration system. Later sources override earlier ones:

1. **Built-in defaults** -- sensible defaults baked into deerbox.
2. **`~/.config/deer/config.toml`** -- global config, applies to all repositories.
3. **`deer.toml`** in your repo root -- repo-local config, safe to commit.
4. **CLI flags** -- highest priority, override everything else.

See [Config Files](config-files) for details on each file, [Field Reference](field-reference) for every available option, and [Examples](examples) for common configurations.
