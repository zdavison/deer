import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataDir } from "../../src/task";

// ── Types ─────────────────────────────────────────────────────────────

export interface DeerSession {
  /** Write keystrokes to the PTY. Use "\r" for Enter, "\x7f" for Backspace. */
  sendKeys: (keys: string) => void;
  /** Poll the screen buffer until any row contains text, or throw on timeout. */
  waitForPane: (text: string, timeoutMs?: number) => Promise<void>;
  /** Wait for preflight to complete and the prompt input to be active. */
  waitForReady: (timeoutMs?: number) => Promise<void>;
  /** Returns the current screen contents as an array of rows. */
  getScreen: () => Promise<string[]>;
  /** Kill the tmux session and clean up. */
  stop: () => Promise<void>;
}

// ── Polling helper ────────────────────────────────────────────────────

/** Poll until condition() returns truthy, or throw on timeout. */
export async function waitFor(
  condition: () => Promise<boolean | string | null | undefined>,
  {
    timeout = 15_000,
    interval = 250,
    label = "condition",
  }: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(interval);
  }
  throw new Error(`waitFor("${label}") timed out after ${timeout}ms`);
}

// ── tmux helpers ─────────────────────────────────────────────────────

let sessionCounter = 0;

/** Capture the visible pane contents as an array of trimmed-right rows. */
async function captureTmuxPane(session: string): Promise<string[]> {
  const result = await Bun.$`tmux capture-pane -t ${session} -p`.quiet().nothrow();
  if (result.exitCode !== 0) return [];
  return result.stdout.toString().split("\n");
}

/**
 * Map JS control characters to tmux send-keys arguments.
 *
 * tmux send-keys with `-l` sends literal text, but control characters
 * need to be sent as named keys or hex sequences.
 */
function sendKeysToTmux(session: string, keys: string): void {
  // Split into segments of literal text and control characters
  let i = 0;
  while (i < keys.length) {
    const ch = keys[i];

    if (ch === "\r") {
      Bun.spawnSync(["tmux", "send-keys", "-t", session, "Enter"]);
      i++;
    } else if (ch === "\t") {
      Bun.spawnSync(["tmux", "send-keys", "-t", session, "Tab"]);
      i++;
    } else if (ch === "\x7f") {
      Bun.spawnSync(["tmux", "send-keys", "-t", session, "BSpace"]);
      i++;
    } else if (ch === "\x1b") {
      Bun.spawnSync(["tmux", "send-keys", "-t", session, "Escape"]);
      i++;
    } else {
      // Collect consecutive literal characters
      let literal = "";
      while (i < keys.length && keys[i] !== "\r" && keys[i] !== "\t" && keys[i] !== "\x7f" && keys[i] !== "\x1b") {
        literal += keys[i];
        i++;
      }
      Bun.spawnSync(["tmux", "send-keys", "-t", session, "-l", literal]);
    }
  }
}

// ── Session management ────────────────────────────────────────────────

/**
 * Spawn deer TUI inside a tmux session.
 *
 * Uses tmux as the PTY provider instead of node-pty, which avoids
 * Bun's incomplete libuv compatibility for native PTY addons.
 *
 * Optionally pass a custom command to run instead of `bun run src/cli.tsx`
 * (e.g. for the build-smoke test which uses the compiled binary).
 */
export async function startDeerSession(
  repoPath: string,
  extraEnv: Record<string, string> = {},
  options: { command?: string[] } = {},
): Promise<DeerSession> {
  const cols = 120;
  const rows = 40;
  const session = `deer-e2e-${process.pid}-${sessionCounter++}`;

  // Resolve command using the *host* PATH so env overrides (like a
  // restricted PATH for testing) don't prevent the runtime from launching.
  const rawCommand =
    options.command ?? ["bun", "run", join(import.meta.dir, "../../src/cli.tsx")];
  const resolvedBin = rawCommand[0].includes("/")
    ? rawCommand[0]
    : Bun.which(rawCommand[0]) ?? rawCommand[0];
  const command = [resolvedBin, ...rawCommand.slice(1)];
  const shellCmd = command.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");

  // Build env export prefix
  const envExports = Object.entries(extraEnv)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
    .join("; ");

  const fullCmd = envExports ? `${envExports}; exec ${shellCmd}` : `exec ${shellCmd}`;

  await Bun.$`tmux new-session -d -s ${session} -x ${cols} -y ${rows} -c ${repoPath} ${fullCmd}`.quiet();

  // Brief pause to let the TUI initialize
  await Bun.sleep(200);

  return {
    sendKeys: (keys: string) => sendKeysToTmux(session, keys),

    waitForPane: (text: string, timeoutMs = 15_000) =>
      waitFor(
        async () => {
          const lines = await captureTmuxPane(session);
          return lines.some((l) => l.includes(text));
        },
        { timeout: timeoutMs, label: `pane contains "${text}"` },
      ),

    waitForReady: (timeoutMs = 15_000) =>
      waitFor(
        async () => {
          const lines = await captureTmuxPane(session);
          // "type prompt" appears in the input placeholder once preflight completes
          return lines.some((l) => l.includes("type prompt"));
        },
        { timeout: timeoutMs, label: "prompt input ready" },
      ),

    getScreen: () => captureTmuxPane(session),

    stop: async () => {
      await Bun.$`tmux kill-session -t ${session}`.quiet().nothrow();
    },
  };
}

// ── Repo helpers ──────────────────────────────────────────────────────

/** Create a minimal git repo suitable for E2E tests. */
export async function createTestRepo(): Promise<{
  repoPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "deer-e2e-"));
  await Bun.$`git init ${dir}`.quiet();
  await Bun.$`git -C ${dir} config user.name "deer-e2e"`.quiet();
  await Bun.$`git -C ${dir} config user.email "e2e@deer.test"`.quiet();
  await Bun.write(join(dir, "README.md"), "# E2E Test Repo\n");
  await Bun.$`git -C ${dir} add -A`.quiet();
  await Bun.$`git -C ${dir} commit -m "init"`.quiet();
  await Bun.$`git -C ${dir} branch -M main`.quiet();
  return {
    repoPath: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ── Fake claude helpers ───────────────────────────────────────────────

/**
 * Run a test with a fast fake claude binary prepended to PATH.
 * The fake claude prints some output and exits after ~1 second.
 */
export async function withFakeClaude<T>(
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "deer-e2e-bin-"));
  const fakeBin = join(binDir, "claude");
  const stubSrc = join(import.meta.dir, "../fixtures/fake-claude.sh");
  await Bun.$`cp ${stubSrc} ${fakeBin} && chmod +x ${fakeBin}`.quiet();
  try {
    return await fn({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

/**
 * Run a test with a slow fake claude binary prepended to PATH.
 * The fake claude sleeps for 60 seconds — suitable for kill/cancel action tests.
 */
export async function withSlowFakeClaude<T>(
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "deer-e2e-bin-"));
  const fakeBin = join(binDir, "claude");
  const stubSrc = join(import.meta.dir, "../fixtures/fake-claude-slow.sh");
  await Bun.$`cp ${stubSrc} ${fakeBin} && chmod +x ${fakeBin}`.quiet();
  try {
    return await fn({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

// ── Task discovery ────────────────────────────────────────────────────

/**
 * Scan dataDir/tasks/<repoSlug>/ for a taskId directory created after a given timestamp.
 * Searches across all repo slug directories.
 * Returns the taskId of the first matching directory found.
 */
export async function waitForNewTaskDir(
  since: number,
  timeoutMs = 15_000,
): Promise<string> {
  const tasksDir = join(dataDir(), "tasks");
  let found: string | undefined;
  await waitFor(
    async () => {
      let repoEntries: string[];
      try {
        repoEntries = await readdir(tasksDir);
      } catch {
        return false;
      }
      for (const repo of repoEntries) {
        let taskEntries: string[];
        try {
          taskEntries = await readdir(join(tasksDir, repo));
        } catch {
          continue;
        }
        const match = (
          await Promise.all(
            taskEntries
              .filter((e) => e.startsWith("deer_"))
              .map(async (e) => {
                const s = await stat(join(tasksDir, repo, e)).catch(() => null);
                return s && s.ctimeMs > since ? e : null;
              }),
          )
        ).find((e): e is string => e !== null);
        if (match) {
          found = match;
          return true;
        }
      }
      return false;
    },
    { timeout: timeoutMs, label: "new task directory" },
  );
  return found!;
}
