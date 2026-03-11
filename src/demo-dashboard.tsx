import { Box, Text, useApp, useInput, useStdout } from "ink";
import { Spinner } from "@inkjs/ui";
import React, { useState, useEffect } from "react";
import { ShortcutsBar } from "./components/ShortcutsBar";
import { LogDetailPanel } from "./components/LogDetailPanel";
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
  LOG_LINES_PER_ENTRY,
  ENTRY_ROWS_BASE,
  ENTRY_ROWS_WITH_PR,
} from "./constants";
import type { AgentState } from "./agent-state";

// ── Mock data ─────────────────────────────────────────────────────────

const MOCK_AGENTS: AgentState[] = [
  {
    taskId: "deer_demo0001",
    prompt: "Implement dark mode toggle for the settings page",
    baseBranch: "main",
    status: "running",
    elapsed: 247,
    lastActivity: "Writing CSS variables for dark theme tokens",
    logs: [
      { text: "Reading src/styles/theme.css", verbose: false },
      { text: "Identified 43 color tokens to update", verbose: false },
      { text: "Writing CSS variables for dark theme tokens", verbose: false },
    ],
    result: null,
    error: "",
    prState: null,
    historical: false,
    idle: false,
    creatingPr: false,
    updatingPr: false,
    deleted: false,
    createdAt: new Date(Date.now() - 247_000).toISOString(),
    worktreePath: "/home/user/.local/share/deer/tasks/deer_demo0001/worktree",
    branch: "deer/deer_demo0001",
    cost: null,
  },
  {
    taskId: "deer_demo0002",
    prompt: "Add CSV export to all data tables in the admin dashboard",
    baseBranch: "main",
    status: "running",
    elapsed: 583,
    lastActivity: "All done! I've added CSV export buttons to UsersTable, OrdersTable, and ProductsTable. Run bun test to verify.",
    logs: [
      { text: "Added exportToCsv() utility in src/lib/export.ts", verbose: false },
      { text: "Updated 3 table components with export button", verbose: false },
      { text: "All done! I've added CSV export buttons to UsersTable, OrdersTable, and ProductsTable. Run bun test to verify.", verbose: false },
    ],
    result: null,
    error: "",
    prState: null,
    historical: false,
    idle: true,
    creatingPr: false,
    updatingPr: false,
    deleted: false,
    createdAt: new Date(Date.now() - 583_000).toISOString(),
    worktreePath: "/home/user/.local/share/deer/tasks/deer_demo0002/worktree",
    branch: "deer/deer_demo0002",
    cost: null,
  },
  {
    taskId: "deer_demo0003",
    prompt: "Refactor user profile components to use the new design system",
    baseBranch: "main",
    status: "running",
    elapsed: 1204,
    lastActivity: "Pushing branch and opening pull request",
    logs: [
      { text: "Replaced 12 custom components with design system equivalents", verbose: false },
      { text: "Pushing branch and opening pull request", verbose: false },
    ],
    result: null,
    error: "",
    prState: null,
    historical: false,
    idle: false,
    creatingPr: true,
    updatingPr: false,
    deleted: false,
    createdAt: new Date(Date.now() - 1_204_000).toISOString(),
    worktreePath: "/home/user/.local/share/deer/tasks/deer_demo0003/worktree",
    branch: "deer/deer_demo0003",
    cost: null,
  },
  {
    taskId: "deer_demo0004",
    prompt: "Add unit tests for the payment processing module",
    baseBranch: "main",
    status: "running",
    elapsed: 892,
    lastActivity: "Tests passing — 94% coverage on payment module",
    logs: [
      { text: "Added 18 tests across 4 test files", verbose: false },
      { text: "Tests passing — 94% coverage on payment module", verbose: false },
    ],
    result: {
      finalBranch: "deer/deer_demo0004",
      prUrl: "https://github.com/acme/app/pull/142",
    },
    error: "",
    prState: "merged",
    historical: true,
    idle: false,
    creatingPr: false,
    updatingPr: false,
    deleted: false,
    createdAt: new Date(Date.now() - 892_000).toISOString(),
    worktreePath: "/home/user/.local/share/deer/tasks/deer_demo0004/worktree",
    branch: "deer/deer_demo0004",
    cost: null,
  },
  {
    taskId: "deer_demo0005",
    prompt: "Fix the N+1 query bug in the product listing endpoint",
    baseBranch: "main",
    status: "running",
    elapsed: 318,
    lastActivity: "Fixed by adding select_related() and prefetch_related() calls",
    logs: [
      { text: "Identified 3 endpoints with N+1 queries using django-debug-toolbar", verbose: false },
      { text: "Fixed by adding select_related() and prefetch_related() calls", verbose: false },
    ],
    result: {
      finalBranch: "deer/deer_demo0005",
      prUrl: "https://github.com/acme/app/pull/147",
    },
    error: "",
    prState: "open",
    historical: true,
    idle: false,
    creatingPr: false,
    updatingPr: false,
    deleted: false,
    createdAt: new Date(Date.now() - 318_000).toISOString(),
    worktreePath: "/home/user/.local/share/deer/tasks/deer_demo0005/worktree",
    branch: "deer/deer_demo0005",
    cost: null,
  },
  {
    taskId: "deer_demo0006",
    prompt: "Migrate the sessions table from MySQL to PostgreSQL",
    baseBranch: "main",
    status: "failed",
    elapsed: 741,
    lastActivity: "Migration script failed: column 'user_metadata' has unsupported JSON subtype",
    logs: [
      { text: "Running Alembic migration on staging database", verbose: false },
      { text: "Migration script failed: column 'user_metadata' has unsupported JSON subtype", verbose: false },
    ],
    result: null,
    error: "Migration script failed: column 'user_metadata' has unsupported JSON subtype",
    prState: null,
    historical: true,
    idle: false,
    creatingPr: false,
    updatingPr: false,
    deleted: false,
    createdAt: new Date(Date.now() - 741_000).toISOString(),
    worktreePath: "/home/user/.local/share/deer/tasks/deer_demo0006/worktree",
    branch: "deer/deer_demo0006",
    cost: null,
  },
  {
    taskId: "deer_demo0007",
    prompt: "Update API documentation for the v2 authentication endpoints",
    baseBranch: "main",
    status: "cancelled",
    elapsed: 95,
    lastActivity: "Cancelled by user",
    logs: [
      { text: "Reading existing OpenAPI spec", verbose: false },
    ],
    result: null,
    error: "",
    prState: null,
    historical: true,
    idle: false,
    creatingPr: false,
    updatingPr: false,
    deleted: false,
    createdAt: new Date(Date.now() - 95_000).toISOString(),
    worktreePath: "",
    branch: "deer/deer_demo0007",
    cost: null,
  },
];

// ── Demo Dashboard ─────────────────────────────────────────────────────

export default function DemoDashboard() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 120;
  const termHeight = stdout?.rows || 32;

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [logExpanded, setLogExpanded] = useState(false);
  const [animTick, setAnimTick] = useState(0);

  // Animate upload icon
  useEffect(() => {
    const interval = setInterval(() => setAnimTick((t) => t + 1), 200);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(MOCK_AGENTS.length - 1, i + 1));
    }
    if (input === "l") {
      setLogExpanded((v) => !v);
    }
  });

  const agents = MOCK_AGENTS;
  const clampedIdx = Math.min(selectedIdx, agents.length - 1);
  const selected = agents[clampedIdx] || null;
  const activeCount = agents.filter(isActive).length;

  const MAX_VISIBLE_LOGS = 5;
  const chromeHeight = 8;
  const detailHeight = logExpanded && selected ? Math.min(MAX_VISIBLE_LOGS + 1, 6) : 0;
  const listHeight = Math.max(termHeight - chromeHeight - detailHeight, 3);
  const hasPrEntries = agents.some((a) => a.result?.prUrl);
  const entryRows = hasPrEntries ? ENTRY_ROWS_WITH_PR : ENTRY_ROWS_BASE;
  const maxVisibleEntries = Math.max(Math.floor(listHeight / entryRows), 1);

  // Fake preflight for ShortcutsBar
  const fakePreflight = { ok: true, errors: [], credentialType: "subscription" as const };

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight}>
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold>🦌 deer</Text>
        <Text dimColor>{activeCount > 0 ? `${activeCount} active` : "idle"}</Text>
      </Box>
      <Text>{"─".repeat(termWidth)}</Text>

      {/* Agent list */}
      <Box flexDirection="column" height={listHeight} paddingX={1}>
        {agents.slice(0, maxVisibleEntries).map((agent, i) => {
          const display = STATUS_DISPLAY[agent.status];
          const isSelected = i === clampedIdx;
          const pointer = isSelected ? "▸" : " ";

          const recentLogs = agent.logs.slice(-LOG_LINES_PER_ENTRY);
          const prBadge = agent.result?.prUrl && agent.prState
            ? {
                icon: agent.prState === "merged" ? "🟣" : agent.prState === "closed" ? "🔴" : "🟢",
                color: prStateColor(agent.prState),
              }
            : null;
          const titleOverhead = 11 + (prBadge ? 3 : 0);
          const titleWidth = Math.max(termWidth - titleOverhead, 5);
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
        })}
      </Box>

      {/* Log detail panel */}
      {logExpanded && selected && (
        <LogDetailPanel
          agent={selected}
          height={detailHeight}
          termWidth={termWidth}
          verboseMode={false}
        />
      )}

      {/* Input divider + input bar */}
      <Text>{"─".repeat(termWidth)}</Text>
      <Box paddingX={1} gap={1}>
        <Text dimColor>{">"}</Text>
        <Text dimColor italic>demo mode — press q to quit, ↑↓ to navigate, l to toggle logs</Text>
      </Box>

      {/* Footer */}
      <Text>{"─".repeat(termWidth)}</Text>
      <ShortcutsBar
        selected={selected}
        inputFocused={false}
        searchMode={false}
        verboseMode={false}
        logExpanded={logExpanded}
        preflight={fakePreflight}
      />
    </Box>
  );
}
