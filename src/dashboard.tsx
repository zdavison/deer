import { Box, Text, useApp, useStdout } from "ink";
import { Spinner } from "@inkjs/ui";
import React, { useState, useEffect, useRef } from "react";
import { loadConfig } from "./config";
import type { DeerConfig } from "./config";
import { ShortcutsBar } from "./components/ShortcutsBar";
import { LogDetailPanel } from "./components/LogDetailPanel";
import { runPreflight, type PreflightResult } from "./preflight";
import { PromptInput } from "./components/PromptInput";
import { useAgentSync } from "./hooks/useAgentSync";
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

export { stripAnsi } from "./dashboard-utils";

export default function Dashboard({ cwd }: { cwd: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 80;
  const termHeight = stdout?.rows || 24;

  const [suspended, setSuspended] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const [animTick, setAnimTick] = useState(0);
  const configRef = useRef<DeerConfig | null>(null);

  const { agents, setAgents, agentsRef, deletedTaskIdsRef, baseBranchRef, restoredProxiesRef, liveSessionIdsRef, syncWithHistory } = useAgentSync(cwd, configRef);

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
    deletedTaskIdsRef,
    baseBranchRef,
    configRef,
    preflight,
    setSuspended,
  });

  const {
    selectedIdx,
    inputFocused,
    setInputFocused,
    confirmQuit,
    pendingConfirmation,
    verboseMode,
    searchMode,
    searchQuery,
    searchMatchIdx,
    searchMatches,
  } = useKeyboardInput({
    suspended,
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
  });

  // ── Load config + preflight + start config guard ───────────────────

  useEffect(() => {
    runPreflight().then(setPreflight);
    loadConfig(cwd).then((cfg) => {
      configRef.current = cfg;
      // Re-run sync immediately so proxies are restored for any
      // running cross-instance tasks without waiting for the 2s poll.
      syncWithHistory();
    });
  }, [cwd]);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    const cleanup = () => {
      // Abort deer's own polling loops so state updates stop, but leave the
      // tmux sessions alive so agents continue running after a restart.
      abortAllAgents();
      for (const proxyCleanup of restoredProxiesRef.current.values()) {
        proxyCleanup();
      }
      restoredProxiesRef.current.clear();
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });

    return () => {
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

  const chromeHeight = 8;
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
        <Text bold>🦌 deer</Text>
        <Text dimColor>{activeCount > 0 ? `${activeCount} active` : "idle"}</Text>
      </Box>
      <Text>{"─".repeat(termWidth)}</Text>

      {/* Confirmation banners */}
      {pendingConfirmation && (
        <Box paddingX={1}>
          <Text color="yellow" bold>{pendingConfirmation.message}</Text>
        </Box>
      )}
      {confirmQuit && (
        <Box paddingX={1}>
          <Text color="yellow" bold>
            {activeCount} agent{activeCount !== 1 ? "s" : ""} running — quit? (y/n)
          </Text>
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
            <Text dimColor>Type a prompt below and press Enter to launch an agent</Text>
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

      {/* Input divider + input bar */}
      <Text>{"─".repeat(termWidth)}</Text>
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
              <Text dimColor color="red">no matches</Text>
            )}
          </>
        ) : (
          <>
            <Text dimColor>{">"}</Text>
            {inputFocused ? (
              <PromptInput
                key={inputKey}
                placeholder={!preflightOk ? "preflight checks failed" : "type prompt and press Enter to launch agent (Shift+Enter or /↵ for newline)"}
                isDisabled={!preflightOk}
                defaultValue={inputDefault}
                onSubmit={(value) => {
                  if (value.trim()) {
                    addToHistory(value);
                    spawnAgent(value);
                  }
                }}
              />
            ) : (
              <Text dimColor italic>press Tab to type a prompt</Text>
            )}
          </>
        )}
      </Box>

      {/* Footer / keybindings (fixed 3-line height) */}
      <Text>{"─".repeat(termWidth)}</Text>
      <ShortcutsBar
        selected={selected}
        inputFocused={inputFocused}
        searchMode={searchMode}
        verboseMode={verboseMode}
        logExpanded={logExpanded}
        preflight={preflight}
      />
    </Box>
  );
}
