import { Box, Text, useApp, useStdout } from "ink";
import { Spinner } from "@inkjs/ui";
import React, { useState, useEffect, useRef } from "react";
import { loadConfig } from "./config";
import type { DeerConfig } from "./config";
import { availableActions, ACTION_BINDINGS } from "./state-machine";
import { startClaudeConfigGuard, type ClaudeConfigGuard, type ConfigAlert } from "./sandbox/claude-config-guard";
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
  const [configAlerts, setConfigAlerts] = useState<ConfigAlert[]>([]);
  const guardRef = useRef<ClaudeConfigGuard | null>(null);
  const configRef = useRef<DeerConfig | null>(null);

  const { agents, setAgents, agentsRef, deletedTaskIdsRef, baseBranchRef, restoredProxiesRef, syncWithHistory } = useAgentSync(cwd, configRef);

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

  const { spawnAgent, killAgent, abortAllAgents, attachToAgent, openShell, createPr, updatePr, deleteAgent, retryAgent } = useAgentActions({
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
    searchMode,
    searchQuery,
    searchMatchIdx,
    searchMatches,
  } = useKeyboardInput({
    suspended,
    agents,
    setAgents,
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
      // Re-run sync immediately so bwrap proxies are restored for any
      // running cross-instance tasks without waiting for the 2s poll.
      syncWithHistory();
    });
    startClaudeConfigGuard((alert) => {
      setConfigAlerts((prev) => [...prev, alert]);
    }).then((guard) => {
      guardRef.current = guard;
    }).catch(() => {});
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
      guardRef.current?.stop();
    };
  }, [cwd]);

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

  const chromeHeight = 6;
  const alertHeight = configAlerts.length > 0 ? Math.min(configAlerts.length, 3) + 2 + (configAlerts.length > 3 ? 1 : 0) : 0;
  const detailHeight = logExpanded && selected ? Math.min(MAX_VISIBLE_LOGS + 1, 6) : 0;
  const listHeight = Math.max(termHeight - chromeHeight - detailHeight - alertHeight, 3);
  const hasPrEntries = agents.some((a) => a.result?.prUrl);
  const entryRows = hasPrEntries ? ENTRY_ROWS_WITH_PR : ENTRY_ROWS_BASE;
  const maxVisibleEntries = Math.max(Math.floor(listHeight / entryRows), 1);

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

      {/* Config tampering alerts */}
      {configAlerts.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          <Text color="red" bold>
            {`${configAlerts.some((a) => a.severity === "critical") ? "!! SECURITY" : " ! WARNING"}: ~/.claude modified while agents running`}
          </Text>
          {configAlerts.slice(-3).map((alert, i) => (
            <Text key={i} color={alert.severity === "critical" ? "red" : "yellow"}>
              {alert.severity === "critical" ? "!!" : " !"} {alert.type}: {alert.file.replace(process.env.HOME ?? "", "~")}
            </Text>
          ))}
          {configAlerts.length > 3 && (
            <Text dimColor>   ...and {configAlerts.length - 3} more</Text>
          )}
          <Text>{"─".repeat(termWidth - 2)}</Text>
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

            const recentLogs = agent.logs.slice(-LOG_LINES_PER_ENTRY);
            const titleOverhead = 11;
            const prBadge = agent.result?.prUrl && agent.prState
              ? {
                  icon: agent.prState === "merged" ? "🟣" : agent.prState === "closed" ? "🔴" : "🟢",
                  color: prStateColor(agent.prState),
                }
              : null;
            const titleWidth = Math.max(termWidth - titleOverhead - (prBadge ? 3 : 0), 5);
            const logWidth = Math.max(termWidth - 5, 5);

            return (
              <Box key={agent.taskId} flexDirection="column">
                {/* Title line */}
                <Box gap={1}>
                  <Box width={2}>
                    {agent.creatingPr ? (
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
                    <Text bold={isSelected} wrap="truncate">
                      {truncate(agent.prompt, titleWidth)}
                    </Text>
                  </Box>
                  {prBadge && <Text>{prBadge.icon}</Text>}
                  <Text dimColor>{formatTime(agent.elapsed)}</Text>
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
                {recentLogs.map((line, j) => (
                  <Box key={j} paddingLeft={3}>
                    <Text dimColor wrap="truncate">
                      {truncate(line, logWidth)}
                    </Text>
                  </Box>
                ))}
              </Box>
            );
          })
        )}
      </Box>

      {/* Log detail panel */}
      {logExpanded && selected && (() => {
        const extraLines = (selected.result?.prUrl ? 1 : 0) + (selected.error ? 1 : 0);
        const visibleLogs = Math.max(MAX_VISIBLE_LOGS - extraLines, 1);
        return (
          <Box flexDirection="column" paddingX={1} height={detailHeight} overflowY="hidden">
            <Text dimColor>{"╌".repeat(termWidth - 2)}</Text>
            {selected.logs.slice(-visibleLogs).map((line, i) => (
              <Text key={i} dimColor wrap="truncate">
                {truncate(line, termWidth - 4)}
              </Text>
            ))}
            {selected.result?.prUrl && (
              <Text color={prStateColor(selected.prState)} bold>
                PR ({selected.prState ?? "checking…"}): {selected.result.prUrl}
              </Text>
            )}
            {selected.error && (
              <Text color="red">{truncate(selected.error, termWidth - 4)}</Text>
            )}
          </Box>
        );
      })()}

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

      {/* Footer / keybindings */}
      <Text>{"─".repeat(termWidth)}</Text>
      <Box paddingX={1} gap={2} justifyContent="space-between">
        <Box gap={2}>
          {searchMode ? (
            <>
              <Text dimColor>j/k nav</Text>
              <Text dimColor>⏎ select</Text>
              <Text dimColor>Esc cancel</Text>
            </>
          ) : (
            <>
              <Text dimColor>Tab focus</Text>
              {inputFocused ? null : (
                <>
                  <Text dimColor>j/k nav</Text>
                  <Text dimColor>/ search</Text>
                  {selected && availableActions({
                    status: selected.status,
                    hasPrUrl: !!selected.result?.prUrl,
                    hasFinalBranch: !!selected.result?.finalBranch || !!selected.branch,
                    hasHandle: selected.status === "running",
                    isIdle: selected.idle,
                    prState: selected.prState,
                    hasWorktreePath: !!selected.taskId,
                  }).map((action) => (
                    <Text key={action} dimColor>
                      {ACTION_BINDINGS[action].keyDisplay} {ACTION_BINDINGS[action].label}
                    </Text>
                  ))}
                  <Text dimColor>q quit</Text>
                </>
              )}
            </>
          )}
        </Box>
        {preflight && (
          <Text dimColor={preflight.credentialType !== "none"} color={preflight.credentialType === "none" ? "red" : undefined}>
            {preflight.credentialType === "subscription" ? "subscription" : preflight.credentialType === "api-token" ? "api-token" : "no credentials"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
