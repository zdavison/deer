import { useState } from "react";
import { useInput } from "ink";
import type { AgentState } from "../agent-state";
import type { Dispatch, SetStateAction } from "react";
import { availableActions, resolveKeypress, confirmationMessage, type AgentAction } from "../state-machine";
import { fuzzyMatch } from "../fuzzy";
import { openUrl, isActive } from "../dashboard-utils";

interface KeyboardInputDeps {
  suspended: boolean;
  agents: AgentState[];
  setAgents: Dispatch<SetStateAction<AgentState[]>>;
  logExpanded: boolean;
  setLogExpanded: Dispatch<SetStateAction<boolean>>;
  promptHistory: string[];
  historyIdx: number;
  setHistoryIdx: Dispatch<SetStateAction<number>>;
  setInputDefault: Dispatch<SetStateAction<string>>;
  setInputKey: Dispatch<SetStateAction<number>>;
  spawnAgent: (prompt: string, baseBranch?: string, continueSession?: { taskId: string; worktreePath: string; branch: string }) => Promise<void>;
  killAgent: (agent: AgentState) => void;
  attachToAgent: (agent: AgentState) => Promise<void>;
  openShell: (agent: AgentState) => Promise<void>;
  createPr: (agent: AgentState) => Promise<void>;
  updatePr: (agent: AgentState) => Promise<void>;
  deleteAgent: (agent: AgentState) => void;
  retryAgent: (agent: AgentState) => void;
  exit: () => void;
  showAll: boolean;
  setShowAll: Dispatch<SetStateAction<boolean>>;
}

function copyLogsToClipboard(agent: AgentState): void {
  const text = agent.logs.map((l) => typeof l === "string" ? l : l.text).join("\n");
  const cmd = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard";
  const [bin, ...args] = cmd.split(" ");
  const proc = Bun.spawn([bin, ...args], { stdin: "pipe" });
  proc.stdin.write(text);
  proc.stdin.end();
}

export function useKeyboardInput({
  suspended,
  agents,
  setAgents: _setAgents,
  logExpanded,
  setLogExpanded,
  promptHistory,
  historyIdx,
  setHistoryIdx,
  setInputDefault,
  setInputKey,
  spawnAgent: _spawnAgent,
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
}: KeyboardInputDeps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [inputFocused, setInputFocused] = useState(true);
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    action: AgentAction;
    agent: AgentState;
    message: string;
  } | null>(null);
  const [verboseMode, setVerboseMode] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);

  const searchMatches = searchMode
    ? agents.map((a, i) => ({ agent: a, idx: i })).filter(({ agent }) => fuzzyMatch(agent.prompt, searchQuery))
    : [];

  // ── Sub-handlers ──────────────────────────────────────────────────

  function handleSearchInput(input: string, key: Record<string, unknown>): boolean {
    if (!searchMode) return false;

    if (key.escape || (key.ctrl && input === "c")) {
      setSearchMode(false);
      setSearchQuery("");
      setSearchMatchIdx(0);
      return true;
    }
    if (key.return) {
      const matches = agents
        .map((a, i) => ({ agent: a, idx: i }))
        .filter(({ agent }) => fuzzyMatch(agent.prompt, searchQuery));
      const match = matches[searchMatchIdx];
      if (match) {
        setSelectedIdx(match.idx);
        setInputFocused(false);
      }
      setSearchMode(false);
      setSearchQuery("");
      setSearchMatchIdx(0);
      return true;
    }
    if (key.upArrow) {
      setSearchMatchIdx((prev) => Math.max(prev - 1, 0));
      return true;
    }
    if (key.downArrow) {
      const matchCount = agents.filter((a) => fuzzyMatch(a.prompt, searchQuery)).length;
      setSearchMatchIdx((prev) => Math.min(prev + 1, Math.max(matchCount - 1, 0)));
      return true;
    }
    if (key.backspace || key.delete) {
      setSearchQuery((prev) => prev.slice(0, -1));
      setSearchMatchIdx(0);
      return true;
    }
    if (input && !key.ctrl && !key.meta) {
      setSearchQuery((prev) => prev + input);
      setSearchMatchIdx(0);
      return true;
    }
    return true;
  }

  function handleQuitInput(input: string): boolean {
    if (input === "q" && !inputFocused) {
      exit();
      return true;
    }
    return false;
  }

  function handleConfirmationInput(input: string): boolean {
    if (pendingConfirmation) {
      if (input === "y" || input === "Y") {
        executeAction(pendingConfirmation.action, pendingConfirmation.agent);
      }
      setPendingConfirmation(null);
      return true;
    }

    return false;
  }

  function handleHistoryInput(key: Record<string, unknown>): boolean {
    if (!inputFocused || promptHistory.length === 0) return false;

    if (key.upArrow) {
      const nextIdx = historyIdx < promptHistory.length - 1 ? historyIdx + 1 : historyIdx;
      setHistoryIdx(nextIdx);
      setInputDefault(promptHistory[promptHistory.length - 1 - nextIdx]);
      setInputKey((k) => k + 1);
      return true;
    }
    if (key.downArrow) {
      const nextIdx = historyIdx > 0 ? historyIdx - 1 : -1;
      setHistoryIdx(nextIdx);
      setInputDefault(nextIdx === -1 ? "" : promptHistory[promptHistory.length - 1 - nextIdx]);
      setInputKey((k) => k + 1);
      return true;
    }
    return false;
  }

  function handleAgentListInput(input: string, key: Record<string, unknown>): void {
    if (inputFocused || agents.length === 0) return;

    if (input === "/") {
      setSearchMode(true);
      setSearchQuery("");
      setSearchMatchIdx(0);
      return;
    }

    if (input === "a") {
      setShowAll((prev) => !prev);
      return;
    }

    if (input === "j" || key.downArrow) {
      setSelectedIdx((prev) => Math.min(prev + 1, agents.length - 1));
    }
    if (input === "k" || key.upArrow) {
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }

    // Resolve agent-specific actions via state machine
    const clampedIdx = Math.min(selectedIdx, Math.max(agents.length - 1, 0));
    const agent = agents[clampedIdx];
    if (agent) {
      const ctx = {
        status: agent.status,
        hasPrUrl: !!agent.result?.prUrl,
        hasFinalBranch: !!agent.result?.finalBranch || !!agent.branch,
        hasHandle: agent.status === "running",
        isIdle: agent.idle,
        prState: agent.prState,
        hasWorktreePath: !!agent.taskId,
        logExpanded,
      };
      const actions = availableActions(ctx);
      const action = resolveKeypress(input, key as Parameters<typeof resolveKeypress>[1], actions);

      if (action) {
        const prompt = confirmationMessage(action, ctx);
        if (prompt) {
          setPendingConfirmation({ action, agent, message: prompt });
        } else {
          executeAction(action, agent);
        }
      }
    }
  }

  function executeAction(action: AgentAction, agent: AgentState) {
    switch (action) {
      case "attach":
        attachToAgent(agent);
        break;
      case "create_pr":
        createPr(agent);
        break;
      case "update_pr":
        updatePr(agent);
        break;
      case "open_pr":
        if (agent.result?.prUrl) openUrl(agent.result.prUrl);
        break;
      case "kill":
        killAgent(agent);
        break;
      case "delete":
        deleteAgent(agent);
        setSelectedIdx((prev) => Math.min(prev, Math.max(agents.length - 2, 0)));
        break;
      case "toggle_logs":
        setLogExpanded((prev) => !prev);
        break;
      case "copy_logs":
        copyLogsToClipboard(agent);
        break;
      case "toggle_verbose":
        setVerboseMode((prev) => !prev);
        break;
      case "retry":
        setSelectedIdx((prev) => Math.min(prev, Math.max(agents.length - 2, 0)));
        retryAgent(agent);
        break;
      case "open_shell":
        openShell(agent);
        break;
    }
  }

  // ── Main input handler ────────────────────────────────────────────

  useInput((input, key) => {
    if (suspended) return;

    if (handleSearchInput(input, key)) return;
    if (handleQuitInput(input)) return;
    if (handleConfirmationInput(input)) return;
    if (handleHistoryInput(key)) return;

    // Tab to toggle focus
    if (key.tab) {
      setInputFocused((prev) => !prev);
      return;
    }

    handleAgentListInput(input, key);
  });

  return {
    selectedIdx,
    inputFocused,
    setInputFocused,
    pendingConfirmation,
    verboseMode,
    searchMode,
    searchQuery,
    searchMatchIdx,
    searchMatches,
  };
}
