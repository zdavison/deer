// ── i18n ─────────────────────────────────────────────────────────────
//
// Zero-dependency string lookup. To add a language: copy the `en` block,
// translate the values, and add the locale code to the `Lang` union.
//
// Usage:
//   import { t } from "./i18n";
//   t("header_idle")                        // "idle" | "待機中"
//   t("header_active", { n: 3 })            // "3 active" | "3件実行中"

import { setLang as _setLang, getLang as _getLang } from "@deer/shared";
export { getPRLanguage } from "@deer/shared";

export type Lang = "en" | "ja" | "zh" | "ko" | "ru";

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
    preflight_srt_missing: "@anthropic-ai/sandbox-runtime not installed — run: curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash",
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
    preflight_srt_missing: "@anthropic-ai/sandbox-runtime がインストールされていません — 実行: curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash",
    preflight_sandbox_exec_broken: "sandbox-exec が動作していません — /usr/bin がPATHに含まれているか確認してください",
    preflight_sandbox_exec_missing: "sandbox-exec が利用できません — macOSのsrtサンドボックスに必要です",
    preflight_bwrap_missing: "bwrap が利用できません — bubblewrapをインストールしてください (Linuxのsrtに必要)",
    preflight_tmux_missing: "tmux が利用できません",
    preflight_claude_missing: "claude CLIが利用できません",
    preflight_gh_auth_missing: "gh認証が設定されていません — 'gh auth login' を実行してください",
    preflight_gh_missing: "gh CLIが利用できません",
    preflight_no_credentials: "認証情報がありません — CLAUDE_CODE_OAUTH_TOKEN を設定するか、~/.claude/agent-oauth-token を作成するか、ANTHROPIC_API_KEY を設定してください",
  },

  zh: {
    // Header
    header_title: "🦌 deer",
    header_active: "{n} 个任务运行中",
    header_idle: "空闲",

    // Agent list
    agents_empty: "在下方输入提示并按 Enter 启动代理",

    // Quit confirmation
    quit_confirm: "{n} 个代理运行中 — 退出？(y/n)",

    // Search
    search_no_matches: "无匹配",

    // Input bar
    input_tab_hint: "按 Tab 输入提示",
    input_placeholder: "输入提示并按 Enter 启动代理 (Shift+Enter 或 /↵ 换行)",
    input_preflight_failed: "预检失败",

    // Shortcuts bar
    shortcuts_focus: "聚焦",
    shortcuts_nav: "↑↓",
    shortcuts_search: "搜索",
    shortcuts_select: "选择",
    shortcuts_cancel: "取消",
    shortcuts_quit: "退出",
    shortcuts_verbose_on: " (开)",
    label_agent: "代理",
    cred_subscription: "订阅",
    cred_api_token: "API密钥",
    cred_none: "无凭据",

    // Action labels (keybinding bar)
    action_attach: "附加",
    action_create_pr: "创建PR",
    action_open_pr: "打开PR",
    action_update_pr: "更新PR",
    action_kill: "终止",
    action_delete: "删除",
    action_toggle_logs: "日志",
    action_copy_logs: "复制",
    action_toggle_verbose: "详细",
    action_retry: "重试",
    action_open_shell: "终端",

    // Confirmation prompts
    confirm_kill: "终止此代理？(y/n)",
    confirm_delete_running: "代理仍在运行 — 删除？(y/n)",
    confirm_delete_no_pr: "未创建PR — 删除并丢失工作？(y/n)",
    confirm_retry_running: "代理仍在运行 — 终止并重试？(y/n)",

    // Agent activity status strings
    activity_setting_up: "正在设置沙箱...",
    activity_running: "Claude 运行中...",
    activity_idle_attach: "空闲 \u2014 按 \u23CE 附加",
    activity_idle_update_pr: "空闲 \u2014 按 u 更新PR，\u23CE 附加",
    activity_idle_create_pr: "空闲 \u2014 按 p 创建PR，\u23CE 附加",
    activity_cancelled: "已被用户取消",
    activity_interrupted: "已中断 — deer 已关闭",
    activity_creating_pr: "正在创建PR...",
    activity_pr_created: "PR已创建",
    activity_pr_failed: "PR失败: {msg}",
    activity_updating_pr: "正在更新PR...",
    activity_pr_updated: "PR已更新",
    activity_pr_update_failed: "PR更新失败: {msg}",

    // Log messages
    log_tmux_exited: "[tmux] Claude 进程已退出",
    log_deer_idle: "[deer] Claude 空闲中",
    log_setup_resuming: "[setup] 恢复会话...",
    log_setup_creating: "[setup] 正在创建工作树和沙箱...",
    log_running_started: "[running] Claude 已在 tmux 会话中启动: {session}",
    log_deer_resuming: "[deer] 重启后恢复会话...",
    log_pr_starting_create: "[pr] 开始创建PR...",
    log_pr_starting_update: "[pr] 开始更新PR...",
    log_pr_created: "[pr] PR已创建: {url}",
    log_pr_updated: "[pr] PR已更新: {url}",

    // Preflight errors
    preflight_srt_missing: "@anthropic-ai/sandbox-runtime 未安装 — 运行: curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash",
    preflight_sandbox_exec_broken: "sandbox-exec 无法正常工作 — 请确认 /usr/bin 在 PATH 中",
    preflight_sandbox_exec_missing: "sandbox-exec 不可用 — macOS srt 沙箱需要此程序",
    preflight_bwrap_missing: "bwrap 不可用 — 请安装 bubblewrap (Linux srt 需要)",
    preflight_tmux_missing: "tmux 不可用",
    preflight_claude_missing: "claude CLI 不可用",
    preflight_gh_auth_missing: "gh 未配置授权 — 运行 'gh auth login'",
    preflight_gh_missing: "gh CLI 不可用",
    preflight_no_credentials: "无凭据 — 请设置 CLAUDE_CODE_OAUTH_TOKEN，创建 ~/.claude/agent-oauth-token，或设置 ANTHROPIC_API_KEY",
  },

  ko: {
    // Header
    header_title: "🦌 deer",
    header_active: "{n}개 실행 중",
    header_idle: "대기 중",

    // Agent list
    agents_empty: "아래에 프롬프트를 입력하고 Enter를 눌러 에이전트를 시작하세요",

    // Quit confirmation
    quit_confirm: "{n}개의 에이전트가 실행 중입니다 — 종료할까요? (y/n)",

    // Search
    search_no_matches: "일치 없음",

    // Input bar
    input_tab_hint: "Tab을 눌러 프롬프트를 입력하세요",
    input_placeholder: "프롬프트를 입력하고 Enter를 눌러 에이전트 시작 (Shift+Enter 또는 /↵로 줄바꿈)",
    input_preflight_failed: "프리플라이트 검사 실패",

    // Shortcuts bar
    shortcuts_focus: "포커스",
    shortcuts_nav: "↑↓",
    shortcuts_search: "검색",
    shortcuts_select: "선택",
    shortcuts_cancel: "취소",
    shortcuts_quit: "종료",
    shortcuts_verbose_on: " (켜짐)",
    label_agent: "에이전트",
    cred_subscription: "구독",
    cred_api_token: "API 토큰",
    cred_none: "자격 증명 없음",

    // Action labels (keybinding bar)
    action_attach: "연결",
    action_create_pr: "PR 생성",
    action_open_pr: "PR 열기",
    action_update_pr: "PR 업데이트",
    action_kill: "강제 종료",
    action_delete: "삭제",
    action_toggle_logs: "로그",
    action_copy_logs: "복사",
    action_toggle_verbose: "상세",
    action_retry: "재시도",
    action_open_shell: "셸",

    // Confirmation prompts
    confirm_kill: "이 에이전트를 강제 종료할까요? (y/n)",
    confirm_delete_running: "에이전트가 실행 중입니다 — 삭제할까요? (y/n)",
    confirm_delete_no_pr: "PR이 생성되지 않았습니다 — 삭제하고 작업을 잃을까요? (y/n)",
    confirm_retry_running: "에이전트가 실행 중입니다 — 강제 종료하고 재시도할까요? (y/n)",

    // Agent activity status strings
    activity_setting_up: "샌드박스 설정 중...",
    activity_running: "Claude 실행 중...",
    activity_idle_attach: "대기 중 \u2014 \u23CE를 눌러 연결",
    activity_idle_update_pr: "대기 중 \u2014 u로 PR 업데이트, \u23CE로 연결",
    activity_idle_create_pr: "대기 중 \u2014 p로 PR 생성, \u23CE로 연결",
    activity_cancelled: "사용자에 의해 취소됨",
    activity_interrupted: "중단됨 — deer가 종료되었습니다",
    activity_creating_pr: "PR 생성 중...",
    activity_pr_created: "PR 생성됨",
    activity_pr_failed: "PR 실패: {msg}",
    activity_updating_pr: "PR 업데이트 중...",
    activity_pr_updated: "PR 업데이트됨",
    activity_pr_update_failed: "PR 업데이트 실패: {msg}",

    // Log messages
    log_tmux_exited: "[tmux] Claude 프로세스가 종료되었습니다",
    log_deer_idle: "[deer] Claude가 대기 중입니다",
    log_setup_resuming: "[setup] 세션 재개 중...",
    log_setup_creating: "[setup] 워크트리와 샌드박스 생성 중...",
    log_running_started: "[running] Claude가 tmux 세션에서 시작되었습니다: {session}",
    log_deer_resuming: "[deer] 재시작 후 세션 재개 중...",
    log_pr_starting_create: "[pr] PR 생성 시작...",
    log_pr_starting_update: "[pr] PR 업데이트 시작...",
    log_pr_created: "[pr] PR 생성됨: {url}",
    log_pr_updated: "[pr] PR 업데이트됨: {url}",

    // Preflight errors
    preflight_srt_missing: "@anthropic-ai/sandbox-runtime이 설치되지 않았습니다 — 실행: curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash",
    preflight_sandbox_exec_broken: "sandbox-exec가 작동하지 않습니다 — /usr/bin이 PATH에 있는지 확인하세요",
    preflight_sandbox_exec_missing: "sandbox-exec를 사용할 수 없습니다 — macOS srt 샌드박스에 필요합니다",
    preflight_bwrap_missing: "bwrap를 사용할 수 없습니다 — bubblewrap를 설치하세요 (Linux srt에 필요)",
    preflight_tmux_missing: "tmux를 사용할 수 없습니다",
    preflight_claude_missing: "claude CLI를 사용할 수 없습니다",
    preflight_gh_auth_missing: "gh 인증이 구성되지 않았습니다 — 'gh auth login'을 실행하세요",
    preflight_gh_missing: "gh CLI를 사용할 수 없습니다",
    preflight_no_credentials: "자격 증명 없음 — CLAUDE_CODE_OAUTH_TOKEN을 설정하거나, ~/.claude/agent-oauth-token을 생성하거나, ANTHROPIC_API_KEY를 설정하세요",
  },

  ru: {
    // Header
    header_title: "🦌 deer",
    header_active: "{n} активных",
    header_idle: "простой",

    // Agent list
    agents_empty: "Введите запрос ниже и нажмите Enter, чтобы запустить агент",

    // Quit confirmation
    quit_confirm: "{n} агентов запущено — выйти? (y/n)",

    // Search
    search_no_matches: "нет совпадений",

    // Input bar
    input_tab_hint: "нажмите Tab для ввода запроса",
    input_placeholder: "введите запрос и нажмите Enter для запуска агента (Shift+Enter или /↵ для новой строки)",
    input_preflight_failed: "предварительные проверки не пройдены",

    // Shortcuts bar
    shortcuts_focus: "фокус",
    shortcuts_nav: "↑↓",
    shortcuts_search: "поиск",
    shortcuts_select: "выбор",
    shortcuts_cancel: "отмена",
    shortcuts_quit: "выход",
    shortcuts_verbose_on: " (вкл)",
    label_agent: "агент",
    cred_subscription: "подписка",
    cred_api_token: "API-токен",
    cred_none: "нет учётных данных",

    // Action labels (keybinding bar)
    action_attach: "подключить",
    action_create_pr: "создать PR",
    action_open_pr: "открыть PR",
    action_update_pr: "обновить PR",
    action_kill: "завершить",
    action_delete: "удалить",
    action_toggle_logs: "логи",
    action_copy_logs: "копировать",
    action_toggle_verbose: "подробно",
    action_retry: "повтор",
    action_open_shell: "шелл",

    // Confirmation prompts
    confirm_kill: "Завершить этот агент? (y/n)",
    confirm_delete_running: "Агент ещё работает — удалить? (y/n)",
    confirm_delete_no_pr: "PR не создан — удалить и потерять работу? (y/n)",
    confirm_retry_running: "Агент ещё работает — завершить и повторить? (y/n)",

    // Agent activity status strings
    activity_setting_up: "Настройка песочницы...",
    activity_running: "Claude работает...",
    activity_idle_attach: "Простой \u2014 нажмите \u23CE для подключения",
    activity_idle_update_pr: "Простой \u2014 u для обновления PR, \u23CE для подключения",
    activity_idle_create_pr: "Простой \u2014 p для создания PR, \u23CE для подключения",
    activity_cancelled: "Отменено пользователем",
    activity_interrupted: "Прервано — deer был закрыт",
    activity_creating_pr: "Создание PR...",
    activity_pr_created: "PR создан",
    activity_pr_failed: "Ошибка PR: {msg}",
    activity_updating_pr: "Обновление PR...",
    activity_pr_updated: "PR обновлён",
    activity_pr_update_failed: "Ошибка обновления PR: {msg}",

    // Log messages
    log_tmux_exited: "[tmux] Процесс Claude завершился",
    log_deer_idle: "[deer] Claude бездействует",
    log_setup_resuming: "[setup] Возобновление сессии...",
    log_setup_creating: "[setup] Создание рабочего дерева и песочницы...",
    log_running_started: "[running] Claude запущен в сессии tmux: {session}",
    log_deer_resuming: "[deer] Возобновление сессии после перезапуска...",
    log_pr_starting_create: "[pr] Начало создания PR...",
    log_pr_starting_update: "[pr] Начало обновления PR...",
    log_pr_created: "[pr] PR создан: {url}",
    log_pr_updated: "[pr] PR обновлён: {url}",

    // Preflight errors
    preflight_srt_missing: "@anthropic-ai/sandbox-runtime не установлен — выполните: curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash",
    preflight_sandbox_exec_broken: "sandbox-exec не работает — убедитесь, что /usr/bin есть в PATH",
    preflight_sandbox_exec_missing: "sandbox-exec недоступен — необходим для srt-песочницы на macOS",
    preflight_bwrap_missing: "bwrap недоступен — установите bubblewrap (необходим для srt на Linux)",
    preflight_tmux_missing: "tmux недоступен",
    preflight_claude_missing: "CLI claude недоступен",
    preflight_gh_auth_missing: "gh не авторизован — выполните 'gh auth login'",
    preflight_gh_missing: "CLI gh недоступен",
    preflight_no_credentials: "Нет учётных данных — установите CLAUDE_CODE_OAUTH_TOKEN, создайте ~/.claude/agent-oauth-token или установите ANTHROPIC_API_KEY",
  },

} as const;

export type StringKey = keyof typeof strings.en;

export function setLang(lang: Lang): void {
  _setLang(lang);
}

export function getLang(): Lang {
  return _getLang();
}

export { detectLang } from "@deer/shared";

/**
 * Look up a translated string, interpolating {key} placeholders from vars.
 *
 * @example
 *   t("header_active", { n: 3 })  // "3 active" or "3件実行中"
 */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let s = strings[_getLang()][key] as string;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
