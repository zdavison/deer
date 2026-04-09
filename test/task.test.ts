import { test, expect, describe } from "bun:test";
import { generateTaskId, dataDir } from "../src/task";

describe("generateTaskId", () => {
  test("produces unique IDs across 1000 invocations", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateTaskId());
    }
    expect(ids.size).toBe(1000);
  });

  test("IDs are sortable by creation time", async () => {
    const first = generateTaskId();
    // Small delay to ensure timestamp advances
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = generateTaskId();

    expect(first < second).toBe(true);
  });

  test("IDs match expected format: deer_ prefix + alphanumeric", () => {
    const id = generateTaskId();
    expect(id).toMatch(/^deer_[a-z0-9]+$/);
  });

  test("IDs have the deer_ prefix", () => {
    const id = generateTaskId();
    expect(id.startsWith("deer_")).toBe(true);
  });

  test("IDs are URL-safe (no special characters)", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateTaskId();
      // URL-safe: only alphanumeric, hyphens, underscores
      expect(id).toMatch(/^[a-zA-Z0-9_]+$/);
    }
  });
});

describe("dataDir", () => {
  test("returns expected path under ~/.local/share/deer", () => {
    const dir = dataDir();
    const home = process.env.HOME;
    expect(dir).toBe(`${home}/.local/share/deer`);
  });
});
