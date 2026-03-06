// ── Centralized constants ───────────────────────────────────────────

/** Polling interval for agent completion checks in agent.ts */
export const AGENT_POLL_INTERVAL_MS = 3_000;

/** Default Claude model to use */
export const DEFAULT_MODEL = "sonnet";

/** Max number of polls to wait for the bypass permissions dialog */
export const BYPASS_DIALOG_MAX_POLLS = 15;

/** Delay between polls when looking for the bypass dialog */
export const BYPASS_DIALOG_POLL_MS = 500;

/** Delay between keystrokes when dismissing the bypass dialog */
export const BYPASS_DIALOG_KEY_DELAY_MS = 200;

/** Max diff length sent to Claude for PR metadata generation */
export const MAX_DIFF_FOR_PR_METADATA = 20_000;

/** Debounce delay for the claude-config-guard file watcher */
export const CONFIG_GUARD_DEBOUNCE_MS = 300;

/** Debounce delay for cross-instance task state sync */
export const TASK_SYNC_DEBOUNCE_MS = 100;

/** Safety-net poll interval for cross-instance task sync */
export const TASK_SYNC_SAFETY_POLL_MS = 10_000;

/** Dashboard poll interval for tmux pane capture */
export const DASHBOARD_POLL_MS = 1_000;

/** Number of consecutive unchanged pane captures before considering Claude idle */
export const IDLE_THRESHOLD = 3;

/** PR merge state polling interval */
export const PR_MERGE_CHECK_INTERVAL_MS = 10_000;

/** Max log lines kept in an agent's ring buffer */
export const MAX_LOG_LINES = 200;

/** Max log lines visible in the detail panel */
export const MAX_VISIBLE_LOGS = 5;

/** Number of recent log lines shown per agent entry */
export const LOG_LINES_PER_ENTRY = 2;

/** Rows per agent entry in the list (title + log lines) */
export const ENTRY_ROWS_BASE = 1 + LOG_LINES_PER_ENTRY;

/** Rows per agent entry when PR line is shown */
export const ENTRY_ROWS_WITH_PR = ENTRY_ROWS_BASE + 1;

/** Upload animation frames */
export const UPLOAD_FRAMES = ["\u2B06", "\u21E7"];

/** HOME directory fallback */
export const HOME = process.env.HOME ?? "/root";
