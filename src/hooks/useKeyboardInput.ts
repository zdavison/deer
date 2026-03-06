import { useState, useCallback } from "react";
import { useInput } from "ink";
import type { AgentState } from "../agent-state";
import type { Dispatch, SetStateAction } from "react";
import { availableActions, resolveKeypress, ACTION_BINDINGS } from "../state-machine";
import { fuzzyMatch } from "../fuzzy";
import { openUrl, isActive } from "../dashboard-utils";

interface KeyboardInputDeps {
  suspended: boolean;
  agents: AgentState[];
  setAgents: Dispatch<SetStateAction<AgentState[]>>;
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
  exit: () => void;
}

export function useKeyboardInput({
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
  exit,
}: KeyboardInputDeps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [inputFocused, setInputFocused] = useState(true);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);

  const searchMatches = searchMode
    ? agents.map((a, i) => ({ agent: a, idx: i })).filter(({ agent }) => fuzzyMatch(agent.prompt, searchQuery))
    : [];

  useInput((input, key) => {
    if (suspended) return;

    // Search mode: capture all input for the search query
    if (searchMode) {
      if (key.escape || (key.ctrl && input === "c")) {
        setSearchMode(false);
        setSearchQuery("");
        setSearchMatchIdx(0);
        return;
      }
      if (key.return) {
        // Select the currently highlighted search match
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
        return;
      }
      if (key.upArrow) {
        const matchCount = agents.filter((a) => fuzzyMatch(a.prompt, searchQuery)).length;
        setSearchMatchIdx((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (key.downArrow) {
        const matchCount = agents.filter((a) => fuzzyMatch(a.prompt, searchQuery)).length;
        setSearchMatchIdx((prev) => Math.min(prev + 1, Math.max(matchCount - 1, 0)));
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((prev) => prev.slice(0, -1));
        setSearchMatchIdx(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearchQuery((prev) => prev + input);
        setSearchMatchIdx(0);
        return;
      }
      return;
    }

    const clampedIdx = Math.min(selectedIdx, Math.max(agents.length - 1, 0));

    // Quit handling
    if (input === "q" && !inputFocused) {
      const running = agents.filter(isActive);
      if (running.length > 0 && !confirmQuit) {
        setConfirmQuit(true);
        return;
      }
      for (const a of running) killAgent(a);
      exit();
      return;
    }

    // Confirm quit
    if (confirmQuit) {
      if (input === "y" || input === "Y") {
        const running = agents.filter(isActive);
        for (const a of running) killAgent(a);
        exit();
      } else {
        setConfirmQuit(false);
      }
      return;
    }

    // Prompt history navigation (when input focused)
    if (inputFocused && promptHistory.length > 0) {
      if (key.upArrow) {
        const nextIdx = historyIdx < promptHistory.length - 1 ? historyIdx + 1 : historyIdx;
        setHistoryIdx(nextIdx);
        setInputDefault(promptHistory[promptHistory.length - 1 - nextIdx]);
        setInputKey((k) => k + 1);
        return;
      }
      if (key.downArrow) {
        const nextIdx = historyIdx > 0 ? historyIdx - 1 : -1;
        setHistoryIdx(nextIdx);
        setInputDefault(nextIdx === -1 ? "" : promptHistory[promptHistory.length - 1 - nextIdx]);
        setInputKey((k) => k + 1);
        return;
      }
    }

    // Tab to toggle focus
    if (key.tab) {
      setInputFocused((prev) => !prev);
      return;
    }

    // List navigation (when list focused)
    if (!inputFocused && agents.length > 0) {
      if (input === "/") {
        setSearchMode(true);
        setSearchQuery("");
        setSearchMatchIdx(0);
        return;
      }

      if (input === "j" || key.downArrow) {
        setSelectedIdx((prev) => Math.min(prev + 1, agents.length - 1));
      }
      if (input === "k" || key.upArrow) {
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      }

      // Resolve agent-specific actions via state machine
      const agent = agents[clampedIdx];
      if (agent) {
        const ctx = {
          status: agent.status,
          hasPrUrl: !!agent.result?.prUrl,
          hasFinalBranch: !!agent.result?.finalBranch || !!agent.handle?.branch,
          hasHandle: !!agent.handle,
          isIdle: agent.idle,
          prState: agent.prState,
          hasWorktreePath: !!agent.taskId,
        };
        const actions = availableActions(ctx);
        const action = resolveKeypress(input, key, actions);

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
          case "retry": {
            const retryPrompt = agent.prompt;
            const retryHandle = agent.handle;
            agent.abortController?.abort();
            if (agent.timer) clearInterval(agent.timer);
            setSelectedIdx((prev) => Math.min(prev, Math.max(agents.length - 2, 0)));

            if (retryHandle) {
              // Kill the tmux session but preserve the worktree so Claude can
              // continue the same conversation with --continue.
              retryHandle.kill().catch(() => {});
              setAgents((prev) => prev.filter((a) => a !== agent));
              spawnAgent(retryPrompt, agent.baseBranch, {
                taskId: retryHandle.taskId,
                worktreePath: retryHandle.worktreePath,
                branch: retryHandle.branch,
              });
            } else {
              deleteAgent(agent);
              spawnAgent(retryPrompt, agent.baseBranch);
            }
            break;
          }
          case "open_shell":
            openShell(agent);
            break;
        }
      }
    }
  });

  return {
    selectedIdx,
    inputFocused,
    setInputFocused,
    confirmQuit,
    searchMode,
    searchQuery,
    searchMatchIdx,
    searchMatches,
  };
}
