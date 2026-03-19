import { Box, Text, useApp, useStdout } from "ink";
import { Spinner } from "@inkjs/ui";
import React, { useState, useEffect, useRef } from "react";
import { deerboxConfig, deerboxPreflight } from "./deerbox";
import type { DeerConfig, PreflightResult } from "./types";
import { t } from "./i18n";
import { ShortcutsBar } from "./components/ShortcutsBar";
import { LogDetailPanel } from "./components/LogDetailPanel";
import { ContextPicker } from "./components/ContextPicker";
import { ContextChipBar } from "./components/ContextChipBar";
import { resolveChips } from "./context/resolve";
import { CONTEXT_SOURCES } from "./context/sources/index";
import type { ContextChip } from "./context/types";
import { PromptInput } from "./components/PromptInput";
import { useAgentSync } from "./hooks/useAgentSync";
import { releaseAllPollers } from "./db";
import { usePrPoller } from "./hooks/useLivePRState";
import { useAgentActions } from "./hooks/useAgentActions";
import { usePromptHistory } from "./hooks/usePromptHistory";
import { useKeyboardInput } from "./hooks/useKeyboardInput";
import {
  STATUS_DISPLAY,
  truncate,
  formatTime,
  formatCost,
  isActive,
  prStateColor,
} from "./dashboard-utils";
import {
  UPLOAD_FRAMES,
  MAX_VISIBLE_LOGS,
  LOG_LINES_PER_ENTRY,
  ENTRY_ROWS_BASE,
  ENTRY_ROWS_WITH_PR,
} from "./constants";
import type { AgentState } from "./agent-state";

export { stripAnsi } from "./dashboard-utils";

export default function Dashboard({ cwd, mockAgents }: { cwd: string; mockAgents?: AgentState[] }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 80;
  const termHeight = stdout?.rows || 24;

  const [suspended, setSuspended] = useState(false);
  const [contextChips, setContextChips] = useState<ContextChip[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [inputEmpty, setInputEmpty] = useState(true);
  const [preflight, setPreflight] = useState<PreflightResult | null>(
    mockAgents ? { ok: true, errors: [], credentialType: "subscription" } : null,
  );
  const [logExpanded, setLogExpanded] = useState(false);
  const [animTick, setAnimTick] = useState(0);
  const configRef = useRef<DeerConfig | null>(null);

  const { agents, setAgents, agentsRef, baseBranchRef, liveSessionIdsRef, runtimeTaskIdsRef, reconcile, showAll, setShowAll } = useAgentSync(cwd, configRef, mockAgents);

  const {
    promptHistory,
    historyIdx,
    setHistoryIdx,
    inputDefault,
    setInputDefault,
    inputKey,
    setInputKey,
    addToHistory,
  } = usePromptHistory();

  usePrPoller(agentsRef, setAgents);

  const { spawnAgent, killAgent, abortAllAgents, attachToAgent, openShell, createPr, updatePr, deleteAgent, retryAgent, resumeLiveSession } = useAgentActions({
    cwd,
    setAgents,
    baseBranchRef,
    configRef,
    preflight,
    setSuspended,
    runtimeTaskIdsRef,
  });

  const {
    selectedIdx,
    inputFocused,
    pendingConfirmation,
    verboseMode,
    searchMode,
    searchQuery,
    searchMatchIdx,
    searchMatches,
  } = useKeyboardInput({
    suspended,
    pickerOpen,
    agents,
    setAgents,
    logExpanded,
    setLogExpanded,
    promptHistory,
    historyIdx,
    setHistoryIdx,
    setInputDefault,
    setInputKey,
    spawnAgent,
    killAgent,
    attachToAgent,
    openShell,
    createPr,
    updatePr,
    deleteAgent,
    retryAgent,
    exit,
    showAll,
    setShowAll,
  });

  // ── Load config + preflight + start config guard ───────────────────

  useEffect(() => {
    if (!mockAgents) deerboxPreflight().then(setPreflight).catch(() => {
      setPreflight({ ok: false, errors: [t("input_preflight_failed")], credentialType: "none" });
    });
    deerboxConfig(cwd).then((cfg) => {
      configRef.current = cfg;
      // Re-run reconcile immediately so proxies are restored for any
      // running cross-instance tasks without waiting for the 2s poll.
      reconcile();
    });
  }, [cwd]);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    const cleanup = () => {
      // Abort deer's own polling loops so state updates stop, but leave the
      // tmux sessions alive so agents continue running after a restart.
      abortAllAgents();
      releaseAllPollers(process.pid);
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });

    return () => {
      cleanup();
      process.removeListener("exit", cleanup);
    };
  }, [cwd]);

  // ── Resume sessions whose tmux pane survived a deer restart ──────

  useEffect(() => {
    if (liveSessionIdsRef.current.size === 0) return;
    for (const agent of agents) {
      if (liveSessionIdsRef.current.has(agent.taskId)) {
        liveSessionIdsRef.current.delete(agent.taskId);
        resumeLiveSession(agent);
      }
    }
  }, [agents]);

  // ── Animate upload icon when creating PR ─────────────────────────

  useEffect(() => {
    const anyCreating = agents.some((a) => a.creatingPr || a.updatingPr);
    if (!anyCreating) return;
    const interval = setInterval(() => setAnimTick((t) => t + 1), 200);
    return () => clearInterval(interval);
  }, [agents]);

  // ── Render nothing when suspended ─────────────────────────────────

  if (suspended) return null;

  // ── Derived state ─────────────────────────────────────────────────

  const clampedIdx = Math.min(selectedIdx, Math.max(agents.length - 1, 0));
  const activeCount = agents.filter(isActive).length;
  const selected = agents[clampedIdx] || null;
  const preflightOk = preflight?.ok ?? false;

  // Base chrome: header(1) + 2 separators(2) + input(1) + shortcuts(3) = 8.
  // Add picker height (query bar + up to 5 results) or chip bar (1 line) when visible.
  const contextChrome = pickerOpen ? 7 : contextChips.length > 0 ? 1 : 0;
  const chromeHeight = 8 + contextChrome;
  const detailHeight = logExpanded && selected ? Math.min(MAX_VISIBLE_LOGS + 1, 6) : 0;
  const listHeight = Math.max(termHeight - chromeHeight - detailHeight, 3);
  const hasPrEntries = agents.some((a) => a.result?.prUrl);
  const entryRows = hasPrEntries ? ENTRY_ROWS_WITH_PR : ENTRY_ROWS_BASE;
  const maxVisibleEntries = Math.max(Math.floor(listHeight / entryRows), 1);
  const isApiToken = preflight?.credentialType === "api-token";

  // ── Render ────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight}>
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold>{t("header_title")}</Text>
        <Box gap={2}>
          {showAll && <Text dimColor>all repos</Text>}
          <Text dimColor>{activeCount > 0 ? t("header_active", { n: activeCount }) : t("header_idle")}</Text>
        </Box>
      </Box>
      <Text>{"─".repeat(termWidth)}</Text>

      {/* Confirmation banners */}
      {pendingConfirmation && (
        <Box paddingX={1}>
          <Text color="yellow" bold>{pendingConfirmation.message}</Text>
        </Box>
      )}
      {/* Preflight errors */}
      {preflight && !preflight.ok && (
        <Box flexDirection="column" paddingX={1}>
          {preflight.errors.map((e) => (
            <Text key={e} color="red">✗ {e}</Text>
          ))}
        </Box>
      )}

      {/* Agent list */}
      <Box flexDirection="column" height={listHeight} paddingX={1}>
        {agents.length === 0 ? (
          <Box justifyContent="center" paddingY={1}>
            <Text dimColor>{t("agents_empty")}</Text>
          </Box>
        ) : (
          agents.slice(0, maxVisibleEntries).map((agent, i) => {
            const display = STATUS_DISPLAY[agent.status];
            const isSearchMatch = searchMode && searchMatches.some((m) => m.idx === i);
            const isSearchSelected = searchMode && searchMatches[searchMatchIdx]?.idx === i;
            const isSelected = searchMode ? isSearchSelected : (i === clampedIdx && !inputFocused);
            const pointer = isSelected ? "▸" : (isSearchMatch ? "·" : " ");

            const normalizedLogs = agent.logs.map((l) =>
              typeof l === "string" ? { text: l, verbose: false } : l,
            );
            const filteredLogs = verboseMode ? normalizedLogs : normalizedLogs.filter((l) => !l.verbose);
            const recentLogs = filteredLogs.slice(-LOG_LINES_PER_ENTRY);
            const prBadge = agent.result?.prUrl && agent.prState
              ? {
                  icon: agent.prState === "merged" ? "🟣" : agent.prState === "closed" ? "🔴" : "🟢",
                  color: prStateColor(agent.prState),
                }
              : null;
            const costStr = isApiToken && agent.cost != null ? formatCost(agent.cost) : null;
            const titleOverhead = 11 + (costStr ? costStr.length + 1 : 0);
            const titleWidth = Math.max(termWidth - titleOverhead - (prBadge ? 3 : 0), 5);
            const logWidth = Math.max(termWidth - 5, 5);

            return (
              <Box key={agent.taskId} flexDirection="column">
                {/* Title line */}
                <Box gap={1}>
                  <Box width={2}>
                    {agent.creatingPr || agent.updatingPr ? (
                      <Text color="blue">{UPLOAD_FRAMES[animTick % UPLOAD_FRAMES.length]}</Text>
                    ) : agent.idle ? (
                      <Text>{agent.result?.prUrl ? "👀" : "👋"}</Text>
                    ) : agent.status === "running" ? (
                      <Spinner label="" />
                    ) : (
                      <Text color={display.color}>{display.icon}</Text>
                    )}
                  </Box>
                  <Text dimColor={!isSelected}>{pointer}</Text>
                  <Box flexGrow={1}>
                    <Text bold={isSelected} underline={isSelected} wrap="truncate">
                      {truncate(agent.prompt, titleWidth)}
                    </Text>
                  </Box>
                  {prBadge && <Text>{prBadge.icon}</Text>}
                  <Text dimColor>{formatTime(agent.elapsed)}</Text>
                  {costStr && <Text dimColor>{costStr}</Text>}
                </Box>
                {/* PR link line */}
                {agent.result?.prUrl && (
                  <Box paddingLeft={3}>
                    <Text
                      dimColor={!isSelected}
                      color={prStateColor(agent.prState)}
                      wrap="truncate"
                    >
                      {truncate(agent.result.prUrl, logWidth)}
                    </Text>
                  </Box>
                )}
                {/* Log lines */}
                {recentLogs.map((entry, j) => (
                  <Box key={j} paddingLeft={3}>
                    <Text dimColor wrap="truncate">
                      {truncate(entry.text, logWidth)}
                    </Text>
                  </Box>
                ))}
              </Box>
            );
          })
        )}
      </Box>

      {/* Log detail panel */}
      {logExpanded && selected && (
        <LogDetailPanel
          agent={selected}
          height={detailHeight}
          termWidth={termWidth}
          verboseMode={verboseMode}
        />
      )}

      {/* Input divider + context picker/chips + input bar */}
      <Text>{"─".repeat(termWidth)}</Text>
      {pickerOpen && (
        <ContextPicker
          repoPath={cwd}
          onSelect={(chip) => {
            const limit = CONTEXT_SOURCES.find((s) => s.type === chip.type)?.limit;
            setContextChips((prev) => {
              if (limit === undefined || prev.filter((c) => c.type === chip.type).length < limit) {
                return [...prev, chip];
              }
              // Limit reached: remove the last chip of this type (LIFO), append the new one
              let evicted = false;
              const next = prev.reduceRight<ContextChip[]>((acc, c) => {
                if (!evicted && c.type === chip.type) { evicted = true; return acc; }
                return [c, ...acc];
              }, []);
              return [...next, chip];
            });
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
      {!pickerOpen && <ContextChipBar chips={contextChips} />}
      <Box paddingX={1} gap={1}>
        {searchMode ? (
          <>
            <Text color="yellow">{"/"}</Text>
            <Text>
              {searchQuery}
              <Text inverse> </Text>
            </Text>
            {searchMatches.length > 0 && (
              <Text dimColor>
                {searchMatchIdx + 1}/{searchMatches.length}
              </Text>
            )}
            {searchQuery.length > 0 && searchMatches.length === 0 && (
              <Text dimColor color="red">{t("search_no_matches")}</Text>
            )}
          </>
        ) : (
          <>
            <Text dimColor>{">"}</Text>
            {inputFocused ? (
              <PromptInput
                key={inputKey}
                placeholder={!preflightOk ? t("input_preflight_failed") : t("input_placeholder")}
                isDisabled={!preflightOk || pickerOpen}
                defaultValue={inputDefault}
                onAtPrefix={() => setPickerOpen(true)}
                onBackspaceOnEmpty={() => setContextChips((prev) => prev.slice(0, -1))}
                onChange={(v) => setInputEmpty(v.length === 0)}
                onSubmit={(value) => {
                  if (value.trim()) {
                    addToHistory(value);
                    const { baseBranch } = resolveChips(contextChips);
                    spawnAgent(value, baseBranch);
                    setContextChips([]);
                    setInputEmpty(true);
                  }
                }}
              />
            ) : (
              <Text dimColor italic>{t("input_tab_hint")}</Text>
            )}
          </>
        )}
      </Box>

      {/* Footer / keybindings (fixed 3-line height) */}
      <Text>{"─".repeat(termWidth)}</Text>
      <ShortcutsBar
        selected={selected}
        inputFocused={inputFocused}
        inputEmpty={inputEmpty}
        searchMode={searchMode}
        verboseMode={verboseMode}
        logExpanded={logExpanded}
        preflight={preflight}
        showAll={showAll}
      />
    </Box>
  );
}
