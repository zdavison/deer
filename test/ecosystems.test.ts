import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { applyEcosystems, BUILTIN_PLUGINS } from "../packages/deerbox/src/index";
import type { EcosystemPlugin } from "../packages/deerbox/src/index";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ecosystems", () => {
  let tmpDir: string;
  let repoPath: string;
  let worktreePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-eco-test-"));
    repoPath = join(tmpDir, "repo");
    worktreePath = join(tmpDir, "worktree");
    await mkdir(repoPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("detection", () => {
    test("uvPlugin returns false when uv.lock absent, true when present", async () => {
      const uvPlugin = BUILTIN_PLUGINS.find((p) => p.name === "uv")!;
      expect(await uvPlugin.detect(repoPath)).toBe(false);
      await writeFile(join(repoPath, "uv.lock"), "");
      expect(await uvPlugin.detect(repoPath)).toBe(true);
    });

    test("pnpmPlugin returns false when pnpm-lock.yaml absent, true when present", async () => {
      const pnpmPlugin = BUILTIN_PLUGINS.find((p) => p.name === "pnpm")!;
      expect(await pnpmPlugin.detect(repoPath)).toBe(false);
      await writeFile(join(repoPath, "pnpm-lock.yaml"), "");
      expect(await pnpmPlugin.detect(repoPath)).toBe(true);
    });

    test("npmPlugin detects package-lock.json without pnpm-lock.yaml", async () => {
      const npmPlugin = BUILTIN_PLUGINS.find((p) => p.name === "npm")!;
      expect(await npmPlugin.detect(repoPath)).toBe(false);
      await writeFile(join(repoPath, "package-lock.json"), "");
      expect(await npmPlugin.detect(repoPath)).toBe(true);
      // Excluded when pnpm-lock.yaml is also present
      await writeFile(join(repoPath, "pnpm-lock.yaml"), "");
      expect(await npmPlugin.detect(repoPath)).toBe(false);
    });

    test("npmPlugin excluded when bun.lockb is present", async () => {
      const npmPlugin = BUILTIN_PLUGINS.find((p) => p.name === "npm")!;
      await writeFile(join(repoPath, "package-lock.json"), "");
      expect(await npmPlugin.detect(repoPath)).toBe(true);
      await writeFile(join(repoPath, "bun.lockb"), "");
      expect(await npmPlugin.detect(repoPath)).toBe(false);
    });

    test("npmPlugin excluded when bun.lock is present", async () => {
      const npmPlugin = BUILTIN_PLUGINS.find((p) => p.name === "npm")!;
      await writeFile(join(repoPath, "package-lock.json"), "");
      expect(await npmPlugin.detect(repoPath)).toBe(true);
      await writeFile(join(repoPath, "bun.lock"), "");
      expect(await npmPlugin.detect(repoPath)).toBe(false);
    });

    test("goPlugin returns false when go.mod absent, true when present", async () => {
      const goPlugin = BUILTIN_PLUGINS.find((p) => p.name === "go")!;
      expect(await goPlugin.detect(repoPath)).toBe(false);
      await writeFile(join(repoPath, "go.mod"), "");
      expect(await goPlugin.detect(repoPath)).toBe(true);
    });

    test("bunPlugin detects bun.lockb", async () => {
      const bunPlugin = BUILTIN_PLUGINS.find((p) => p.name === "bun")!;
      expect(await bunPlugin.detect(repoPath)).toBe(false);
      await writeFile(join(repoPath, "bun.lockb"), "");
      expect(await bunPlugin.detect(repoPath)).toBe(true);
    });

    test("bunPlugin detects bun.lock", async () => {
      const bunPlugin = BUILTIN_PLUGINS.find((p) => p.name === "bun")!;
      expect(await bunPlugin.detect(repoPath)).toBe(false);
      await writeFile(join(repoPath, "bun.lock"), "");
      expect(await bunPlugin.detect(repoPath)).toBe(true);
    });
  });

  describe("env strategy", () => {
    test("relative values are resolved to worktreePath", async () => {
      const result = await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "test",
          detect: async () => true,
          strategies: [{ type: "env", vars: { MY_CACHE: ".cache" } }],
        },
      ]);
      expect(result.env.MY_CACHE).toBe(join(worktreePath, ".cache"));
    });

    test("absolute values are unchanged", async () => {
      const result = await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "test",
          detect: async () => true,
          strategies: [{ type: "env", vars: { MY_CACHE: "/absolute/path" } }],
        },
      ]);
      expect(result.env.MY_CACHE).toBe("/absolute/path");
    });

    test("tilde-prefixed values are unchanged", async () => {
      const result = await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "test",
          detect: async () => true,
          strategies: [{ type: "env", vars: { MY_CACHE: "~/.cache/something" } }],
        },
      ]);
      expect(result.env.MY_CACHE).toBe("~/.cache/something");
    });
  });

  describe("readonly-cache strategy", () => {
    test("~ is expanded to HOME", async () => {
      const HOME = process.env.HOME!;
      const result = await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "test",
          detect: async () => true,
          strategies: [{ type: "readonly-cache", hostPath: "~/.cache/test" }],
        },
      ]);
      expect(result.extraReadPaths).toContain(join(HOME, ".cache/test"));
    });

    test("absolute paths are unchanged", async () => {
      const result = await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "test",
          detect: async () => true,
          strategies: [{ type: "readonly-cache", hostPath: "/usr/local/cache" }],
        },
      ]);
      expect(result.extraReadPaths).toContain("/usr/local/cache");
    });
  });

  describe("prepopulate strategy", () => {
    test("lockfile match: source copied into worktree", async () => {
      const lockContent = "lockfile content";
      await writeFile(join(repoPath, "uv.lock"), lockContent);
      await writeFile(join(worktreePath, "uv.lock"), lockContent);
      await mkdir(join(repoPath, ".venv"), { recursive: true });
      await writeFile(join(repoPath, ".venv", "pyvenv.cfg"), "home = /usr/bin");

      await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "test",
          detect: async () => true,
          strategies: [{ type: "prepopulate", source: ".venv", lockfile: "uv.lock" }],
        },
      ]);

      expect(await Bun.file(join(worktreePath, ".venv", "pyvenv.cfg")).exists()).toBe(true);
    });

    test("lockfile mismatch: source not copied", async () => {
      await writeFile(join(repoPath, "uv.lock"), "lock v1");
      await writeFile(join(worktreePath, "uv.lock"), "lock v2");
      await mkdir(join(repoPath, ".venv"), { recursive: true });
      await writeFile(join(repoPath, ".venv", "pyvenv.cfg"), "home = /usr/bin");

      await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "test",
          detect: async () => true,
          strategies: [{ type: "prepopulate", source: ".venv", lockfile: "uv.lock" }],
        },
      ]);

      expect(await Bun.file(join(worktreePath, ".venv", "pyvenv.cfg")).exists()).toBe(false);
    });

    test("source absent in repo: no error thrown", async () => {
      await writeFile(join(repoPath, "uv.lock"), "lockfile");
      await writeFile(join(worktreePath, "uv.lock"), "lockfile");
      // .venv intentionally absent from repoPath

      await expect(
        applyEcosystems(repoPath, worktreePath, [], [
          {
            name: "test",
            detect: async () => true,
            strategies: [{ type: "prepopulate", source: ".venv", lockfile: "uv.lock" }],
          },
        ]),
      ).resolves.toBeDefined();
    });

    test("destination already exists: skipped (idempotent, no overwrite)", async () => {
      const lockContent = "lockfile content";
      await writeFile(join(repoPath, "uv.lock"), lockContent);
      await writeFile(join(worktreePath, "uv.lock"), lockContent);
      await mkdir(join(repoPath, ".venv"), { recursive: true });
      await writeFile(join(repoPath, ".venv", "pyvenv.cfg"), "home = /usr/bin");
      // Destination already exists with different content
      await mkdir(join(worktreePath, ".venv"), { recursive: true });
      await writeFile(join(worktreePath, ".venv", "existing.txt"), "existing");

      await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "test",
          detect: async () => true,
          strategies: [{ type: "prepopulate", source: ".venv", lockfile: "uv.lock" }],
        },
      ]);

      expect(await Bun.file(join(worktreePath, ".venv", "existing.txt")).exists()).toBe(true);
      expect(await Bun.file(join(worktreePath, ".venv", "pyvenv.cfg")).exists()).toBe(false);
    });
  });

  describe("bun ecosystem", () => {
    test("sets BUN_INSTALL_CACHE_DIR inside worktree", async () => {
      await writeFile(join(repoPath, "bun.lockb"), "");
      const result = await applyEcosystems(repoPath, worktreePath);
      expect(result.env.BUN_INSTALL_CACHE_DIR).toBe(join(worktreePath, ".bun-install-cache"));
    });

    test("prepopulates node_modules when bun.lockb matches", async () => {
      const lockContent = "bun lock content";
      await writeFile(join(repoPath, "bun.lockb"), lockContent);
      await writeFile(join(worktreePath, "bun.lockb"), lockContent);
      await mkdir(join(repoPath, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(repoPath, "node_modules", "pkg", "index.js"), "module.exports = {}");

      await applyEcosystems(repoPath, worktreePath);

      expect(await Bun.file(join(worktreePath, "node_modules", "pkg", "index.js")).exists()).toBe(true);
    });

    test("prepopulates node_modules when bun.lock matches", async () => {
      const lockContent = "bun text lock content";
      await writeFile(join(repoPath, "bun.lock"), lockContent);
      await writeFile(join(worktreePath, "bun.lock"), lockContent);
      await mkdir(join(repoPath, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(repoPath, "node_modules", "pkg", "index.js"), "module.exports = {}");

      await applyEcosystems(repoPath, worktreePath);

      expect(await Bun.file(join(worktreePath, "node_modules", "pkg", "index.js")).exists()).toBe(true);
    });
  });

  describe("disabled ecosystems", () => {
    test("disabled plugin is skipped even when detected", async () => {
      await writeFile(join(repoPath, "uv.lock"), "");
      const result = await applyEcosystems(repoPath, worktreePath, ["uv"]);
      expect(result.env.UV_CACHE_DIR).toBeUndefined();
    });
  });

  describe("multiple ecosystems", () => {
    test("multiple detected plugins: all applied, results merged", async () => {
      const result = await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "a",
          detect: async () => true,
          strategies: [{ type: "env", vars: { A_VAR: "/a" } }],
        },
        {
          name: "b",
          detect: async () => true,
          strategies: [{ type: "env", vars: { B_VAR: "/b" } }],
        },
      ]);
      expect(result.env.A_VAR).toBe("/a");
      expect(result.env.B_VAR).toBe("/b");
    });
  });

  describe("custom plugins", () => {
    test("custom plugins list overrides builtins", async () => {
      // uv.lock present but builtins shouldn't run when custom list is provided
      await writeFile(join(repoPath, "uv.lock"), "");
      const result = await applyEcosystems(repoPath, worktreePath, [], [
        {
          name: "custom",
          detect: async () => true,
          strategies: [{ type: "env", vars: { CUSTOM_VAR: "/custom" } }],
        },
      ]);
      expect(result.env.CUSTOM_VAR).toBe("/custom");
      expect(result.env.UV_CACHE_DIR).toBeUndefined();
    });
  });
});
