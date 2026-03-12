import { Box, Text } from "ink";
import React from "react";
import { availableActions, ACTION_BINDINGS } from "../state-machine";
import type { AgentAction } from "../state-machine";
import type { PreflightResult } from "../preflight";
import type { AgentState } from "../agent-state";
import { t, type StringKey } from "../i18n";

interface ShortcutsBarProps {
  selected: AgentState | null;
  inputFocused: boolean;
  searchMode: boolean;
  verboseMode: boolean;
  logExpanded: boolean;
  preflight: PreflightResult | null;
}

export function ShortcutsBar({
  selected,
  inputFocused,
  searchMode,
  verboseMode,
  logExpanded,
  preflight,
}: ShortcutsBarProps) {
  let mainActions: AgentAction[] = [];
  let logSubActions: AgentAction[] = [];
  if (selected && !inputFocused && !searchMode) {
    const actions = availableActions({
      status: selected.status,
      hasPrUrl: !!selected.result?.prUrl,
      hasFinalBranch: !!selected.result?.finalBranch || !!selected.branch,
      hasHandle: selected.status === "running",
      isIdle: selected.idle,
      prState: selected.prState,
      hasWorktreePath: !!selected.taskId,
      logExpanded,
    });
    logSubActions = actions.filter((a) => a === "copy_logs" || a === "toggle_verbose");
    mainActions = actions.filter((a) => a !== "copy_logs" && a !== "toggle_verbose");
  }

  // Calculate character offset of "l logs" on line 1 so sub-actions align beneath it.
  // Layout: paddingX(1) + items joined by gap(2). Each item = "key label".
  const gap = 2;
  const fixedItems = [
    `Tab ${t("shortcuts_focus")}`,
    `j/k ${t("shortcuts_nav")}`,
    `/ ${t("shortcuts_search")}`,
  ];
  // CJK and other double-width characters occupy 2 terminal columns.
  const itemWidth = (s: string) => {
    let w = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0;
      if (
        (cp >= 0x1100 && cp <= 0x115F) ||
        (cp >= 0x2E80 && cp <= 0x303E) ||
        (cp >= 0x3040 && cp <= 0x33FF) ||
        (cp >= 0x3400 && cp <= 0x4DBF) ||
        (cp >= 0x4E00 && cp <= 0x9FFF) ||
        (cp >= 0xAC00 && cp <= 0xD7FF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFF00 && cp <= 0xFF60) ||
        (cp >= 0x1B000 && cp <= 0x1B0FF) ||
        (cp >= 0x20000 && cp <= 0x2FFFD) ||
        (cp >= 0x30000 && cp <= 0x3FFFD)
      ) {
        w += 2;
      } else {
        w += 1;
      }
    }
    return w;
  };
  let logOffset = 1; // paddingX left
  if (!inputFocused && !searchMode) {
    for (const s of fixedItems) {
      logOffset += itemWidth(s) + gap;
    }
    for (const action of mainActions) {
      if (action === "toggle_logs") break;
      const b = ACTION_BINDINGS[action];
      logOffset += itemWidth(b.keyDisplay + " " + t(("action_" + action) as StringKey)) + gap;
    }
  }

  return (
    <Box flexDirection="column" height={3}>
      {/* Line 1: main keybindings */}
      <Box paddingX={1} gap={2}>
        {searchMode ? (
          <>
            <Text><Text bold color="white">j/k</Text><Text dimColor> {t("shortcuts_nav")}</Text></Text>
            <Text><Text bold color="white">⏎</Text><Text dimColor> {t("shortcuts_select")}</Text></Text>
            <Text><Text bold color="white">Esc</Text><Text dimColor> {t("shortcuts_cancel")}</Text></Text>
          </>
        ) : (
          <>
            <Text><Text bold color="white">Tab</Text><Text dimColor> {t("shortcuts_focus")}</Text></Text>
            {!inputFocused && (
              <>
                <Text><Text bold color="white">j/k</Text><Text dimColor> {t("shortcuts_nav")}</Text></Text>
                <Text><Text bold color="white">/</Text><Text dimColor> {t("shortcuts_search")}</Text></Text>
                {mainActions.map((action) => (
                  <Text key={action}>
                    <Text bold color="white">{ACTION_BINDINGS[action].keyDisplay}</Text>
                    <Text dimColor> {t(("action_" + action) as StringKey)}</Text>
                  </Text>
                ))}
                <Text><Text bold color="white">q</Text><Text dimColor> {t("shortcuts_quit")}</Text></Text>
              </>
            )}
          </>
        )}
      </Box>
      {/* Line 2: "c copy" under "l logs" | "agent" label right-aligned */}
      <Box paddingX={1} justifyContent="space-between">
        <Box paddingLeft={logOffset - 1}>
          {logSubActions.includes("copy_logs") ? (
            <Text>
              <Text bold color="white">{ACTION_BINDINGS.copy_logs.keyDisplay}</Text>
              <Text dimColor> {t("action_copy_logs")}</Text>
            </Text>
          ) : <Text>{" "}</Text>}
        </Box>
        {preflight && (
          <Text color="blue">{t("label_agent")}</Text>
        )}
      </Box>
      {/* Line 3: "v verbose" under "c copy" | credential type right-aligned */}
      <Box paddingX={1} justifyContent="space-between">
        <Box paddingLeft={logOffset - 1}>
          {logSubActions.includes("toggle_verbose") ? (
            <Text>
              <Text bold color="white">{ACTION_BINDINGS.toggle_verbose.keyDisplay}</Text>
              <Text dimColor> {t("action_toggle_verbose")}</Text>
              {verboseMode && <Text dimColor italic>{t("shortcuts_verbose_on")}</Text>}
            </Text>
          ) : <Text>{" "}</Text>}
        </Box>
        {preflight && (
          <Text dimColor={preflight.credentialType !== "none"} color={preflight.credentialType === "none" ? "red" : undefined}>
            {preflight.credentialType === "subscription" ? t("cred_subscription") : preflight.credentialType === "api-token" ? t("cred_api_token") : t("cred_none")}
          </Text>
        )}
      </Box>
    </Box>
  );
}
