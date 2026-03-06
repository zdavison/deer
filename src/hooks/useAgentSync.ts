import { join } from "node:path";
import { watch } from "node:fs";
import { useState, useEffect, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";
import { loadHistory, dataDir } from "../task";
import type { SandboxCleanup } from "../sandbox/index";
import { resolveRuntime } from "../sandbox/resolve";
import { detectRepo } from "../git/worktree";
import { type AgentState, historicalAgent, liveTaskFromStateFile, historicalAgentFromStateFile } from "../agent-state";
import { readTaskState, scanLiveTaskIds, isOwnerAlive } from "../task-state";
import type { DeerConfig } from "../config";
import { TASK_SYNC_DEBOUNCE_MS, TASK_SYNC_SAFETY_POLL_MS } from "../constants";

export function useAgentSync(cwd: string, configRef: MutableRefObject<DeerConfig | null>) {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const deletedTaskIdsRef = useRef(new Set<string>());
  const baseBranchRef = useRef("main");
  /** Proxy cleanup functions for cross-instance tasks restored after a restart */
  const restoredProxiesRef = useRef(new Map<string, SandboxCleanup>());

  // ── Detect base branch on mount ────────────────────────────────────

  useEffect(() => {
    detectRepo(cwd).then((info) => {
      baseBranchRef.current = info.defaultBranch;
    }).catch(() => {});
  }, [cwd]);

  // ── Sync state from state files + history ──────────────────────────

  const syncWithHistory = useCallback(async () => {
    // Live tasks: read all state.json files in parallel
    const liveTaskIds = await scanLiveTaskIds();
    const liveStateResults = await Promise.all(
      liveTaskIds
        .filter(id => !deletedTaskIdsRef.current.has(id))
        .map(async id => ({ id, state: await readTaskState(id) })),
    );
    const liveStateFiles = new Map(
      liveStateResults
        .filter((r): r is { id: string; state: NonNullable<typeof r.state> } => r.state !== null)
        .map(r => [r.id, r.state]),
    );

    // Completed tasks: JSONL history (only non-running entries now that live tasks
    // use state.json; running entries are kept as a fallback for tasks started by
    // older deer versions that did not write state.json)
    const allFileTasks = await loadHistory(cwd);
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

        // Owner process died — clean up any restored proxy and show as interrupted
        const proxyCleanup = restoredProxiesRef.current.get(taskId);
        if (proxyCleanup) {
          proxyCleanup();
          restoredProxiesRef.current.delete(taskId);
        }
        newAgents.push(historicalAgentFromStateFile(stateFile));
        continue;
      }

      // No state.json — fall back to JSONL history entry
      const fileTask = fileTasks.find(t => t.taskId === taskId);
      if (fileTask) {
        newAgents.push(historicalAgent(fileTask));
      }
    }

    // Keep locally-owned agents that haven't written their state file yet
    for (const agent of currentAgents) {
      if (!agent.historical && !allTaskIds.has(agent.taskId)) {
        newAgents.push(agent);
      }
    }

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
  }, [cwd]);

  // ── Load on mount ──────────────────────────────────────────────────

  useEffect(() => {
    syncWithHistory();
  }, [syncWithHistory]);

  // ── Watch tasks directory for instant cross-instance updates ───────

  useEffect(() => {
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

  return { agents, setAgents, agentsRef, deletedTaskIdsRef, baseBranchRef, restoredProxiesRef, syncWithHistory };
}
