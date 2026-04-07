# SRT Symlink Resolution Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize symlink resolution in the SRT sandbox from only `~/.claude/skills/` to all of `~/.claude/` and its subdirectories, with injectable `home` for testability.

**Architecture:** Add an optional `home` parameter to `createSrtRuntime()`, thread it through all internal helpers (`buildSrtSettings`, `buildHomeDenyList`). Replace the skills-specific `resolveSkillSymlinkTargets()` with an exported `resolveSymlinkTargets(dir)` that scans any directory and its immediate subdirs. Tests inject a temp `home` to avoid touching the real filesystem.

**Tech Stack:** TypeScript, Bun test runner, `node:fs` sync APIs, `bun:test`

---

## Files

- Modify: `packages/deerbox/src/sandbox/srt.ts` — injectable home, generalized symlink scanning
- Modify: `test/sandbox/srt-settings.test.ts` — new tests for symlink resolution (unit + integration)

---

### Task 1: Write failing tests

**Files:**
- Modify: `test/sandbox/srt-settings.test.ts`

- [ ] **Step 1: Add imports and a new describe block for symlink tests**

Replace the import block at the top of `test/sandbox/srt-settings.test.ts` (the import lines, not the existing describe blocks):

```typescript
import { test, expect, describe, afterEach } from "bun:test";
import { createSrtRuntime } from "../../packages/deerbox/src/index";
import { resolveSymlinkTargets } from "../../packages/deerbox/src/sandbox/srt";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
```

- [ ] **Step 2: Add the unit tests for `resolveSymlinkTargets` at the end of the file**

```typescript
describe("resolveSymlinkTargets", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-sym-"));
    tmpDirs.push(d);
    return d;
  }

  test("resolves symlinks in root dir", async () => {
    const claudeDir = await makeTmpDir();
    const target = await makeTmpDir();
    await symlink(target, join(claudeDir, "my-skill"));

    const result = resolveSymlinkTargets(claudeDir);
    expect(result).toContain(target);
  });

  test("resolves symlinks in immediate subdirectories", async () => {
    const claudeDir = await makeTmpDir();
    const subdir = join(claudeDir, "skills");
    await mkdir(subdir);
    const target = await makeTmpDir();
    await symlink(target, join(subdir, "my-skill"));

    const result = resolveSymlinkTargets(claudeDir);
    expect(result).toContain(target);
  });

  test("does not recurse deeper than one level", async () => {
    const claudeDir = await makeTmpDir();
    const subdir = join(claudeDir, "skills");
    const subsubdir = join(subdir, "nested");
    await mkdir(subsubdir, { recursive: true });
    const target = await makeTmpDir();
    await symlink(target, join(subsubdir, "deep-link"));

    const result = resolveSymlinkTargets(claudeDir);
    expect(result).not.toContain(target);
  });

  test("skips non-symlinks", async () => {
    const claudeDir = await makeTmpDir();
    await writeFile(join(claudeDir, "regular-file"), "hello");
    await mkdir(join(claudeDir, "regular-dir"));

    const result = resolveSymlinkTargets(claudeDir);
    expect(result).toHaveLength(0);
  });

  test("returns empty array when directory does not exist", () => {
    const result = resolveSymlinkTargets("/nonexistent/path/that/cannot/exist");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 3: Add an integration test using injectable `home`**

Add this describe block after the `resolveSymlinkTargets` block:

```typescript
describe("srt settings - symlink targets in allowed dirs are reachable", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-sym-int-"));
    tmpDirs.push(d);
    return d;
  }

  test("symlink targets within home are excluded from denyRead", async () => {
    // Build a fake home dir:
    //   <home>/.external-data/     <- would normally be denied
    //   <home>/.claude/skills/my-skill -> <home>/.external-data/
    const home = await makeTmpDir();
    const externalData = join(home, ".external-data");
    await mkdir(externalData);
    const claudeSkillsDir = join(home, ".claude", "skills");
    await mkdir(claudeSkillsDir, { recursive: true });
    await symlink(externalData, join(claudeSkillsDir, "my-skill"));

    // Set up a minimal worktree dir
    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskDir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;

    // The symlink target should not be denied
    expect(denyRead).not.toContain(externalData);
    // The .external-data name itself (as a home child) should not be denied
    const denied = denyRead.some((p) => p === externalData || p.startsWith(externalData + "/"));
    expect(denied).toBe(false);
  });

  test("symlinks in agents and commands subdirs are also resolved", async () => {
    const home = await makeTmpDir();
    const agentTarget = join(home, ".my-agents");
    const commandTarget = join(home, ".my-commands");
    await mkdir(agentTarget);
    await mkdir(commandTarget);
    await mkdir(join(home, ".claude", "agents"), { recursive: true });
    await mkdir(join(home, ".claude", "commands"), { recursive: true });
    await symlink(agentTarget, join(home, ".claude", "agents", "my-agent"));
    await symlink(commandTarget, join(home, ".claude", "commands", "my-cmd"));

    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskDir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;

    expect(denyRead).not.toContain(agentTarget);
    expect(denyRead).not.toContain(commandTarget);
  });
});
```

- [ ] **Step 4: Run the tests to confirm they fail**

```bash
cd /path/to/worktree && bun test test/sandbox/srt-settings.test.ts 2>&1 | head -40
```

Expected: failures on `resolveSymlinkTargets` import (not exported) and `createSrtRuntime({ home })` signature mismatch.

---

### Task 2: Implement `resolveSymlinkTargets` and injectable `home`

**Files:**
- Modify: `packages/deerbox/src/sandbox/srt.ts`

- [ ] **Step 1: Export `resolveSymlinkTargets(dir)` replacing `resolveSkillSymlinkTargets()`**

Replace the entire `resolveSkillSymlinkTargets` function (lines 108–134) with:

```typescript
/**
 * Resolve real filesystem paths behind symlinks within a directory tree.
 *
 * Scans `dir` and all of its immediate subdirectories for symlinks and
 * returns their resolved real paths. This ensures tools (skills, agents,
 * commands, or any other extension) symlinked from within ~/.claude/ to
 * paths outside ~/.claude/ are included in the sandbox's allowed paths.
 *
 * @param dir - Root directory to scan (typically ~/.claude)
 */
export function resolveSymlinkTargets(dir: string): string[] {
  const paths: string[] = [];

  function scanDir(scanPath: string, recurse: boolean): void {
    try {
      const entries = readdirSync(scanPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          try {
            paths.push(realpathSync(join(scanPath, entry.name)));
          } catch {
            // Unresolvable symlink — skip
          }
        } else if (recurse && entry.isDirectory()) {
          scanDir(join(scanPath, entry.name), false);
        }
      }
    } catch {
      // Unreadable or nonexistent directory — skip
    }
  }

  scanDir(dir, true);
  return paths;
}
```

- [ ] **Step 2: Add `home` parameter to `buildHomeDenyList`**

Change the signature and replace usages of the module-level `HOME` constant:

```typescript
function buildHomeDenyList(requiredPaths: string[], home: string): string[] {
  const homePrefix = home.endsWith("/") ? home : home + "/";
  const requiredRoots = new Set<string>();
  for (const p of requiredPaths) {
    if (p.startsWith(homePrefix)) {
      const rel = p.slice(homePrefix.length);
      const root = rel.split("/")[0];
      if (root) requiredRoots.add(root);
    }
  }

  try {
    const entries = readdirSync(home);
    return entries
      .filter((name) => !name.startsWith(".claude") && name !== ".mcp.json" && !requiredRoots.has(name))
      .map((name) => join(home, name));
  } catch {
    return [
      join(home, ".ssh"),
      join(home, ".aws"),
      join(home, ".azure"),
      join(home, ".config"),
      join(home, ".docker"),
      join(home, ".kube"),
      join(home, ".npmrc"),
      join(home, ".pypirc"),
      join(home, ".git-credentials"),
    ].filter((p) => {
      const name = p.slice(homePrefix.length).split("/")[0];
      return !requiredRoots.has(name ?? "");
    });
  }
}
```

- [ ] **Step 3: Add `home` parameter to `buildSrtSettings` and update all usages**

Change the signature and replace `HOME` with `home` throughout:

```typescript
function buildSrtSettings(options: SandboxRuntimeOptions, srtBinDir: string | null, home: string): Record<string, unknown> {
  const claudeDir = join(home, ".claude");

  // ... (network section unchanged) ...

  const requiredPaths = [
    options.worktreePath,
    dirname(options.worktreePath),
    ...(options.repoGitDir ? [options.repoGitDir] : []),
    ...(process.env.PATH?.split(":").filter((p) => p.startsWith(home)) ?? []),
    ...(srtBinDir ? [srtBinDir] : []),
    ...(options.extraReadPaths ?? []),
    ...resolveSymlinkTargets(claudeDir),
  ];

  const denyRead = buildHomeDenyList(requiredPaths, home);

  return {
    // ... filesystem section uses `claudeDir` and `home` instead of `HOME` ...
    filesystem: {
      denyRead,
      allowWrite: [
        options.worktreePath,
        ...gitWritePaths,
        claudeDir,
        join(home, ".claude.json"),
        "/tmp",
        "/private/tmp",
        ...(options.extraWritePaths ?? []),
      ],
      denyWrite: [],
    },
    allowPty: true,
  };
}
```

- [ ] **Step 4: Add optional `home` parameter to `createSrtRuntime` and thread it through**

```typescript
export function createSrtRuntime(opts?: { home?: string }): SandboxRuntime {
  const home = opts?.home ?? HOME;
  const srtBin = resolveSrtBin();
  const srtBinDir = srtBin === "srt" ? null : dirname(dirname(srtBin));
  let settingsPath = "";

  return {
    name: "srt",

    async prepare(options: SandboxRuntimeOptions): Promise<SandboxCleanup> {
      const settings = buildSrtSettings(options, srtBinDir, home);
      settingsPath = join(dirname(options.worktreePath), "srt-settings.json");
      await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
      return () => {};
    },

    buildCommand(options: SandboxRuntimeOptions, innerCommand: string[]): string[] {
      const { worktreePath, env } = options;
      const envExports: string[] = [];

      if (env) {
        for (const [key, value] of Object.entries(env)) {
          envExports.push(`export ${key}=${shellq(value)}`);
        }
      }

      envExports.push(`export HOME=${shellq(home)}`);
      envExports.push("unset CLAUDECODE");

      if (process.env.PATH) {
        envExports.push(`export PATH=${shellq(process.env.PATH)}`);
      }
      envExports.push(`export TERM=${shellq(process.env.TERM ?? "xterm-256color")}`);

      const escapedInner = innerCommand.map(shellq).join(" ");
      const shellCmd = `${envExports.join("; ")}; cd ${shellq(worktreePath)} && exec ${escapedInner}`;

      return [srtBin, "-s", settingsPath, "-c", shellCmd];
    },
  };
}
```

- [ ] **Step 5: Update the comment on the `requiredPaths` block**

Change (lines ~174–185):

```typescript
  // Collect paths that must stay readable: worktree, repo .git dir,
  // PATH entries under HOME, the deer data dir (worktree parent), and
  // real paths behind any symlinks within ~/.claude/ so that tools
  // symlinked from external locations remain accessible in the sandbox.
  const requiredPaths = [
```

- [ ] **Step 6: Run the tests**

```bash
bun test test/sandbox/srt-settings.test.ts 2>&1
```

Expected: all tests pass.

- [ ] **Step 7: Run the full test suite to check for regressions**

```bash
bun test 2>&1 | tail -20
```

Expected: all pre-existing tests continue to pass.

- [ ] **Step 8: Commit**

```bash
git add packages/deerbox/src/sandbox/srt.ts test/sandbox/srt-settings.test.ts
git commit -m "refactor(srt): generalize symlink resolution and make home injectable for tests"
```

---

## Self-Review

**Spec coverage:**
- ✅ Symlinks within any `~/.claude/` subdirectory resolved (not just `skills/`)
- ✅ `home` injectable via `createSrtRuntime({ home })` — no real FS access in tests
- ✅ `resolveSymlinkTargets` exported for direct unit testing
- ✅ Tests cover: root symlinks, subdir symlinks, no deep recursion, non-symlinks, nonexistent dir
- ✅ Integration tests verify denyRead excludes symlink targets

**Placeholder scan:** None found.

**Type consistency:** `createSrtRuntime(opts?: { home?: string })` used consistently. `resolveSymlinkTargets(dir: string): string[]` exported and matches test import. `buildHomeDenyList(requiredPaths, home)` and `buildSrtSettings(options, srtBinDir, home)` signatures match their callsites.
