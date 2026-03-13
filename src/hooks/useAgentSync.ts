import { join } from "node:path";
import { useState, useEffect, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";
import { dataDir } from "../task";
import type { SandboxCleanup } from "../sandbox/index";
import { isTmuxSessionDead, captureTmuxPane } from "../sandbox/index";
import { resolveRuntime } from "../sandbox/resolve";
import { detectRepo } from "../git/worktree";
import { type AgentState, agentFromDbRow } from "../agent-state";
import { getTasksByRepo, getAllTasks, updateTask, type TaskRow } from "../db";
import type { DeerConfig } from "../config";
import { DB_RECONCILE_INTERVAL_MS } from "../constants";
import { stripAnsi, truncate } from "../dashboard-utils";

export function useAgentSync(cwd: string, configRef: MutableRefObject<DeerConfig | null>, mockAgents?: AgentState[]) {
  const [agents, setAgents] = useState<AgentState[]>(mockAgents ?? []);
  const [showAll, setShowAll] = useState(false);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const baseBranchRef = useRef("main");
  /** Proxy cleanup functions for cross-instance tasks restored after a restart */
  const restoredProxiesRef = useRef(new Map<string, SandboxCleanup>());
  /**
   * Task IDs that have live tmux sessions after a deer restart. The dashboard
   * watches this ref and calls resumeLiveSession for each entry.
   */
  const liveSessionIdsRef = useRef(new Set<string>());
  /** Task IDs being actively polled by this instance (set by useAgentActions) */
  const runtimeTaskIdsRef = useRef(new Set<string>());

  // ── Detect base branch on mount ────────────────────────────────────

  useEffect(() => {
    if (mockAgents) return;
    detectRepo(cwd).then((info) => {
      baseBranchRef.current = info.defaultBranch;
    }).catch(() => {});
  }, [cwd]);

  // ── Reconcile state from SQLite ────────────────────────────────────

  const reconcile = useCallback(async () => {
    if (mockAgents) return;

    const rows: TaskRow[] = showAll ? getAllTasks() : getTasksByRepo(cwd);
    const currentAgents = agentsRef.current;
    const agentByTaskId = new Map(currentAgents.map(a => [a.taskId, a]));

    const newAgents: AgentState[] = [];

    for (const row of rows) {
      const existing = agentByTaskId.get(row.task_id);

      // If this instance is actively polling this task, keep the in-memory agent
      // (it has live logs and real-time state)
      if (existing && runtimeTaskIdsRef.current.has(row.task_id)) {
        newAgents.push(existing);
        continue;
      }

      const isActiveStatus = row.status === "running" || row.status === "setup";

      if (isActiveStatus) {
        const sessionName = `deer-${row.task_id}`;
        const tmuxAlive = !(await isTmuxSessionDead(sessionName));

        if (tmuxAlive) {
          // Restore auth proxy for cross-instance tasks
          if (!restoredProxiesRef.current.has(row.task_id) && configRef.current) {
            const runtime = resolveRuntime(configRef.current);
            const worktreePath = join(dataDir(), "tasks", row.task_id, "worktree");
            const cleanup = await runtime.restoreProxy?.(worktreePath, configRef.current.network.allowlist);
            if (cleanup) restoredProxiesRef.current.set(row.task_id, cleanup);
          }

          // If no instance is polling this task, flag it for resume
          if (row.poller_pid === null || row.poller_pid === 0) {
            if (!liveSessionIdsRef.current.has(row.task_id)) {
              liveSessionIdsRef.current.add(row.task_id);
            }
          }

          // Build agent from DB row; populate logs from tmux pane capture
          const agent = agentFromDbRow(row, true);
          const lines = await captureTmuxPane(sessionName);
          if (lines) {
            const lastOutput = lines
              .map(stripAnsi)
              .map((l) => l.trim())
              .filter((l) => l.startsWith("\u25CF"))
              .pop();
            if (lastOutput) {
              agent.lastActivity = truncate(lastOutput, 120);
            }
          }
          newAgents.push(agent);
        } else {
          // Tmux is dead — mark as interrupted in DB
          updateTask(row.task_id, {
            status: "interrupted",
            finishedAt: Date.now(),
          });

          // Clean up restored proxy
          const proxyCleanup = restoredProxiesRef.current.get(row.task_id);
          if (proxyCleanup) {
            proxyCleanup();
            restoredProxiesRef.current.delete(row.task_id);
          }

          const agent = agentFromDbRow({ ...row, status: "interrupted" }, false);
          newAgents.push(agent);
        }
      } else {
        // Terminal status — just build from DB
        newAgents.push(agentFromDbRow(row, false));
      }
    }

    // Keep locally-managed agents that haven't been written to DB yet
    for (const agent of currentAgents) {
      if (runtimeTaskIdsRef.current.has(agent.taskId) && !rows.some(r => r.task_id === agent.taskId)) {
        newAgents.push(agent);
      }
    }

    // Sort oldest → newest
    newAgents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const changed =
      newAgents.length !== currentAgents.length ||
      newAgents.some((a, i) => {
        const cur = currentAgents[i];
        return !cur ||
          a.taskId !== cur.taskId ||
          a.status !== cur.status ||
          a.lastActivity !== cur.lastActivity ||
          a.idle !== cur.idle ||
          a.elapsed !== cur.elapsed ||
          a.logs.length !== cur.logs.length ||
          a.prState !== cur.prState;
      });

    if (changed) setAgents(newAgents);
  }, [cwd, showAll]);

  // ── Load on mount ──────────────────────────────────────────────────

  useEffect(() => {
    reconcile();
  }, [reconcile]);

  // ── Simple interval poll (SQLite WAL = instant cross-instance visibility) ──

  useEffect(() => {
    if (mockAgents) return;
    const interval = setInterval(reconcile, DB_RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [reconcile]);

  return { agents, setAgents, agentsRef, baseBranchRef, restoredProxiesRef, liveSessionIdsRef, runtimeTaskIdsRef, reconcile, showAll, setShowAll };
}
