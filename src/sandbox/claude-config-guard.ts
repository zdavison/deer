/**
 * Watches ~/.claude for potentially malicious changes made by sandboxed agents.
 *
 * Since nono's claude-code profile grants read-write access to ~/.claude,
 * a compromised agent could inject hooks, modify settings, or tamper with
 * credentials. This module takes a baseline snapshot on startup and watches
 * for changes continuously, emitting alerts when critical files are modified.
 */

import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HOME, CONFIG_GUARD_DEBOUNCE_MS } from "../constants";

// ── Types ────────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "high" | "medium";

export interface ConfigAlert {
  severity: AlertSeverity;
  file: string;
  type: "modified" | "created" | "deleted";
  description: string;
  timestamp: Date;
}

export interface ClaudeConfigGuard {
  /** Current unacknowledged alerts */
  alerts: ConfigAlert[];
  /** Stop watching */
  stop(): void;
}

type ChangeListener = (alert: ConfigAlert) => void;

// ── Watched paths ────────────────────────────────────────────────────

interface WatchedEntry {
  /** Path relative to ~/.claude */
  path: string;
  severity: AlertSeverity;
  description: string;
  /** If true, watch all files in the directory */
  isDir?: boolean;
}

function claudeDir(): string {
  // Read HOME at call time (not from the cached constant) because tests
  // override process.env.HOME after module load.
  return join(process.env.HOME ?? "", ".claude");
}


const WATCHED: WatchedEntry[] = [
  {
    path: "settings.json",
    severity: "critical",
    description: "Settings file (can inject hooks that run arbitrary commands)",
  },
  {
    path: "settings.local.json",
    severity: "high",
    description: "Local settings file",
  },
  {
    path: "CLAUDE.md",
    severity: "critical",
    description: "Global instructions (persistent prompt injection)",
  },
  {
    path: "hooks",
    severity: "critical",
    description: "Hook scripts (arbitrary command execution)",
    isDir: true,
  },
  {
    path: "commands",
    severity: "high",
    description: "Custom slash commands",
    isDir: true,
  },
  {
    path: ".credentials.json",
    severity: "high",
    description: "Auth credentials",
  },
  {
    path: "agent-oauth-token",
    severity: "high",
    description: "OAuth token file",
  },
];

// ── Hashing ──────────────────────────────────────────────────────────

async function hashFile(path: string): Promise<string | null> {
  try {
    const content = await readFile(path);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

async function hashDir(dirPath: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  try {
    const entries = await readdir(dirPath);
    const results = await Promise.all(
      entries.map(async (name) => {
        const fullPath = join(dirPath, name);
        const s = await stat(fullPath).catch(() => null);
        if (!s || !s.isFile()) return null;
        const hash = await hashFile(fullPath);
        return hash ? ([name, hash] as const) : null;
      }),
    );
    for (const r of results) {
      if (r) hashes.set(r[0], r[1]);
    }
  } catch {
    // Directory doesn't exist yet
  }
  return hashes;
}

// ── Snapshot ─────────────────────────────────────────────────────────

interface Snapshot {
  /** Resolved paths at snapshot time */
  claudeDirPath: string;
  files: Map<string, string>; // relative path -> hash
  dirs: Map<string, Map<string, string>>; // dir name -> (filename -> hash)
}

async function takeSnapshot(): Promise<Snapshot> {
  const cd = claudeDir();
  const files = new Map<string, string>();
  const dirs = new Map<string, Map<string, string>>();

  const fileEntries = WATCHED.filter((w) => !w.isDir);
  const dirEntries = WATCHED.filter((w) => w.isDir);

  const [fileResults, dirResults] = await Promise.all([
    Promise.all(
      fileEntries.map(async (w) => {
        const hash = await hashFile(join(cd, w.path));
        return [w.path, hash] as const;
      }),
    ),
    Promise.all(
      dirEntries.map(async (w) => {
        const hashes = await hashDir(join(cd, w.path));
        return [w.path, hashes] as const;
      }),
    ),
  ]);

  for (const [path, hash] of fileResults) {
    if (hash) files.set(path, hash);
  }
  for (const [path, hashes] of dirResults) {
    dirs.set(path, hashes);
  }

  return { claudeDirPath: cd, files, dirs };
}

// ── Diffing ──────────────────────────────────────────────────────────

async function diffSnapshot(baseline: Snapshot): Promise<ConfigAlert[]> {
  const current = await takeSnapshot();
  const alerts: ConfigAlert[] = [];
  const now = new Date();
  const cd = baseline.claudeDirPath;

  // Check individual files
  for (const entry of WATCHED.filter((w) => !w.isDir)) {
    const oldHash = baseline.files.get(entry.path);
    const newHash = current.files.get(entry.path);

    if (oldHash && !newHash) {
      alerts.push({
        severity: entry.severity,
        file: join(cd, entry.path),
        type: "deleted",
        description: `Deleted: ${entry.description}`,
        timestamp: now,
      });
    } else if (!oldHash && newHash) {
      alerts.push({
        severity: entry.severity,
        file: join(cd, entry.path),
        type: "created",
        description: `Created: ${entry.description}`,
        timestamp: now,
      });
    } else if (oldHash && newHash && oldHash !== newHash) {
      alerts.push({
        severity: entry.severity,
        file: join(cd, entry.path),
        type: "modified",
        description: `Modified: ${entry.description}`,
        timestamp: now,
      });
    }
  }

  // Check directories
  for (const entry of WATCHED.filter((w) => w.isDir)) {
    const oldDir = baseline.dirs.get(entry.path) ?? new Map();
    const newDir = current.dirs.get(entry.path) ?? new Map();

    for (const [name, newHash] of newDir) {
      const oldHash = oldDir.get(name);
      if (!oldHash) {
        alerts.push({
          severity: entry.severity,
          file: join(cd, entry.path, name),
          type: "created",
          description: `New file in ${entry.path}/: ${entry.description}`,
          timestamp: now,
        });
      } else if (oldHash !== newHash) {
        alerts.push({
          severity: entry.severity,
          file: join(cd, entry.path, name),
          type: "modified",
          description: `Modified file in ${entry.path}/: ${entry.description}`,
          timestamp: now,
        });
      }
    }

    for (const name of oldDir.keys()) {
      if (!newDir.has(name)) {
        alerts.push({
          severity: entry.severity,
          file: join(cd, entry.path, name),
          type: "deleted",
          description: `Deleted file from ${entry.path}/: ${entry.description}`,
          timestamp: now,
        });
      }
    }
  }

  return alerts;
}

// ── Guard ────────────────────────────────────────────────────────────

/**
 * Start watching ~/.claude for changes.
 *
 * Takes a snapshot of critical files on startup, then uses fs.watch to
 * detect changes. On each change event, diffs against the baseline and
 * emits alerts for any modifications.
 *
 * @param onChange - Optional callback fired on each new alert
 */
export async function startClaudeConfigGuard(
  onChange?: ChangeListener,
): Promise<ClaudeConfigGuard> {
  const baseline = await takeSnapshot();
  const alerts: ConfigAlert[] = [];
  const watchers: FSWatcher[] = [];
  const cd = baseline.claudeDirPath;

  // Debounce: fs.watch fires multiple events per change
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function checkForChanges() {
    if (stopped) return;
    const newAlerts = await diffSnapshot(baseline);
    for (const alert of newAlerts) {
      // Deduplicate: don't re-alert for the same file+type
      const isDupe = alerts.some(
        (a) => a.file === alert.file && a.type === alert.type,
      );
      if (!isDupe) {
        alerts.push(alert);
        onChange?.(alert);
      }
    }
  }

  function onFsEvent() {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      checkForChanges().catch(() => {});
    }, CONFIG_GUARD_DEBOUNCE_MS);
  }

  // Watch ~/.claude directory
  try {
    const w = watch(cd, { recursive: false }, onFsEvent);
    watchers.push(w);
  } catch {
    // Directory might not exist
  }

  // Watch subdirectories (hooks/, commands/)
  for (const entry of WATCHED.filter((w) => w.isDir)) {
    try {
      const w = watch(join(cd, entry.path), { recursive: false }, onFsEvent);
      watchers.push(w);
    } catch {
      // Subdirectory might not exist
    }
  }

  return {
    alerts,
    stop() {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const w of watchers) {
        w.close();
      }
    },
  };
}
