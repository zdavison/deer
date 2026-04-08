import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRiskyEnvVars,
  loadEnvPolicy,
  saveEnvPolicy,
  getUnreviewedRiskyVars,
  applyEnvPolicy,
} from "../packages/shared/src/env-check";

// ── detectRiskyEnvVars ────────────────────────────────────────────────

describe("detectRiskyEnvVars", () => {
  test("flags vars ending in _KEY", () => {
    const risky = detectRiskyEnvVars({ MY_API_KEY: "some-value" });
    expect(risky.map((r) => r.key)).toContain("MY_API_KEY");
  });

  test("flags vars ending in _TOKEN", () => {
    const risky = detectRiskyEnvVars({ GITHUB_TOKEN: "ghp_abc123" });
    expect(risky.map((r) => r.key)).toContain("GITHUB_TOKEN");
  });

  test("flags vars ending in _SECRET", () => {
    const risky = detectRiskyEnvVars({ DB_SECRET: "shhh" });
    expect(risky.map((r) => r.key)).toContain("DB_SECRET");
  });

  test("flags vars ending in _PASSWORD", () => {
    const risky = detectRiskyEnvVars({ DATABASE_PASSWORD: "hunter2" });
    expect(risky.map((r) => r.key)).toContain("DATABASE_PASSWORD");
  });

  test("flags vars ending in _PASS", () => {
    const risky = detectRiskyEnvVars({ DB_PASS: "hunter2" });
    expect(risky.map((r) => r.key)).toContain("DB_PASS");
  });

  test("flags vars ending in _PWD (password)", () => {
    const risky = detectRiskyEnvVars({ DB_PWD: "hunter2" });
    expect(risky.map((r) => r.key)).toContain("DB_PWD");
  });

  test("flags vars containing CREDENTIAL", () => {
    const risky = detectRiskyEnvVars({ AWS_CREDENTIAL: "val" });
    expect(risky.map((r) => r.key)).toContain("AWS_CREDENTIAL");
  });

  test("flags vars containing OAUTH", () => {
    const risky = detectRiskyEnvVars({ SLACK_OAUTH_TOKEN: "xoxb-123" });
    expect(risky.map((r) => r.key)).toContain("SLACK_OAUTH_TOKEN");
  });

  test("flags vars ending in _CERT", () => {
    const risky = detectRiskyEnvVars({ TLS_CERT: "---BEGIN---" });
    expect(risky.map((r) => r.key)).toContain("TLS_CERT");
  });

  test("flags vars with known secret value prefixes", () => {
    const risky = detectRiskyEnvVars({ MY_VAR: "ghp_abc123verylongtoken" });
    expect(risky.map((r) => r.key)).toContain("MY_VAR");
  });

  test("flags sk- prefixed values", () => {
    const risky = detectRiskyEnvVars({ SOME_VAR: "sk-abc123" });
    expect(risky.map((r) => r.key)).toContain("SOME_VAR");
  });

  test("flags xoxb- prefixed values (Slack bot tokens)", () => {
    const risky = detectRiskyEnvVars({ SLACK_BOT: "xoxb-abc123" });
    expect(risky.map((r) => r.key)).toContain("SLACK_BOT");
  });

  test("does not flag ANTHROPIC_API_KEY (proxy-managed)", () => {
    const risky = detectRiskyEnvVars({ ANTHROPIC_API_KEY: "sk-ant-xxx" });
    expect(risky.map((r) => r.key)).not.toContain("ANTHROPIC_API_KEY");
  });

  test("does not flag CLAUDE_CODE_OAUTH_TOKEN (proxy-managed)", () => {
    const risky = detectRiskyEnvVars({ CLAUDE_CODE_OAUTH_TOKEN: "tok_xxx" });
    expect(risky.map((r) => r.key)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("does not flag PATH", () => {
    const risky = detectRiskyEnvVars({ PATH: "/usr/bin:/bin" });
    expect(risky).toHaveLength(0);
  });

  test("does not flag HOME", () => {
    const risky = detectRiskyEnvVars({ HOME: "/home/user" });
    expect(risky).toHaveLength(0);
  });

  test("does not flag SHELL", () => {
    const risky = detectRiskyEnvVars({ SHELL: "/bin/bash" });
    expect(risky).toHaveLength(0);
  });

  test("does not flag empty values", () => {
    const risky = detectRiskyEnvVars({ MY_API_KEY: "" });
    expect(risky).toHaveLength(0);
  });

  test("does not flag undefined values", () => {
    const risky = detectRiskyEnvVars({ MY_API_KEY: undefined });
    expect(risky).toHaveLength(0);
  });

  test("does not flag XDG_ vars", () => {
    const risky = detectRiskyEnvVars({ XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(risky).toHaveLength(0);
  });

  test("does not flag LC_ vars", () => {
    const risky = detectRiskyEnvVars({ LC_ALL: "en_US.UTF-8" });
    expect(risky).toHaveLength(0);
  });

  test("does not flag DEER_ vars", () => {
    const risky = detectRiskyEnvVars({ DEER_SOME_VAR: "value" });
    expect(risky).toHaveLength(0);
  });

  test("sorts results alphabetically by key", () => {
    const risky = detectRiskyEnvVars({
      Z_API_KEY: "val",
      A_TOKEN: "val",
      M_SECRET: "val",
    });
    expect(risky.map((r) => r.key)).toEqual(["A_TOKEN", "M_SECRET", "Z_API_KEY"]);
  });

  test("truncates long values in displayValue", () => {
    const risky = detectRiskyEnvVars({ MY_SECRET: "a".repeat(50) });
    expect(risky[0].displayValue.length).toBeLessThanOrEqual(23); // "aaa..." format
    expect(risky[0].displayValue).toContain("...");
  });

  test("shows short values without truncation", () => {
    const risky = detectRiskyEnvVars({ MY_SECRET: "short" });
    expect(risky[0].displayValue).toBe("sho...");
  });

  test("masks all but first 3 chars in displayValue", () => {
    const risky = detectRiskyEnvVars({ MY_SECRET: "abcdefghij" });
    expect(risky[0].displayValue).toBe("abc...");
  });

  test("each result has a reason string", () => {
    const risky = detectRiskyEnvVars({ SOME_TOKEN: "val" });
    expect(risky[0].reason).toBeTruthy();
  });
});

// ── loadEnvPolicy ─────────────────────────────────────────────────────

describe("loadEnvPolicy", () => {
  test("returns empty policy when file doesn't exist", () => {
    const policy = loadEnvPolicy("/nonexistent/path/env-policy.json");
    expect(policy).toEqual({ blocked: [], approved: [] });
  });

  test("parses valid policy file", () => {
    const dir = mkdtempSync(join(tmpdir(), "deer-env-test-"));
    try {
      const policyPath = join(dir, "env-policy.json");
      writeFileSync(
        policyPath,
        JSON.stringify({ blocked: ["SECRET_KEY"], approved: ["SAFE_VAR"] }),
      );
      const policy = loadEnvPolicy(policyPath);
      expect(policy.blocked).toEqual(["SECRET_KEY"]);
      expect(policy.approved).toEqual(["SAFE_VAR"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty policy on malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "deer-env-test-"));
    try {
      const policyPath = join(dir, "env-policy.json");
      writeFileSync(policyPath, "not json");
      const policy = loadEnvPolicy(policyPath);
      expect(policy).toEqual({ blocked: [], approved: [] });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty arrays for missing array fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "deer-env-test-"));
    try {
      const policyPath = join(dir, "env-policy.json");
      writeFileSync(policyPath, JSON.stringify({ other: "field" }));
      const policy = loadEnvPolicy(policyPath);
      expect(policy.blocked).toEqual([]);
      expect(policy.approved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── saveEnvPolicy + loadEnvPolicy roundtrip ───────────────────────────

describe("saveEnvPolicy + loadEnvPolicy roundtrip", () => {
  test("saves and reloads policy correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deer-env-test-"));
    try {
      const policyPath = join(dir, "env-policy.json");
      const policy = { blocked: ["A_KEY", "B_TOKEN"], approved: ["C_SAFE"] };
      await saveEnvPolicy(policy, policyPath);
      const loaded = loadEnvPolicy(policyPath);
      expect(loaded).toEqual(policy);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("creates parent directories if they don't exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deer-env-test-"));
    try {
      const policyPath = join(dir, "sub", "dir", "env-policy.json");
      await saveEnvPolicy({ blocked: [], approved: [] }, policyPath);
      const loaded = loadEnvPolicy(policyPath);
      expect(loaded).toEqual({ blocked: [], approved: [] });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── getUnreviewedRiskyVars ────────────────────────────────────────────

describe("getUnreviewedRiskyVars", () => {
  const makeVar = (key: string) => ({ key, displayValue: "abc...", reason: "token" });

  test("returns all vars when policy is empty", () => {
    const risky = [makeVar("A_KEY"), makeVar("B_TOKEN")];
    const unreviewed = getUnreviewedRiskyVars(risky, { blocked: [], approved: [] });
    expect(unreviewed).toHaveLength(2);
  });

  test("excludes vars in approved list", () => {
    const risky = [makeVar("A_KEY"), makeVar("B_TOKEN")];
    const unreviewed = getUnreviewedRiskyVars(risky, { blocked: [], approved: ["A_KEY"] });
    expect(unreviewed.map((v) => v.key)).toEqual(["B_TOKEN"]);
  });

  test("excludes vars in blocked list", () => {
    const risky = [makeVar("A_KEY"), makeVar("B_TOKEN")];
    const unreviewed = getUnreviewedRiskyVars(risky, { blocked: ["A_KEY"], approved: [] });
    expect(unreviewed.map((v) => v.key)).toEqual(["B_TOKEN"]);
  });

  test("returns empty when all vars are reviewed", () => {
    const risky = [makeVar("A_KEY")];
    const unreviewed = getUnreviewedRiskyVars(risky, { blocked: ["A_KEY"], approved: [] });
    expect(unreviewed).toHaveLength(0);
  });

  test("returns empty when risky list is empty", () => {
    const unreviewed = getUnreviewedRiskyVars([], { blocked: [], approved: [] });
    expect(unreviewed).toHaveLength(0);
  });
});

// ── applyEnvPolicy ────────────────────────────────────────────────────

describe("applyEnvPolicy", () => {
  test("removes blocked vars from env", () => {
    const env: Record<string, string> = { MY_KEY: "secret", SAFE_VAR: "value" };
    applyEnvPolicy(env, { blocked: ["MY_KEY"], approved: [] });
    expect(env).toEqual({ SAFE_VAR: "value" });
  });

  test("does not remove approved vars", () => {
    const env: Record<string, string> = { MY_KEY: "secret" };
    applyEnvPolicy(env, { blocked: [], approved: ["MY_KEY"] });
    expect(env).toEqual({ MY_KEY: "secret" });
  });

  test("ignores blocked keys not present in env", () => {
    const env: Record<string, string> = { SAFE_VAR: "value" };
    applyEnvPolicy(env, { blocked: ["MISSING_KEY"], approved: [] });
    expect(env).toEqual({ SAFE_VAR: "value" });
  });

  test("removes multiple blocked vars", () => {
    const env: Record<string, string> = { A: "1", B: "2", C: "3" };
    applyEnvPolicy(env, { blocked: ["A", "C"], approved: [] });
    expect(env).toEqual({ B: "2" });
  });

  test("leaves env unchanged when policy is empty", () => {
    const env: Record<string, string> = { MY_KEY: "secret" };
    applyEnvPolicy(env, { blocked: [], approved: [] });
    expect(env).toEqual({ MY_KEY: "secret" });
  });
});
