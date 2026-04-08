# Per-task CLAUDE_CONFIG_DIR Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each sandboxed deerbox session its own isolated `~/.claude` directory via `CLAUDE_CONFIG_DIR`, so the sandbox never reads or writes the host `~/.claude`.

**Architecture:** A new `setupClaudeConfigDir()` function in `session.ts` creates a per-task `claude-config/` directory, copies curated files from `~/.claude` (and a redacted `~/.claude.json`), then injects `CLAUDE_CONFIG_DIR` into the sandbox env. `srt.ts` is updated to remove the old `.claude*` home-deny-list exception and redirect all allow/deny rules to the per-task dir.

**Tech Stack:** Bun, TypeScript, `node:fs/promises` (`cp`, `mkdir`, `access`), bun:test

---

## File Map

| Action   | Path                                         | Change                                                |
|----------|----------------------------------------------|-------------------------------------------------------|
| Modify   | `packages/deerbox/src/sandbox/runtime.ts`    | Add optional `claudeConfigDir` field to `SandboxRuntimeOptions` |
| Modify   | `packages/deerbox/src/session.ts`            | Add `setupClaudeConfigDir()`, call in `prepare()`, add `CLAUDE_CONFIG_DIR` to env, pass `claudeConfigDir` in runtimeOpts |
| Modify   | `packages/deerbox/src/sandbox/srt.ts`        | Remove `.claude*` exception, update allow/deny lists, use `options.claudeConfigDir` |
| Create   | `test/sandbox/claude-config-dir.test.ts`     | Tests for `setupClaudeConfigDir()`                    |
| Modify   | `test/sandbox/srt-settings.test.ts`          | Update stale assertions + add new behavior tests      |

---

### Task 0: Add `claudeConfigDir` to `SandboxRuntimeOptions`

**Files:**
- Modify: `packages/deerbox/src/sandbox/runtime.ts`

This must happen first because both `session.ts` and `srt.ts` depend on the new field.

- [ ] **Step 1: Add the field to the interface**

In `SandboxRuntimeOptions`, after the `mitmProxy` field, add:

```typescript
  /**
   * Path to the per-task Claude config directory to use as CLAUDE_CONFIG_DIR.
   * If omitted, srt.ts falls back to `<dirname(worktreePath)>/claude-config`.
   * Always set this explicitly from session.ts to handle reuseWorktree correctly.
   * @example "/home/user/.local/share/deer/tasks/deer_abc123/claude-config"
   */
  claudeConfigDir?: string;
```

- [ ] **Step 2: Run the existing tests to confirm nothing broke**

```bash
bun test test/sandbox/srt-settings.test.ts 2>&1 | tail -5
```

Expected: 9 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add packages/deerbox/src/sandbox/runtime.ts
git commit -m "feat: add claudeConfigDir to SandboxRuntimeOptions"
```

---

### Task 1: Write failing tests for `setupClaudeConfigDir`

**Files:**
- Create: `test/sandbox/claude-config-dir.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * Tests for setupClaudeConfigDir — the function that creates a per-task
 * isolated Claude config directory from a curated subset of ~/.claude.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupClaudeConfigDir } from "../../packages/deerbox/src/session";

describe("setupClaudeConfigDir", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeHome(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-claude-cfg-test-"));
    tmpDirs.push(d);
    return d;
  }

  async function makeTaskDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-task-test-"));
    tmpDirs.push(d);
    return d;
  }

  test("creates the claude-config directory", async () => {
    const home = await makeHome();
    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");

    await setupClaudeConfigDir(claudeConfigDir, home);

    const { stat } = await import("node:fs/promises");
    const s = await stat(claudeConfigDir);
    expect(s.isDirectory()).toBe(true);
  });

  test("copies CLAUDE.md when it exists", async () => {
    const home = await makeHome();
    const claudeDir = join(home, ".claude");
    await mkdir(claudeDir);
    await writeFile(join(claudeDir, "CLAUDE.md"), "# My instructions");

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = await readFile(join(claudeConfigDir, "CLAUDE.md"), "utf-8");
    expect(content).toBe("# My instructions");
  });

  test("copies settings.json when it exists", async () => {
    const home = await makeHome();
    const claudeDir = join(home, ".claude");
    await mkdir(claudeDir);
    const settings = { theme: "dark", model: "sonnet" };
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settings));

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = JSON.parse(await readFile(join(claudeConfigDir, "settings.json"), "utf-8"));
    expect(content).toEqual(settings);
  });

  test("copies settings.local.json when it exists", async () => {
    const home = await makeHome();
    const claudeDir = join(home, ".claude");
    await mkdir(claudeDir);
    await writeFile(join(claudeDir, "settings.local.json"), JSON.stringify({ localPref: true }));

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = JSON.parse(await readFile(join(claudeConfigDir, "settings.local.json"), "utf-8"));
    expect(content).toEqual({ localPref: true });
  });

  test("copies plugins directory recursively when it exists", async () => {
    const home = await makeHome();
    const claudeDir = join(home, ".claude");
    await mkdir(join(claudeDir, "plugins", "my-plugin"), { recursive: true });
    await writeFile(join(claudeDir, "plugins", "my-plugin", "index.ts"), "export default {}");

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = await readFile(join(claudeConfigDir, "plugins", "my-plugin", "index.ts"), "utf-8");
    expect(content).toBe("export default {}");
  });

  test("copies skills directory recursively when it exists", async () => {
    const home = await makeHome();
    const claudeDir = join(home, ".claude");
    await mkdir(join(claudeDir, "skills"), { recursive: true });
    await writeFile(join(claudeDir, "skills", "my-skill.md"), "# Skill");

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = await readFile(join(claudeConfigDir, "skills", "my-skill.md"), "utf-8");
    expect(content).toBe("# Skill");
  });

  test("copies commands directory recursively when it exists", async () => {
    const home = await makeHome();
    const claudeDir = join(home, ".claude");
    await mkdir(join(claudeDir, "commands"), { recursive: true });
    await writeFile(join(claudeDir, "commands", "deploy.md"), "# Deploy");

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = await readFile(join(claudeConfigDir, "commands", "deploy.md"), "utf-8");
    expect(content).toBe("# Deploy");
  });

  test("copies hooks directory recursively when it exists", async () => {
    const home = await makeHome();
    const claudeDir = join(home, ".claude");
    await mkdir(join(claudeDir, "hooks"), { recursive: true });
    await writeFile(join(claudeDir, "hooks", "pre-commit.sh"), "#!/bin/sh");

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = await readFile(join(claudeConfigDir, "hooks", "pre-commit.sh"), "utf-8");
    expect(content).toBe("#!/bin/sh");
  });

  test("skips items that do not exist in ~/.claude without error", async () => {
    const home = await makeHome();
    // No ~/.claude directory at all
    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");

    // Should not throw
    await expect(setupClaudeConfigDir(claudeConfigDir, home)).resolves.toBeUndefined();
  });

  test("copies and redacts ~/.claude.json — strips oauthToken and apiKey", async () => {
    const home = await makeHome();
    const claudeJson = {
      oauthToken: "secret-oauth-token",
      apiKey: "sk-ant-secret-key",
      model: "claude-sonnet",
      theme: "dark",
    };
    await writeFile(join(home, ".claude.json"), JSON.stringify(claudeJson));

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = JSON.parse(await readFile(join(claudeConfigDir, ".claude.json"), "utf-8"));
    expect(content.oauthToken).toBeUndefined();
    expect(content.apiKey).toBeUndefined();
    expect(content.model).toBe("claude-sonnet");
    expect(content.theme).toBe("dark");
  });

  test("creates .claude.json in claude-config dir even when ~/.claude.json is absent", async () => {
    const home = await makeHome();
    // No ~/.claude.json

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    // Should not throw; .claude.json simply not created
    const { access } = await import("node:fs/promises");
    const exists = await access(join(claudeConfigDir, ".claude.json")).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
cd /path/to/worktree && bun test test/sandbox/claude-config-dir.test.ts 2>&1 | tail -20
```

Expected: all tests fail with `"setupClaudeConfigDir" is not exported from session`

---

### Task 2: Implement `setupClaudeConfigDir` in `session.ts`

**Files:**
- Modify: `packages/deerbox/src/session.ts`

- [ ] **Step 1: Add the import at the top of session.ts**

Add to the existing imports block (after `import { join, dirname, resolve } from "node:path";`):

```typescript
import { mkdir, cp, access, readFile, writeFile } from "node:fs/promises";
```

- [ ] **Step 2: Add `setupClaudeConfigDir` function before the `prepare` function**

Insert after the `PreparedSession` type block and before the `// ── Implementation ───` comment:

```typescript
/**
 * Items to copy from ~/.claude into the per-task claude config dir.
 * Directories are copied recursively; files are copied as-is.
 * All are sourced from the ~/.claude directory.
 */
const CLAUDE_DIR_ITEMS: Array<{ name: string; isDir: boolean }> = [
  { name: "CLAUDE.md", isDir: false },
  { name: "settings.json", isDir: false },
  { name: "settings.local.json", isDir: false },
  { name: "commands", isDir: true },
  { name: "plugins", isDir: true },
  { name: "skills", isDir: true },
  { name: "hooks", isDir: true },
];

/**
 * Create a per-task Claude config directory populated with a curated,
 * read-safe copy of ~/.claude content.
 *
 * Directories are copied recursively. ~/.claude.json is copied with
 * oauthToken and apiKey fields stripped, since auth is handled by the
 * host-side MITM proxy and credentials must never enter the sandbox.
 *
 * Items absent from ~/.claude are silently skipped.
 *
 * @param claudeConfigDir - Absolute path to the per-task claude config dir to create
 * @param home - The user's home directory
 */
export async function setupClaudeConfigDir(claudeConfigDir: string, home: string): Promise<void> {
  await mkdir(claudeConfigDir, { recursive: true });

  const sourceClaudeDir = join(home, ".claude");

  for (const item of CLAUDE_DIR_ITEMS) {
    const src = join(sourceClaudeDir, item.name);
    const dst = join(claudeConfigDir, item.name);
    const exists = await access(src).then(() => true).catch(() => false);
    if (!exists) continue;
    await cp(src, dst, { recursive: item.isDir });
  }

  // Copy ~/.claude.json with credentials stripped
  const hostClaudeJson = join(home, ".claude.json");
  const hasClaudeJson = await access(hostClaudeJson).then(() => true).catch(() => false);
  if (hasClaudeJson) {
    const raw = await readFile(hostClaudeJson, "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable — skip rather than crash the session
      return;
    }
    delete parsed.oauthToken;
    delete parsed.apiKey;
    await writeFile(join(claudeConfigDir, ".claude.json"), JSON.stringify(parsed, null, 2));
  }
}
```

- [ ] **Step 3: Call `setupClaudeConfigDir` in `prepare()` and inject `CLAUDE_CONFIG_DIR`**

In `prepare()`, locate the `onStatus?.("Starting sandbox...");` line. Just before it, add the claude config dir setup:

```typescript
  const claudeConfigDir = join(dataDir(), "tasks", taskId, "claude-config");
  await setupClaudeConfigDir(claudeConfigDir, HOME);

  onStatus?.("Starting sandbox...");
```

Then, in the `sandboxEnvFinal` object, add `CLAUDE_CONFIG_DIR`:

```typescript
  const sandboxEnvFinal: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitconfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    ...(lang !== "en" ? { CLAUDE_CODE_LOCALE: lang } : {}),
    ...placeholderEnv,
    ...sandboxEnv,
  };
```

Then pass `claudeConfigDir` in `runtimeOpts` (locate the `const runtimeOpts = {` block and add the field):

```typescript
  const runtimeOpts = {
    worktreePath,
    repoGitDir: reuseWorktree?.repoGitDir ?? resolve(repoPath, ".git"),
    allowlist: config.network.allowlist,
    extraReadPaths: ecosystemResult.extraReadPaths,
    env: { ...ecosystemResult.env, ...sandboxEnvFinal },
    mitmProxy,
    claudeConfigDir,
  };
```

- [ ] **Step 4: Add missing imports to `session.ts`**

`HOME` is not currently imported in `session.ts`. Add it to the `@deer/shared` import on line 15:

```typescript
import { detectLang, HOME } from "@deer/shared";
```

`mkdir`, `cp`, `access`, `readFile`, `writeFile` are needed for `setupClaudeConfigDir`. Add after the existing `node:path` import:

```typescript
import { mkdir, cp, access, readFile, writeFile } from "node:fs/promises";
```

`dataDir` is already imported from `"./task"` (line 14: `import { generateTaskId, dataDir } from "./task";`) — no change needed.

- [ ] **Step 5: Run the claude-config-dir tests to confirm they pass**

```bash
bun test test/sandbox/claude-config-dir.test.ts 2>&1 | tail -20
```

Expected: all 10 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/deerbox/src/session.ts test/sandbox/claude-config-dir.test.ts
git commit -m "feat: add setupClaudeConfigDir for per-task CLAUDE_CONFIG_DIR isolation"
```

---

### Task 3: Write failing tests for updated SRT settings

**Files:**
- Modify: `test/sandbox/srt-settings.test.ts`

- [ ] **Step 1: Add new test cases at the bottom of the file**

Append a new `describe` block after the last existing one:

```typescript
describe("srt settings - per-task claude config dir isolation", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-claude-cfg-"));
    tmpDirs.push(d);
    return d;
  }

  async function makeSettings(home: string): Promise<Record<string, unknown>> {
    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);
    // Create the claude-config dir that srt.ts will reference
    await mkdir(join(taskDir, "claude-config"));

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskDir, "srt-settings.json");
    return JSON.parse(await readFile(settingsPath, "utf-8"));
  }

  test("~/.claude is denied for reading", async () => {
    const home = await makeTmpDir();
    await mkdir(join(home, ".claude"));

    const settings = await makeSettings(home);
    const denyRead: string[] = settings.filesystem.denyRead;

    expect(denyRead).toContain(join(home, ".claude"));
  });

  test("~/.claude is denied for writing", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const denyWrite: string[] = settings.filesystem.denyWrite;

    expect(denyWrite).toContain(join(home, ".claude"));
  });

  test("~/.claude.json is denied for writing", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const denyWrite: string[] = settings.filesystem.denyWrite;

    expect(denyWrite).toContain(join(home, ".claude.json"));
  });

  test("~/.claude is not in allowWrite", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).not.toContain(join(home, ".claude"));
  });

  test("~/.claude.json is not in allowWrite", async () => {
    const home = await makeTmpDir();
    const settings = await makeSettings(home);
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).not.toContain(join(home, ".claude.json"));
  });

  test("per-task claude-config dir is in allowWrite", async () => {
    const home = await makeTmpDir();
    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);
    await mkdir(join(taskDir, "claude-config"));

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskDir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).toContain(join(taskDir, "claude-config"));
  });

  test("credential files inside claude-config are denied for reading", async () => {
    const home = await makeTmpDir();
    const taskDir = await makeTmpDir();
    const worktreeDir = join(taskDir, "worktree");
    await mkdir(worktreeDir);
    await mkdir(join(taskDir, "claude-config"));

    const runtime = createSrtRuntime({ home });
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(taskDir, "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const denyRead: string[] = settings.filesystem.denyRead;

    expect(denyRead).toContain(join(taskDir, "claude-config", ".credentials.json"));
    expect(denyRead).toContain(join(taskDir, "claude-config", "agent-oauth-token"));
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
bun test test/sandbox/srt-settings.test.ts 2>&1 | grep -E "fail|pass|✗|✓" | tail -20
```

Expected: the new tests fail (old ones still pass).

---

### Task 4: Update `srt.ts` to implement new sandbox rules

**Files:**
- Modify: `packages/deerbox/src/sandbox/srt.ts`

- [ ] **Step 1: Remove the `.claude*` exception from `buildHomeDenyList`**

Current filter line (around line 66):
```typescript
      .filter((name) => !name.startsWith(".claude") && name !== ".mcp.json" && !requiredRoots.has(name))
```

Change to:
```typescript
      .filter((name) => name !== ".mcp.json" && !requiredRoots.has(name))
```

- [ ] **Step 2: Update `buildSrtSettings` to use `options.claudeConfigDir` and remove old claude references**

In `buildSrtSettings`, find the `claudeDir` constant at the top:

```typescript
  const claudeDir = join(home, ".claude");
```

Replace it with:

```typescript
  const claudeConfigDir = options.claudeConfigDir ?? join(dirname(options.worktreePath), "claude-config");
```

(The fallback is for callers — such as tests — that don't pass `claudeConfigDir` explicitly. In production, `session.ts` always passes it.)

- [ ] **Step 3: Remove `resolveSymlinkTargets(claudeDir)` from `requiredPaths`**

Current `requiredPaths` array (around line 186):
```typescript
  const requiredPaths = [
    options.worktreePath,
    dirname(options.worktreePath),
    ...(options.repoGitDir ? [options.repoGitDir] : []),
    ...(process.env.PATH?.split(":").filter((p) => p.startsWith(home)) ?? []),
    ...(srtBinDir ? [srtBinDir] : []),
    ...(options.extraReadPaths ?? []),
    ...resolveSymlinkTargets(claudeDir),
  ];
```

Change to:

```typescript
  const requiredPaths = [
    options.worktreePath,
    dirname(options.worktreePath),
    ...(options.repoGitDir ? [options.repoGitDir] : []),
    ...(process.env.PATH?.split(":").filter((p) => p.startsWith(home)) ?? []),
    ...(srtBinDir ? [srtBinDir] : []),
    ...(options.extraReadPaths ?? []),
  ];
```

- [ ] **Step 4: Update `denyRead` to use `claudeConfigDir` for credential entries**

Current denyRead (around line 198):
```typescript
  const denyRead = [
    ...buildHomeDenyList(requiredPaths, home),
    join(claudeDir, ".credentials.json"),
    join(claudeDir, "agent-oauth-token"),
  ];
```

Change to:

```typescript
  const denyRead = [
    ...buildHomeDenyList(requiredPaths, home),
    join(claudeConfigDir, ".credentials.json"),
    join(claudeConfigDir, "agent-oauth-token"),
  ];
```

- [ ] **Step 5: Update `allowWrite` and add `denyWrite` entries**

Current `allowWrite` inside the returned settings object (around line 211):
```typescript
      allowWrite: [
        options.worktreePath,
        ...gitWritePaths,
        claudeDir,
        join(home, ".claude.json"),
        "/tmp",
        "/private/tmp",
        ...(options.extraWritePaths ?? []),
      ],
      denyWrite: [
        join(claudeDir, ".credentials.json"),
        join(claudeDir, "agent-oauth-token"),
      ],
```

Change to:

```typescript
      allowWrite: [
        options.worktreePath,
        ...gitWritePaths,
        claudeConfigDir,
        "/tmp",
        "/private/tmp",
        ...(options.extraWritePaths ?? []),
      ],
      denyWrite: [
        join(home, ".claude"),
        join(home, ".claude.json"),
      ],
```

- [ ] **Step 6: Run the new srt-settings tests to confirm they pass**

```bash
bun test test/sandbox/srt-settings.test.ts 2>&1 | tail -20
```

Expected: the new tests pass; some old tests fail (we fix those next).

---

### Task 5: Fix existing srt-settings tests that break

**Files:**
- Modify: `test/sandbox/srt-settings.test.ts`

The following existing tests will break after the srt.ts changes:

1. **"allowWrite has no git paths when repoGitDir and .git file are absent"** — its filter excludes `.claude` paths but now `claude-config` appears in `allowWrite`. Update the filter.
2. **"symlink targets within home are excluded from denyRead"** — these tests verified the old behavior where `~/.claude` symlink targets were resolved and excluded from denyRead. That behavior is now gone. Remove or update them.

- [ ] **Step 1: Run all srt-settings tests to see exactly which ones fail**

```bash
bun test test/sandbox/srt-settings.test.ts 2>&1 | grep -E "✗|FAIL|fail" | head -20
```

- [ ] **Step 2: Fix "allowWrite has no git paths when repoGitDir and .git file are absent"**

Find the test (around line 70). Its extra-paths filter currently excludes `.claude`:

```typescript
    const extraPaths = allowWrite.filter(
      (p) =>
        p !== worktreeDir &&
        !p.includes(".claude") &&
        p !== "/tmp" &&
        p !== "/private/tmp"
    );
    expect(extraPaths).toHaveLength(0);
```

The claude-config dir is now in allowWrite. Update the filter to also exclude `claude-config`:

```typescript
    const extraPaths = allowWrite.filter(
      (p) =>
        p !== worktreeDir &&
        !p.includes("claude-config") &&
        p !== "/tmp" &&
        p !== "/private/tmp"
    );
    expect(extraPaths).toHaveLength(0);
```

- [ ] **Step 3: Remove the stale "symlink targets" test group**

The describe block `"srt settings - symlink targets in allowed dirs are reachable"` (around line 158) tests the old behavior where `resolveSymlinkTargets(~/.claude)` ensured external symlink targets weren't denied. That mechanism is removed. Delete the entire describe block (from `describe("srt settings - symlink targets in allowed dirs are reachable", () => {` through its closing `});`).

- [ ] **Step 4: Run all srt-settings tests to confirm all pass**

```bash
bun test test/sandbox/srt-settings.test.ts 2>&1 | tail -10
```

Expected: all tests pass, 0 fail.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
bun test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/deerbox/src/sandbox/srt.ts test/sandbox/srt-settings.test.ts
git commit -m "feat: isolate sandbox from ~/.claude via per-task CLAUDE_CONFIG_DIR"
```
