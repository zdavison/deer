/**
 * Ecosystem-aware dependency strategy system.
 *
 * Each plugin declares strategies for preparing a worktree:
 * - readonly-cache: bind-mount a host cache directory read-only into the sandbox
 * - prepopulate: copy a local artifact from the repo into the worktree before launch
 * - env: inject environment variables into the sandbox
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Strategy =
  | { type: "readonly-cache"; hostPath: string }
  | { type: "prepopulate"; source: string; lockfile: string }
  | { type: "env"; vars: Record<string, string> };

export interface EcosystemPlugin {
  name: string;
  detect: (repoPath: string) => Promise<boolean>;
  strategies: Strategy[];
}

export interface EcosystemResult {
  extraReadPaths: string[];
  env: Record<string, string>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── Built-in plugins ──────────────────────────────────────────────────────────

const uvPlugin: EcosystemPlugin = {
  name: "uv",
  detect: async (repoPath) => pathExists(join(repoPath, "uv.lock")),
  strategies: [
    { type: "readonly-cache", hostPath: "~/.cache/uv" },
    { type: "env", vars: { UV_CACHE_DIR: ".uv-cache" } },
    { type: "prepopulate", source: ".venv", lockfile: "uv.lock" },
  ],
};

const pnpmPlugin: EcosystemPlugin = {
  name: "pnpm",
  detect: async (repoPath) => pathExists(join(repoPath, "pnpm-lock.yaml")),
  strategies: [
    { type: "prepopulate", source: "node_modules", lockfile: "pnpm-lock.yaml" },
    { type: "env", vars: { PNPM_HOME: ".pnpm-store" } },
  ],
};

const npmPlugin: EcosystemPlugin = {
  name: "npm",
  detect: async (repoPath) => {
    const [hasPackageLock, hasPnpmLock] = await Promise.all([
      pathExists(join(repoPath, "package-lock.json")),
      pathExists(join(repoPath, "pnpm-lock.yaml")),
    ]);
    return hasPackageLock && !hasPnpmLock;
  },
  strategies: [
    { type: "prepopulate", source: "node_modules", lockfile: "package-lock.json" },
  ],
};

const goPlugin: EcosystemPlugin = {
  name: "go",
  detect: async (repoPath) => pathExists(join(repoPath, "go.mod")),
  strategies: [
    { type: "readonly-cache", hostPath: "~/go/pkg/mod" },
    { type: "env", vars: { GOMODCACHE: ".gomodcache" } },
  ],
};

const bunPlugin: EcosystemPlugin = {
  name: "bun",
  detect: async (repoPath) => {
    const [hasLockb, hasLock] = await Promise.all([
      pathExists(join(repoPath, "bun.lockb")),
      pathExists(join(repoPath, "bun.lock")),
    ]);
    return hasLockb || hasLock;
  },
  strategies: [
    // Redirect bun's package cache to a writable dir inside the worktree.
    // The default ~/.bun/install/cache is read-only in the sandbox.
    { type: "env", vars: { BUN_INSTALL_CACHE_DIR: ".bun-install-cache" } },
    // Prepopulate node_modules from the host repo to avoid network installs.
    { type: "prepopulate", source: "node_modules", lockfile: "bun.lockb" },
    { type: "prepopulate", source: "node_modules", lockfile: "bun.lock" },
  ],
};

export const BUILTIN_PLUGINS: EcosystemPlugin[] = [
  uvPlugin,
  pnpmPlugin,
  npmPlugin,
  goPlugin,
  bunPlugin,
];

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Detect active ecosystems in the repo and apply their strategies.
 *
 * @param repoPath - Path to the host repository root (source of truth for lockfiles)
 * @param worktreePath - Path to the agent's git worktree
 * @param disabledEcosystems - Plugin names to skip
 * @param plugins - Override the plugin list (defaults to BUILTIN_PLUGINS)
 */
export async function applyEcosystems(
  repoPath: string,
  worktreePath: string,
  disabledEcosystems?: string[],
  plugins?: EcosystemPlugin[],
): Promise<EcosystemResult> {
  const HOME = process.env.HOME ?? "";
  const effectivePlugins = (plugins ?? BUILTIN_PLUGINS).filter(
    (p) => !disabledEcosystems?.includes(p.name),
  );

  const detected = await Promise.all(effectivePlugins.map((p) => p.detect(repoPath)));
  const activePlugins = effectivePlugins.filter((_, i) => detected[i]);

  const extraReadPathsSet = new Set<string>();
  const env: Record<string, string> = {};

  for (const plugin of activePlugins) {
    for (const strategy of plugin.strategies) {
      if (strategy.type === "readonly-cache") {
        const expanded = strategy.hostPath.startsWith("~/")
          ? join(HOME, strategy.hostPath.slice(2))
          : strategy.hostPath;
        extraReadPathsSet.add(expanded);
      } else if (strategy.type === "env") {
        for (const [key, value] of Object.entries(strategy.vars)) {
          // Relative values are resolved against the worktree; absolute and
          // tilde-prefixed values are passed through unchanged.
          const resolved =
            value.startsWith("/") || value.startsWith("~")
              ? value
              : join(worktreePath, value);
          env[key] = resolved;
        }
      } else if (strategy.type === "prepopulate") {
        try {
          const repoLockfile = join(repoPath, strategy.lockfile);
          const worktreeLockfile = join(worktreePath, strategy.lockfile);
          const repoSource = join(repoPath, strategy.source);
          const worktreeDest = join(worktreePath, strategy.source);

          const [repoLockExists, worktreeLockExists, sourceExists, destExists] =
            await Promise.all([
              pathExists(repoLockfile),
              pathExists(worktreeLockfile),
              pathExists(repoSource),
              pathExists(worktreeDest),
            ]);

          if (!repoLockExists || !worktreeLockExists || !sourceExists || destExists) continue;

          const [repoContent, worktreeContent] = await Promise.all([
            Bun.file(repoLockfile).text(),
            Bun.file(worktreeLockfile).text(),
          ]);

          if (repoContent !== worktreeContent) continue;

          await Bun.$`cp --reflink=auto -r ${repoSource} ${worktreeDest}`.quiet();
        } catch (err) {
          process.stderr.write(`[deer] ecosystems: prepopulate ${strategy.source}: ${err}\n`);
        }
      }
    }
  }

  return {
    extraReadPaths: [...extraReadPathsSet],
    env,
  };
}
