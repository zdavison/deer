import TOML from "@iarna/toml";
import { join } from "node:path";

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
  boilerhouse: {
    /**
     * @default "http://localhost:3000"
     */
    url: string;
  };
  network: {
    allowlist: string[];
  };
  repos: Record<string, RepoConfig>;
}

export interface RepoConfig {
  baseBranch?: string;
  setupCommand?: string;
  env?: Record<string, string>;
  networkAllowlistExtra?: string[];
}

export interface RepoLocalConfig {
  baseBranch?: string;
  setupCommand?: string;
  network?: {
    allowlistExtra?: string[];
  };
  env?: Record<string, string>;
}

export const DEFAULT_CONFIG: DeerConfig = {
  defaults: {
    agent: "claude",
    timeoutMs: 1800000,
  },
  boilerhouse: {
    url: "http://localhost:3000",
  },
  network: {
    allowlist: [
      "api.anthropic.com",
      "statsig.anthropic.com",
      "sentry.io",
      "registry.npmjs.org",
      "pypi.org",
      "github.com",
      "objects.githubusercontent.com",
      "archive.ubuntu.com",
      "security.ubuntu.com",
      "deb.debian.org",
    ],
  },
  repos: {},
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

  // env is handled at task build time, not merged into config defaults

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
  let config = structuredClone(DEFAULT_CONFIG);

  // 1. Global config
  const globalPath = globalConfigPath ?? join(process.env.HOME ?? "", ".config", "deer", "config.toml");
  const globalToml = await readTomlFile(globalPath);
  if (globalToml) {
    const globalConfig = tomlToConfig(globalToml);
    config = deepMerge(
      config as unknown as Record<string, unknown>,
      globalConfig as Record<string, unknown>
    ) as unknown as DeerConfig;
  }

  // 2. Repo-local config
  const repoToml = await readTomlFile(join(repoPath, "deer.toml"));
  if (repoToml) {
    config = applyRepoLocal(config, repoToml);
  }

  // 3. CLI overrides
  if (cliOverrides) {
    config = deepMerge(
      config as unknown as Record<string, unknown>,
      cliOverrides as Record<string, unknown>
    ) as unknown as DeerConfig;
  }

  return config;
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

  const boilerhouse = toml.boilerhouse as Record<string, unknown> | undefined;
  if (boilerhouse) {
    result.boilerhouse = {
      ...(boilerhouse.url !== undefined && { url: boilerhouse.url }),
    };
  }

  const network = toml.network as Record<string, unknown> | undefined;
  if (network) {
    result.network = {
      ...(network.allowlist !== undefined && { allowlist: network.allowlist }),
    };
  }

  if (toml.repos) {
    result.repos = toml.repos;
  }

  return result as Partial<DeerConfig>;
}
