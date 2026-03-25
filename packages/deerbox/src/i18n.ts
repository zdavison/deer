// ── i18n ─────────────────────────────────────────────────────────────
//
// Zero-dependency string lookup for deerbox CLI output. To add a language:
// copy the `en` block, translate the values, and add the locale code to
// the `Lang` union in @deer/shared.
//
// Usage:
//   import { t } from "./i18n";
//   t("cli_fetching_pr_comments")           // "Fetching PR review comments..."
//   t("cli_review_comment", { n: 3, s: "s" }) // "3 review comments"

export { setLang, getLang, detectLang, getPRLanguage } from "@deer/shared";
export type { Lang } from "@deer/shared";

import { getLang } from "@deer/shared";

const strings = {
  en: {
    cli_fetching_pr_comments: "Fetching PR review comments...",
    cli_review_comment: "{n} review comment{s}",
    cli_discussion_comment: "{n} discussion comment{s}",
    cli_fetched_comments: "Fetched {rc}, {ic}",
    cli_no_pr_comments: "No PR comments found",
    cli_fetching_action_logs: "Fetching CI job logs...",
    cli_fetched_action_logs: "Fetched {n} lines of failed job logs",
    cli_no_action_logs: "No failed job logs found",
  },

  ja: {
    cli_fetching_pr_comments: "PRレビューコメントを取得中...",
    cli_review_comment: "{n}件のレビューコメント",
    cli_discussion_comment: "{n}件のディスカッションコメント",
    cli_fetched_comments: "{rc}、{ic}を取得",
    cli_no_pr_comments: "PRコメントが見つかりません",
    cli_fetching_action_logs: "CIジョブログを取得中...",
    cli_fetched_action_logs: "失敗したジョブログ{n}行を取得",
    cli_no_action_logs: "失敗したジョブログが見つかりません",
  },

  zh: {
    cli_fetching_pr_comments: "正在获取PR审查评论...",
    cli_review_comment: "{n} 条审查评论",
    cli_discussion_comment: "{n} 条讨论评论",
    cli_fetched_comments: "已获取 {rc}、{ic}",
    cli_no_pr_comments: "未找到PR评论",
    cli_fetching_action_logs: "正在获取CI作业日志...",
    cli_fetched_action_logs: "已获取 {n} 行失败作业日志",
    cli_no_action_logs: "未找到失败的作业日志",
  },

  ko: {
    cli_fetching_pr_comments: "PR 리뷰 코멘트를 가져오는 중...",
    cli_review_comment: "{n}개의 리뷰 코멘트",
    cli_discussion_comment: "{n}개의 토론 코멘트",
    cli_fetched_comments: "{rc}, {ic} 가져옴",
    cli_no_pr_comments: "PR 코멘트를 찾을 수 없음",
    cli_fetching_action_logs: "CI 작업 로그를 가져오는 중...",
    cli_fetched_action_logs: "실패한 작업 로그 {n}줄 가져옴",
    cli_no_action_logs: "실패한 작업 로그를 찾을 수 없음",
  },

  ru: {
    cli_fetching_pr_comments: "Получение комментариев к PR...",
    cli_review_comment: "{n} комментариев к ревью",
    cli_discussion_comment: "{n} комментариев к обсуждению",
    cli_fetched_comments: "Получено: {rc}, {ic}",
    cli_no_pr_comments: "Комментарии к PR не найдены",
    cli_fetching_action_logs: "Получение логов CI...",
    cli_fetched_action_logs: "Получено {n} строк логов неудавшихся задач",
    cli_no_action_logs: "Логи неудавшихся задач не найдены",
  },
} as const;

export type StringKey = keyof typeof strings.en;

/**
 * Look up a translated string, interpolating {key} placeholders from vars.
 *
 * @example
 *   t("cli_review_comment", { n: 3, s: "s" })  // "3 review comments" or "3件のレビューコメント"
 */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let s = strings[getLang()][key] as string;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
