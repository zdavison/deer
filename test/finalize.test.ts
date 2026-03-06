import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ensureDeerEmojiPrefix, findPRTemplate } from "../src/git/finalize";

describe("ensureDeerEmojiPrefix", () => {
  test("adds deer emoji to plain title", () => {
    expect(ensureDeerEmojiPrefix("Fix login redirect loop")).toBe("🦌 Fix login redirect loop");
  });

  test("does not double-add deer emoji", () => {
    expect(ensureDeerEmojiPrefix("🦌 Fix login redirect loop")).toBe("🦌 Fix login redirect loop");
  });

  test("handles empty string", () => {
    expect(ensureDeerEmojiPrefix("")).toBe("🦌 ");
  });

  test("handles title that already starts with emoji and space", () => {
    expect(ensureDeerEmojiPrefix("🦌 Add user search endpoint")).toBe("🦌 Add user search endpoint");
  });
});

describe("findPRTemplate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no template exists", async () => {
    expect(await findPRTemplate(tmpDir)).toBeNull();
  });

  test("finds .github/PULL_REQUEST_TEMPLATE.md", async () => {
    await mkdir(join(tmpDir, ".github"));
    await writeFile(join(tmpDir, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Summary\n\n## Changes\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Summary\n\n## Changes\n");
  });

  test("finds .github/pull_request_template.md (lowercase)", async () => {
    await mkdir(join(tmpDir, ".github"));
    await writeFile(join(tmpDir, ".github", "pull_request_template.md"), "## Description\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Description\n");
  });

  test("finds docs/pull_request_template.md", async () => {
    await mkdir(join(tmpDir, "docs"));
    await writeFile(join(tmpDir, "docs", "pull_request_template.md"), "## Docs template\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Docs template\n");
  });

  test("finds pull_request_template.md at root", async () => {
    await writeFile(join(tmpDir, "pull_request_template.md"), "## Root template\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Root template\n");
  });

  test("finds first file in .github/PULL_REQUEST_TEMPLATE/ directory", async () => {
    await mkdir(join(tmpDir, ".github", "PULL_REQUEST_TEMPLATE"), { recursive: true });
    await writeFile(join(tmpDir, ".github", "PULL_REQUEST_TEMPLATE", "feature.md"), "## Feature template\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Feature template\n");
  });

  test("prefers .github/PULL_REQUEST_TEMPLATE.md over docs/pull_request_template.md", async () => {
    await mkdir(join(tmpDir, ".github"));
    await mkdir(join(tmpDir, "docs"));
    await writeFile(join(tmpDir, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Primary\n");
    await writeFile(join(tmpDir, "docs", "pull_request_template.md"), "## Secondary\n");
    expect(await findPRTemplate(tmpDir)).toBe("## Primary\n");
  });
});
