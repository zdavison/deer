/**
 * Ecosystem-aware dependency strategy system.
 *
 * Each plugin declares strategies for preparing a worktree:
 * - readonly-cache: bind-mount a host cache directory read-only into the sandbox
 * - prepopulate: copy a local artifact from the repo into the worktree before launch
 * - env: inject environment variables into the sandbox
 */

import { join } from "node:path";
import { stat, mkdir, appendFile } from "node:fs/promises";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Strategy =
  | { type: "readonly-cache"; hostPath: string }
  | { type: "prepopulate"; source: string; lockfile: string }
  | { type: "env"; vars: Record<string, string> }
  | { type: "git-exclude"; patterns: string[] };

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
    { type: "readonly-cache", hostPath: "~/.pnpm-store" },
    { type: "prepopulate", source: "node_modules", lockfile: "pnpm-lock.yaml" },
    { type: "env", vars: { PNPM_HOME: ".pnpm-store" } },
  ],
};

const npmPlugin: EcosystemPlugin = {
  name: "npm",
  detect: async (repoPath) => {
    const [hasPackageLock, hasPnpmLock, hasBunLock, hasBunLockb] = await Promise.all([
      pathExists(join(repoPath, "package-lock.json")),
      pathExists(join(repoPath, "pnpm-lock.yaml")),
      pathExists(join(repoPath, "bun.lock")),
      pathExists(join(repoPath, "bun.lockb")),
    ]);
    return hasPackageLock && !hasPnpmLock && !hasBunLock && !hasBunLockb;
  },
  strategies: [
    { type: "readonly-cache", hostPath: "~/.npm" },
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
    // Prevent the cache dir from being committed.
    { type: "git-exclude", patterns: [".bun-install-cache"] },
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
 * @param onStatus - Optional callback for status/progress messages
 */
export async function applyEcosystems(
  repoPath: string,
  worktreePath: string,
  disabledEcosystems?: string[],
  plugins?: EcosystemPlugin[],
  onStatus?: (message: string) => void,
): Promise<EcosystemResult> {
  const HOME = process.env.HOME ?? "";
  const effectivePlugins = (plugins ?? BUILTIN_PLUGINS).filter(
    (p) => !disabledEcosystems?.includes(p.name),
  );

  const detected = await Promise.all(effectivePlugins.map((p) => p.detect(repoPath)));
  const activePlugins = effectivePlugins.filter((_, i) => detected[i]);

  if (activePlugins.length > 0) {
    onStatus?.(`Preparing ecosystems: ${activePlugins.map((p) => p.name).join(", ")}`);
  }

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
      } else if (strategy.type === "git-exclude") {
        try {
          const gitDirResult = await Bun.$`git -C ${worktreePath} rev-parse --git-dir`.quiet().nothrow();
          if (gitDirResult.exitCode === 0) {
            const gitDir = gitDirResult.stdout.toString().trim();
            const resolvedGitDir = gitDir.startsWith("/") ? gitDir : join(worktreePath, gitDir);
            const infoDir = join(resolvedGitDir, "info");
            await mkdir(infoDir, { recursive: true });
            const excludePath = join(infoDir, "exclude");
            await appendFile(excludePath, strategy.patterns.join("\n") + "\n");
          }
        } catch (err) {
          process.stderr.write(`[deer] ecosystems: git-exclude: ${err}\n`);
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

          onStatus?.(`[${plugin.name}] Prepopulating ${strategy.source}...`);

          const cpCmd = process.platform === "darwin"
            ? Bun.$`cp -cR ${repoSource} ${worktreeDest}`.quiet()
            : Bun.$`cp --reflink=auto -r ${repoSource} ${worktreeDest}`.quiet();
          await cpCmd;
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
