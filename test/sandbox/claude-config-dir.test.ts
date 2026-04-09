/**
 * Tests for setupClaudeConfigDir — the function that creates a per-task
 * isolated Claude config directory from a curated subset of ~/.claude.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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

  test("copies agents directory recursively when it exists", async () => {
    const home = await makeHome();
    const claudeDir = join(home, ".claude");
    await mkdir(join(claudeDir, "agents"), { recursive: true });
    await writeFile(join(claudeDir, "agents", "my-agent.md"), "# Agent");

    const taskDir = await makeTaskDir();
    const claudeConfigDir = join(taskDir, "claude-config");
    await setupClaudeConfigDir(claudeConfigDir, home);

    const content = await readFile(join(claudeConfigDir, "agents", "my-agent.md"), "utf-8");
    expect(content).toBe("# Agent");
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

  test("does not create .claude.json in claude-config dir when ~/.claude.json is absent", async () => {
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
