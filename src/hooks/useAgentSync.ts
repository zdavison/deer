import { join } from "node:path";
import { watch } from "node:fs";
import { useState, useEffect, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";
import { loadHistory, loadAllHistory, dataDir } from "../task";
import type { SandboxCleanup } from "../sandbox/index";
import { isTmuxSessionDead } from "../sandbox/index";
import { resolveRuntime } from "../sandbox/resolve";
import { detectRepo } from "../git/worktree";
import { type AgentState, historicalAgent, liveAgentFromHistory, liveTaskFromStateFile, historicalAgentFromStateFile } from "../agent-state";
import { readTaskState, scanLiveTaskIds, isOwnerAlive } from "../task-state";
import type { DeerConfig } from "../config";
import { TASK_SYNC_DEBOUNCE_MS, TASK_SYNC_SAFETY_POLL_MS } from "../constants";

export function useAgentSync(cwd: string, configRef: MutableRefObject<DeerConfig | null>, mockAgents?: AgentState[]) {
  const [agents, setAgents] = useState<AgentState[]>(mockAgents ?? []);
  const [showAll, setShowAll] = useState(false);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const deletedTaskIdsRef = useRef(new Set<string>());
  const baseBranchRef = useRef("main");
  /** Proxy cleanup functions for cross-instance tasks restored after a restart */
  const restoredProxiesRef = useRef(new Map<string, SandboxCleanup>());
  /**
   * Task IDs that have live tmux sessions after a deer restart. The dashboard
   * watches this ref and calls resumeLiveSession for each entry.
   */
  const liveSessionIdsRef = useRef(new Set<string>());

  // ── Detect base branch on mount ────────────────────────────────────

  useEffect(() => {
    if (mockAgents) return;
    detectRepo(cwd).then((info) => {
      baseBranchRef.current = info.defaultBranch;
    }).catch(() => {});
  }, [cwd]);

  // ── Sync state from state files + history ──────────────────────────

  const syncWithHistory = useCallback(async () => {
    if (mockAgents) return;
    // Live tasks: read all state.json files in parallel
    const liveTaskIds = await scanLiveTaskIds();
    const liveStateResults = await Promise.all(
      liveTaskIds
        .filter(id => !deletedTaskIdsRef.current.has(id))
        .map(async id => ({ id, state: await readTaskState(id) })),
    );
    const allLiveStateFiles = new Map(
      liveStateResults
        .filter((r): r is { id: string; state: NonNullable<typeof r.state> } => r.state !== null)
        .map(r => [r.id, r.state]),
    );

    // In repo-scoped mode, hide live tasks that belong to a different repo.
    // Tasks without a repoPath (written by older deer versions) are always shown.
    const liveStateFiles = showAll
      ? allLiveStateFiles
      : new Map([...allLiveStateFiles].filter(([, s]) => !s.repoPath || s.repoPath === cwd));

    // Completed tasks: JSONL history (only non-running entries now that live tasks
    // use state.json; running entries are kept as a fallback for tasks started by
    // older deer versions that did not write state.json)
    const allFileTasks = showAll ? await loadAllHistory() : await loadHistory(cwd);
    const fileTasks = allFileTasks.filter(t => !deletedTaskIdsRef.current.has(t.taskId));

    const currentAgents = agentsRef.current;
    const agentByTaskId = new Map(currentAgents.map(a => [a.taskId, a]));

    // Union of all known task IDs
    const allTaskIds = new Set([
      ...liveStateFiles.keys(),
      ...fileTasks.map(t => t.taskId),
    ]);

    const newAgents: AgentState[] = [];

    for (const taskId of allTaskIds) {
      const existing = agentByTaskId.get(taskId);

      // Locally-managed (non-historical) agents are authoritative — keep as-is
      if (existing && !existing.historical) {
        newAgents.push(existing);
        continue;
      }

      const stateFile = liveStateFiles.get(taskId);

      if (stateFile) {
        const ownerAlive = isOwnerAlive(stateFile.ownerPid);

        if (ownerAlive && stateFile.ownerPid !== process.pid) {
          // Cross-instance task: the owning deer process is still alive
          if (!restoredProxiesRef.current.has(taskId) && configRef.current) {
            const runtime = resolveRuntime(configRef.current);
            const worktreePath = join(dataDir(), "tasks", taskId, "worktree");
            const cleanup = await runtime.restoreProxy?.(worktreePath, configRef.current.network.allowlist);
            if (cleanup) restoredProxiesRef.current.set(taskId, cleanup);
          }
          newAgents.push(liveTaskFromStateFile(stateFile));
          continue;
        }

        if (ownerAlive && stateFile.ownerPid === process.pid) {
          // This instance owns the task. Keep the existing locally-managed agent
          // as-is; if it hasn't been claimed yet (e.g. resumeLiveSession just
          // wrote ownerPid but React hasn't re-rendered), show from state file.
          if (existing && !existing.historical) {
            newAgents.push(existing);
          } else {
            newAgents.push(liveTaskFromStateFile(stateFile));
          }
          continue;
        }

        // Owner process died — clean up any restored proxy
        const proxyCleanup = restoredProxiesRef.current.get(taskId);
        if (proxyCleanup) {
          proxyCleanup();
          restoredProxiesRef.current.delete(taskId);
        }

        // Check whether the tmux session is still alive. If so, Claude is
        // still running and we should resume polling instead of showing as
        // interrupted. Add to liveSessionIdsRef for the dashboard to pick up.
        const sessionDead = await isTmuxSessionDead(`deer-${taskId}`);
        if (!sessionDead) {
          // Always show as running while a resume is pending or in-flight.
          // Only add to the set if not already there (i.e. first discovery).
          if (!liveSessionIdsRef.current.has(taskId)) {
            liveSessionIdsRef.current.add(taskId);
          }
          // Show as running with last known state while we hand off to the poll loop
          newAgents.push(liveTaskFromStateFile(stateFile));
          continue;
        }

        newAgents.push(historicalAgentFromStateFile(stateFile));
        continue;
      }

      // No state.json — fall back to JSONL history entry
      const fileTask = fileTasks.find(t => t.taskId === taskId);
      if (fileTask) {
        // If the task was saved as "running" (deer closed while it was active),
        // check whether the tmux session survived before showing as interrupted.
        if (fileTask.status === "running") {
          const sessionDead = await isTmuxSessionDead(`deer-${taskId}`);
          if (!sessionDead) {
            // Always show as running while a resume is pending or in-flight.
            if (!liveSessionIdsRef.current.has(taskId)) {
              liveSessionIdsRef.current.add(taskId);
            }
            // Show as running while we hand off to the poll loop
            newAgents.push(liveAgentFromHistory(fileTask));
            continue;
          }
        }
        newAgents.push(historicalAgent(fileTask));
      }
    }

    // Keep locally-owned agents that haven't written their state file yet
    for (const agent of currentAgents) {
      if (!agent.historical && !allTaskIds.has(agent.taskId)) {
        newAgents.push(agent);
      }
    }

    // Sort oldest → newest so the list is stable and doesn't jump around
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
          a.logs.length !== cur.logs.length;
      });

    if (changed) setAgents(newAgents);
  }, [cwd, showAll]);

  // ── Load on mount ──────────────────────────────────────────────────

  useEffect(() => {
    syncWithHistory();
  }, [syncWithHistory]);

  // ── Watch tasks directory for instant cross-instance updates ───────

  useEffect(() => {
    if (mockAgents) return;
    const tasksDir = join(dataDir(), "tasks");
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const trigger = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(syncWithHistory, TASK_SYNC_DEBOUNCE_MS);
    };

    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(tasksDir, { recursive: true }, (_, filename) => {
        if (filename?.endsWith("state.json")) trigger();
      });
    } catch {
      // tasks dir may not exist yet — the slow poll below provides fallback
    }

    // Safety-net poll in case fs.watch misses events (e.g. on some Linux setups)
    const interval = setInterval(syncWithHistory, TASK_SYNC_SAFETY_POLL_MS);

    return () => {
      watcher?.close();
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [syncWithHistory]);

  return { agents, setAgents, agentsRef, deletedTaskIdsRef, baseBranchRef, restoredProxiesRef, liveSessionIdsRef, syncWithHistory, showAll, setShowAll };
}
