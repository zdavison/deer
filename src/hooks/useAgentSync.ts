import { join } from "node:path";
import { useState, useEffect, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";
import { loadHistory, dataDir } from "../task";
import { isTmuxSessionDead, captureTmuxPane } from "../sandbox/index";
import type { SandboxCleanup } from "../sandbox/index";
import { resolveRuntime } from "../sandbox/resolve";
import { detectRepo } from "../git/worktree";
import { type AgentState, historicalAgent, crossInstanceAgent } from "../agent-state";
import type { DeerConfig } from "../config";
import { stripAnsi, IDLE_THRESHOLD } from "../dashboard-utils";

export function useAgentSync(cwd: string, configRef: MutableRefObject<DeerConfig | null>) {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const nextId = useRef(1);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const deletedTaskIdsRef = useRef(new Set<string>());
  const baseBranchRef = useRef("main");
  /** Proxy cleanup functions for cross-instance tasks restored after a restart */
  const restoredProxiesRef = useRef(new Map<string, SandboxCleanup>());
  /** Pane snapshot state for idle detection on cross-instance tasks */
  const crossInstancePaneStateRef = useRef(new Map<string, { snapshot: string; unchangedCount: number }>());

  // ── Detect base branch on mount ────────────────────────────────────

  useEffect(() => {
    detectRepo(cwd).then((info) => {
      baseBranchRef.current = info.defaultBranch;
    }).catch(() => {});
  }, [cwd]);

  // ── Sync state from history file ──────────────────────────────────

  const syncWithHistory = useCallback(async () => {
    const allFileTasks = await loadHistory(cwd);
    const fileTasks = allFileTasks.filter(t => !deletedTaskIdsRef.current.has(t.taskId));
    const currentAgents = agentsRef.current;
    const agentByTaskId = new Map(currentAgents.map(a => [a.taskId, a]));
    const fileTaskIds = new Set(fileTasks.map(t => t.taskId));

    const newAgents: AgentState[] = await Promise.all(fileTasks.map(async task => {
      const existing = agentByTaskId.get(task.taskId);
      if (existing && !existing.historical) {
        return existing;
      }
      const id = existing?.id ?? nextId.current++;

      // For running tasks not managed by this instance, check if the tmux
      // session is still alive to distinguish cross-instance tasks from
      // truly interrupted ones.
      if (task.status === "running") {
        const isDead = await isTmuxSessionDead(`deer-${task.taskId}`);
        if (!isDead) {
          // Restore the bwrap proxy once per task so the sandbox can reach
          // the Claude API after a deer restart.
          if (!restoredProxiesRef.current.has(task.taskId) && configRef.current) {
            const runtime = resolveRuntime(configRef.current);
            const worktreePath = join(dataDir(), "tasks", task.taskId, "worktree");
            const cleanup = await runtime.restoreProxy?.(worktreePath, configRef.current.network.allowlist);
            if (cleanup) restoredProxiesRef.current.set(task.taskId, cleanup);
          }

          // Detect idle by comparing consecutive pane snapshots across sync ticks
          const sessionName = `deer-${task.taskId}`;
          const lines = await captureTmuxPane(sessionName);
          let idle = false;
          if (lines) {
            const snapshot = lines.map(stripAnsi).map((l) => l.trim()).filter(Boolean).join("\n");
            const paneState = crossInstancePaneStateRef.current.get(task.taskId) ?? { snapshot: "", unchangedCount: 0 };
            if (snapshot === paneState.snapshot) {
              paneState.unchangedCount++;
            } else {
              paneState.unchangedCount = 0;
              paneState.snapshot = snapshot;
            }
            crossInstancePaneStateRef.current.set(task.taskId, paneState);
            idle = paneState.unchangedCount >= IDLE_THRESHOLD;
          }

          return crossInstanceAgent(task, id, idle);
        }
        // Session died — stop any proxy we restored for this task and clear pane state
        const proxyCleanup = restoredProxiesRef.current.get(task.taskId);
        if (proxyCleanup) {
          proxyCleanup();
          restoredProxiesRef.current.delete(task.taskId);
        }
        crossInstancePaneStateRef.current.delete(task.taskId);
        // Fall through to historicalAgent (shows as interrupted)
      }

      return historicalAgent(task, id);
    }));

    for (const agent of currentAgents) {
      if (!agent.historical && !fileTaskIds.has(agent.taskId)) {
        newAgents.push(agent);
      }
    }

    const changed =
      newAgents.length !== currentAgents.length ||
      newAgents.some((a, i) => {
        const cur = currentAgents[i];
        return !cur || a.taskId !== cur.taskId || a.status !== cur.status || a.lastActivity !== cur.lastActivity || a.idle !== cur.idle;
      });

    if (changed) setAgents(newAgents);
  }, [cwd]);

  // ── Load history on mount ──────────────────────────────────────────

  useEffect(() => {
    syncWithHistory();
  }, [syncWithHistory]);

  // ── Poll history file for changes from other deer instances ────────

  useEffect(() => {
    const interval = setInterval(syncWithHistory, 2_000);
    return () => clearInterval(interval);
  }, [syncWithHistory]);

  return { agents, setAgents, agentsRef, nextId, deletedTaskIdsRef, baseBranchRef, restoredProxiesRef, syncWithHistory };
}
