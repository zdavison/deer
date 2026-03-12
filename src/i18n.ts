// ── i18n ─────────────────────────────────────────────────────────────
//
// Zero-dependency string lookup. To add a language: copy the `en` block,
// translate the values, and add the locale code to the `Lang` union.
//
// Usage:
//   import { t } from "./i18n";
//   t("header_idle")                        // "idle" | "待機中"
//   t("header_active", { n: 3 })            // "3 active" | "3件実行中"

export type Lang = "en" | "ja";

const strings = {
  en: {
    // Header
    header_title: "🦌 deer",
    header_active: "{n} active",
    header_idle: "idle",

    // Agent list
    agents_empty: "Type a prompt below and press Enter to launch an agent",

    // Quit confirmation
    quit_confirm: "{n} agent{s} running — quit? (y/n)",

    // Search
    search_no_matches: "no matches",

    // Input bar
    input_tab_hint: "press Tab to type a prompt",
    input_placeholder: "type prompt and press Enter to launch agent (Shift+Enter or /↵ for newline)",
    input_preflight_failed: "preflight checks failed",

    // Shortcuts bar
    shortcuts_focus: "focus",
    shortcuts_nav: "↑↓",
    shortcuts_search: "search",
    shortcuts_select: "select",
    shortcuts_cancel: "cancel",
    shortcuts_quit: "quit",
    shortcuts_verbose_on: " (on)",
    label_agent: "agent",
    cred_subscription: "subscription",
    cred_api_token: "api-token",
    cred_none: "no credentials",

    // Action labels (keybinding bar)
    action_attach: "attach",
    action_create_pr: "create PR",
    action_open_pr: "open PR",
    action_update_pr: "update PR",
    action_kill: "kill",
    action_delete: "delete",
    action_toggle_logs: "logs",
    action_copy_logs: "copy",
    action_toggle_verbose: "verbose",
    action_retry: "retry",
    action_open_shell: "shell",

    // Confirmation prompts
    confirm_kill: "Kill this agent? (y/n)",
    confirm_delete_running: "Agent is still running — delete? (y/n)",
    confirm_delete_no_pr: "No PR created — delete and lose work? (y/n)",
    confirm_retry_running: "Agent is still running — kill and retry? (y/n)",

    // Agent activity status strings
    activity_setting_up: "Setting up sandbox...",
    activity_running: "Claude running...",
    activity_idle_attach: "Idle \u2014 press \u23CE to attach",
    activity_idle_update_pr: "Idle \u2014 press u to update PR, \u23CE to attach",
    activity_idle_create_pr: "Idle \u2014 press p to create PR, \u23CE to attach",
    activity_cancelled: "Cancelled by user",
    activity_interrupted: "Interrupted — deer was closed",
    activity_creating_pr: "Creating PR...",
    activity_pr_created: "PR created",
    activity_pr_failed: "PR failed: {msg}",
    activity_updating_pr: "Updating PR...",
    activity_pr_updated: "PR updated",
    activity_pr_update_failed: "PR update failed: {msg}",

    // Log messages
    log_tmux_exited: "[tmux] Claude process exited",
    log_deer_idle: "[deer] Claude is idle",
    log_setup_resuming: "[setup] Resuming session...",
    log_setup_creating: "[setup] Creating worktree and sandbox...",
    log_running_started: "[running] Claude started in tmux session: {session}",
    log_deer_resuming: "[deer] Resuming session after restart...",
    log_pr_starting_create: "[pr] Starting PR creation...",
    log_pr_starting_update: "[pr] Starting PR update...",
    log_pr_created: "[pr] PR created: {url}",
    log_pr_updated: "[pr] PR updated: {url}",

    // Preflight errors
    preflight_srt_missing: "@anthropic-ai/sandbox-runtime not installed — run: bunx @zdavison/deer install",
    preflight_sandbox_exec_broken: "sandbox-exec not working — ensure /usr/bin is in PATH",
    preflight_sandbox_exec_missing: "sandbox-exec not available — required on macOS for srt sandboxing",
    preflight_bwrap_missing: "bwrap not available — install bubblewrap (required by srt on Linux)",
    preflight_tmux_missing: "tmux not available",
    preflight_claude_missing: "claude CLI not available",
    preflight_gh_auth_missing: "gh auth not configured — run 'gh auth login'",
    preflight_gh_missing: "gh CLI not available",
    preflight_no_credentials: "No credentials — set CLAUDE_CODE_OAUTH_TOKEN, create ~/.claude/agent-oauth-token, or set ANTHROPIC_API_KEY",
  },

  ja: {
    // Header
    header_title: "🦌 deer",
    header_active: "{n}件実行中",
    header_idle: "待機中",

    // Agent list
    agents_empty: "プロンプトを入力してEnterを押してエージェントを起動",

    // Quit confirmation
    quit_confirm: "{n}件のエージェントが実行中 — 終了しますか？ (y/n)",

    // Search
    search_no_matches: "一致なし",

    // Input bar
    input_tab_hint: "Tabキーでプロンプトを入力",
    input_placeholder: "プロンプトを入力してEnterで起動 (Shift+Enterまたは/↵で改行)",
    input_preflight_failed: "プリフライトチェック失敗",

    // Shortcuts bar
    shortcuts_focus: "フォーカス",
    shortcuts_nav: "↑↓",
    shortcuts_search: "検索",
    shortcuts_select: "選択",
    shortcuts_cancel: "キャンセル",
    shortcuts_quit: "終了",
    shortcuts_verbose_on: " (オン)",
    label_agent: "エージェント",
    cred_subscription: "サブスクリプション",
    cred_api_token: "APIトークン",
    cred_none: "認証情報なし",

    // Action labels (keybinding bar)
    action_attach: "接続",
    action_create_pr: "PR作成",
    action_open_pr: "PRを開く",
    action_update_pr: "PR更新",
    action_kill: "強制終了",
    action_delete: "削除",
    action_toggle_logs: "ログ",
    action_copy_logs: "コピー",
    action_toggle_verbose: "詳細",
    action_retry: "再試行",
    action_open_shell: "シェル",

    // Confirmation prompts
    confirm_kill: "エージェントを強制終了しますか？ (y/n)",
    confirm_delete_running: "エージェントが実行中です — 削除しますか？ (y/n)",
    confirm_delete_no_pr: "PRが未作成です — 削除して作業を失いますか？ (y/n)",
    confirm_retry_running: "エージェントが実行中です — 強制終了して再試行しますか？ (y/n)",

    // Agent activity status strings
    activity_setting_up: "サンドボックスをセットアップ中...",
    activity_running: "Claude実行中...",
    activity_idle_attach: "待機中 \u2014 \u23CEで接続",
    activity_idle_update_pr: "待機中 \u2014 uでPR更新、\u23CEで接続",
    activity_idle_create_pr: "待機中 \u2014 pでPR作成、\u23CEで接続",
    activity_cancelled: "ユーザーによりキャンセル",
    activity_interrupted: "中断 — deerが終了しました",
    activity_creating_pr: "PRを作成中...",
    activity_pr_created: "PR作成完了",
    activity_pr_failed: "PR失敗: {msg}",
    activity_updating_pr: "PRを更新中...",
    activity_pr_updated: "PR更新完了",
    activity_pr_update_failed: "PR更新失敗: {msg}",

    // Log messages
    log_tmux_exited: "[tmux] Claudeプロセスが終了しました",
    log_deer_idle: "[deer] Claudeは待機中",
    log_setup_resuming: "[setup] セッションを再開中...",
    log_setup_creating: "[setup] ワークツリーとサンドボックスを作成中...",
    log_running_started: "[running] Claudeがtmuxセッションで起動しました: {session}",
    log_deer_resuming: "[deer] 再起動後にセッションを再開中...",
    log_pr_starting_create: "[pr] PR作成を開始...",
    log_pr_starting_update: "[pr] PR更新を開始...",
    log_pr_created: "[pr] PR作成完了: {url}",
    log_pr_updated: "[pr] PR更新完了: {url}",

    // Preflight errors
    preflight_srt_missing: "@anthropic-ai/sandbox-runtime がインストールされていません — 実行: bunx @zdavison/deer install",
    preflight_sandbox_exec_broken: "sandbox-exec が動作していません — /usr/bin がPATHに含まれているか確認してください",
    preflight_sandbox_exec_missing: "sandbox-exec が利用できません — macOSのsrtサンドボックスに必要です",
    preflight_bwrap_missing: "bwrap が利用できません — bubblewrapをインストールしてください (Linuxのsrtに必要)",
    preflight_tmux_missing: "tmux が利用できません",
    preflight_claude_missing: "claude CLIが利用できません",
    preflight_gh_auth_missing: "gh認証が設定されていません — 'gh auth login' を実行してください",
    preflight_gh_missing: "gh CLIが利用できません",
    preflight_no_credentials: "認証情報がありません — CLAUDE_CODE_OAUTH_TOKEN を設定するか、~/.claude/agent-oauth-token を作成するか、ANTHROPIC_API_KEY を設定してください",
  },
} as const;

export type StringKey = keyof typeof strings.en;

let _lang: Lang = "en";

export function setLang(lang: Lang): void {
  _lang = lang;
}

export function getLang(): Lang {
  return _lang;
}

/**
 * Maps each language to the display name passed to Claude when generating PR
 * metadata. English is null — no instruction is needed since Claude defaults to
 * English. Add an entry here whenever a new Lang is added.
 */
const PR_LANGUAGE_NAMES: Record<Lang, string | null> = {
  en: null,
  ja: "Japanese (日本語)",
};

/**
 * Returns the language name to request in the PR metadata prompt, or null if
 * no instruction is needed (i.e. the language is English).
 */
export function getPRLanguage(): string | null {
  return PR_LANGUAGE_NAMES[_lang];
}

/**
 * Detect language from CLI args, CLAUDE_CODE_LOCALE, or system LANG.
 * Priority: --lang=jp/ja > CLAUDE_CODE_LOCALE > system LANG > "en"
 */
export function detectLang(): Lang {
  const langArg = process.argv.find((a) => a.startsWith("--lang="));
  if (langArg) {
    const val = langArg.split("=")[1]?.toLowerCase();
    if (val === "jp" || val === "ja") return "ja";
  }

  const claudeLocale = process.env.CLAUDE_CODE_LOCALE;
  if (claudeLocale?.toLowerCase().startsWith("ja")) return "ja";

  const sysLang = process.env.LANG;
  if (sysLang?.toLowerCase().startsWith("ja")) return "ja";

  return "en";
}

/**
 * Look up a translated string, interpolating {key} placeholders from vars.
 *
 * @example
 *   t("header_active", { n: 3 })  // "3 active" or "3件実行中"
 */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let s = strings[_lang][key] as string;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
