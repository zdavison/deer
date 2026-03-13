import { mkdir } from "node:fs/promises";

/**
 * Generate a unique, sortable, URL-safe task ID.
 *
 * Format: `deer_<base36-timestamp><random-suffix>`
 * - Timestamp prefix makes IDs sortable by creation time
 * - Random suffix ensures uniqueness across concurrent invocations
 * - All characters are URL-safe (lowercase alphanumeric + underscore prefix)
 */
export function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(random)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 8);
  return `deer_${timestamp}${suffix}`;
}

/**
 * Returns the base data directory for deer task storage.
 * @example "/home/user/.local/share/deer"
 */
export function dataDir(): string {
  const home = process.env.HOME;
  return `${home}/.local/share/deer`;
}

// ── Prompt Input History ──────────────────────────────────────────────

const PROMPT_HISTORY_MAX = 500;

function promptHistoryPath(): string {
  return `${dataDir()}/prompt-history.json`;
}

/** Load persisted prompt input history. Returns an empty array if none saved. */
export async function loadPromptHistory(): Promise<string[]> {
  const file = Bun.file(promptHistoryPath());
  if (!(await file.exists())) return [];
  try {
    const data = await file.json();
    if (Array.isArray(data)) return data as string[];
  } catch {
    // ignore malformed file
  }
  return [];
}

/** Append a new entry to the persisted prompt history, capping at PROMPT_HISTORY_MAX. */
export async function savePromptHistory(history: string[]): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const capped = history.slice(-PROMPT_HISTORY_MAX);
  await Bun.write(promptHistoryPath(), JSON.stringify(capped));
}
