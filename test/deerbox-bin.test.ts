import { test, expect, describe } from "bun:test";
import { deerboxBin } from "../src/deerbox";

describe("deerboxBin", () => {
  describe("compiled binary mode (isDevMode=false)", () => {
    test("does not return a TypeScript script path", () => {
      // In compiled mode we're running from a dir that contains packages/deerbox/src/cli.ts
      // (the deer repo itself). The old bug: process.execPath + that script = launches deer TUI.
      const result = deerboxBin({ isDevMode: false, argv0: "/some/compiled/deer" });
      expect(result.some((s) => s.endsWith(".ts"))).toBe(false);
    });

    test("returns PATH fallback ['deerbox'] when no sibling binary exists", () => {
      const result = deerboxBin({
        isDevMode: false,
        argv0: "/nonexistent/dir/deer",
      });
      // Should be PATH fallback, not a TypeScript script invocation
      expect(result).toEqual(["deerbox"]);
    });
  });

  describe("dev mode (isDevMode=true)", () => {
    test("returns TypeScript workspace script when running from deer repo", () => {
      // In dev mode, the workspace cli.ts should be found relative to this file's directory
      const result = deerboxBin({ isDevMode: true, argv0: process.argv[0] });
      // Should resolve to [bun, .../packages/deerbox/src/cli.ts]
      expect(result.length).toBe(2);
      expect(result[1]).toMatch(/packages\/deerbox\/src\/cli\.ts$/);
    });
  });
});
