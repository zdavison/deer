import TOML from "@iarna/toml";
import { join } from "node:path";
import { HOME } from "@deer/shared";

/**
 * Maps a host env var to auth headers injected by the host-side MITM proxy.
 *
 * The sandbox never sees the real credential. SRT's proxy forwards matching
 * domains through a Unix socket to our MITM proxy, which injects the real
 * auth headers and forwards to the upstream over HTTPS.
 */
export interface ProxyCredential {
  /** Domain to intercept (e.g. "api.anthropic.com") */
  domain: string;
  /** Target origin for the real upstream (e.g. "https://api.anthropic.com") */
  target: string;
  /** Host environment variable that holds the credential */
  hostEnv: { key: string };
  /** Header name → template. Use `${value}` for the env var value. */
  headerTemplate: Record<string, string>;
  /**
   * Environment variable config for the sandbox.
   *
   * - `key`: env var name to set (e.g. "ANTHROPIC_BASE_URL")
   * - `value`: env var value, using HTTP so requests route through SRT's
   *   proxy as plain HTTP (e.g. "http://api.anthropic.com")
   *
   * Additionally, `hostEnv.key` is injected into the sandbox as
   * `"proxy-managed"` so the sandboxed tool thinks it has credentials.
   */
  sandboxEnv: {
    key: string;
    value: string;
  };
}

export interface DeerConfig {
  defaults: {
    agent: "claude";
    baseBranch?: string;
    /**
     * @default 1800000 (30 minutes)
     */
    timeoutMs?: number;
    setupCommand?: string;
  };
  network: {
    allowlist: string[];
  };
  experimental?: {
    /**
     * Start generating PR metadata speculatively while the user reads the
     * post-session menu. Hides most of the Claude inference latency on the
     * happy path (user picks "p"). Incurs an extra Claude API call if the
     * user picks any other option.
     * @default false
     */
    speculativeClose?: boolean;
  };
  sandbox: {
    /**
     * Sandbox runtime to use for process isolation.
     * - "srt" — Anthropic Sandbox Runtime (cross-platform: bwrap on Linux, seatbelt on macOS)
     * @default "srt"
     */
    runtime: "srt";
    /**
     * Environment variable names to forward from the host into the sandbox.
     * Only these vars (plus PATH, HOME, TERM) reach the sandboxed process.
     * Credentials listed in proxyCredentials are NOT passed through — they
     * are kept on the host and injected by the auth proxy.
     */
    envPassthrough: string[];
    /**
     * Credentials proxied via the host-side auth proxy.
     * Each entry maps a host env var to an upstream API + auth header.
     * The sandbox receives a localhost base URL instead of the raw credential.
     */
    proxyCredentials: ProxyCredential[];
    /**
     * Ecosystem plugin configuration.
     */
    ecosystems?: {
      /**
       * Ecosystem plugin names to disable.
       * @default []
       * @example ["npm", "go"]
       */
      disabled?: string[];
    };
  };
}

export const DEFAULT_CONFIG: DeerConfig = {
  defaults: {
    agent: "claude",
    timeoutMs: 1800000,
  },
  network: {
    allowlist: [
      "api.anthropic.com",
      "claude.ai",
      "statsig.anthropic.com",
      "sentry.io",
      "registry.npmjs.org",
      "github.com",
      "api.github.com",
    ],
  },
  sandbox: {
    runtime: "srt",
    envPassthrough: [],
    proxyCredentials: [
      {
        domain: "api.anthropic.com",
        target: "https://api.anthropic.com",
        hostEnv: { key: "CLAUDE_CODE_OAUTH_TOKEN" },
        headerTemplate: { authorization: "Bearer ${value}" },
        sandboxEnv: {
          key: "ANTHROPIC_BASE_URL",
          value: "http://api.anthropic.com",
        },
      },
      {
        domain: "api.anthropic.com",
        target: "https://api.anthropic.com",
        hostEnv: { key: "ANTHROPIC_API_KEY" },
        headerTemplate: { "x-api-key": "${value}" },
        sandboxEnv: {
          key: "ANTHROPIC_BASE_URL",
          value: "http://api.anthropic.com",
        },
      },
    ],
  },
};

/**
 * Reads and parses a TOML file, returning null if the file doesn't exist.
 */
async function readTomlFile(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  const content = await file.text();
  return TOML.parse(content) as Record<string, unknown>;
}

/**
 * Deep merge two plain objects. `override` values take precedence.
 * Nested objects are recursively merged; scalars and arrays are replaced.
 */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];

    if (overVal === undefined) continue;

    if (
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof overVal === "object" &&
      overVal !== null &&
      !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>
      );
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

/**
 * Apply repo-local config (deer.toml) onto a DeerConfig.
 * Maps flat repo-local fields into the nested DeerConfig structure.
 */
function applyRepoLocal(config: DeerConfig, repoLocal: Record<string, unknown>): DeerConfig {
  const result = structuredClone(config);

  if (typeof repoLocal.base_branch === "string") {
    result.defaults.baseBranch = repoLocal.base_branch;
  }
  if (typeof repoLocal.setup_command === "string") {
    result.defaults.setupCommand = repoLocal.setup_command;
  }

  const network = repoLocal.network as Record<string, unknown> | undefined;
  if (network?.allowlist_extra && Array.isArray(network.allowlist_extra)) {
    result.network.allowlist = [
      ...result.network.allowlist,
      ...(network.allowlist_extra as string[]),
    ];
  }

  const sandbox = repoLocal.sandbox as Record<string, unknown> | undefined;
  if (sandbox?.env_passthrough_extra && Array.isArray(sandbox.env_passthrough_extra)) {
    result.sandbox.envPassthrough = [
      ...result.sandbox.envPassthrough,
      ...(sandbox.env_passthrough_extra as string[]),
    ];
  }
  if (sandbox?.proxy_credentials_extra && Array.isArray(sandbox.proxy_credentials_extra)) {
    result.sandbox.proxyCredentials = [
      ...result.sandbox.proxyCredentials,
      ...(sandbox.proxy_credentials_extra as ProxyCredential[]),
    ];
  }
  if (sandbox?.ecosystems_disabled && Array.isArray(sandbox.ecosystems_disabled)) {
    result.sandbox.ecosystems = {
      ...result.sandbox.ecosystems,
      disabled: [
        ...(result.sandbox.ecosystems?.disabled ?? []),
        ...(sandbox.ecosystems_disabled as string[]),
      ],
    };
  }

  const experimental = repoLocal.experimental as Record<string, unknown> | undefined;
  if (typeof experimental?.speculative_close === "boolean") {
    result.experimental = { ...result.experimental, speculativeClose: experimental.speculative_close };
  }

  return result;
}

/**
 * Load and merge deer configuration from global, repo-local, and CLI sources.
 *
 * Merge order (later wins):
 * 1. Built-in defaults
 * 2. `~/.config/deer/config.toml` (global)
 * 3. `<repoPath>/deer.toml` (repo-local)
 * 4. CLI overrides
 *
 * @param repoPath - Path to the repository root
 * @param cliOverrides - Partial config from CLI flags
 * @param globalConfigPath - Override for global config path (for testing)
 */
export async function loadConfig(
  repoPath: string,
  cliOverrides?: Partial<DeerConfig>,
  globalConfigPath?: string
): Promise<DeerConfig> {
  let config: unknown = structuredClone(DEFAULT_CONFIG);

  // 1. Global config
  const globalPath = globalConfigPath ?? join(HOME, ".config", "deer", "config.toml");
  const globalToml = await readTomlFile(globalPath);
  if (globalToml) {
    config = deepMerge(config as Record<string, unknown>, tomlToConfig(globalToml) as Record<string, unknown>);
  }

  // 2. Repo-local config
  const repoToml = await readTomlFile(join(repoPath, "deer.toml"));
  if (repoToml) {
    config = applyRepoLocal(config as DeerConfig, repoToml);
  }

  // 3. CLI overrides
  if (cliOverrides) {
    config = deepMerge(config as Record<string, unknown>, cliOverrides as Record<string, unknown>);
  }

  return config as DeerConfig;
}

/**
 * Convert parsed global TOML structure into a partial DeerConfig shape.
 * Handles snake_case to camelCase mapping for known fields.
 */
function tomlToConfig(toml: Record<string, unknown>): Partial<DeerConfig> {
  const result: Record<string, unknown> = {};

  const defaults = toml.defaults as Record<string, unknown> | undefined;
  if (defaults) {
    result.defaults = {
      ...(defaults.agent !== undefined && { agent: defaults.agent }),
      ...(defaults.timeout_ms !== undefined && { timeoutMs: defaults.timeout_ms }),
      ...(defaults.base_branch !== undefined && { baseBranch: defaults.base_branch }),
      ...(defaults.setup_command !== undefined && { setupCommand: defaults.setup_command }),
    };
  }

  const network = toml.network as Record<string, unknown> | undefined;
  if (network) {
    result.network = {
      ...(network.allowlist !== undefined && { allowlist: network.allowlist }),
    };
  }

  const sandbox = toml.sandbox as Record<string, unknown> | undefined;
  if (sandbox) {
    result.sandbox = {
      ...(sandbox.runtime !== undefined && { runtime: sandbox.runtime }),
      ...(sandbox.env_passthrough !== undefined && { envPassthrough: sandbox.env_passthrough }),
      ...(sandbox.proxy_credentials !== undefined && { proxyCredentials: sandbox.proxy_credentials }),
      ...(sandbox.ecosystems_disabled !== undefined && {
        ecosystems: { disabled: sandbox.ecosystems_disabled as string[] },
      }),
    };
  }

  const experimental = toml.experimental as Record<string, unknown> | undefined;
  if (experimental) {
    result.experimental = {
      ...(experimental.speculative_close !== undefined && { speculativeClose: experimental.speculative_close }),
    };
  }

  return result as Partial<DeerConfig>;
}
