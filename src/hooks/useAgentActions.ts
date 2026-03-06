import { useCallback, useRef } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { AgentState } from "../agent-state";
import { createAgentState } from "../agent-state";
import { upsertHistory, removeFromHistory, dataDir, generateTaskId } from "../task";
import type { PersistedTask } from "../task";
import { writeTaskState, removeTaskState } from "../task-state";
import type { TaskStateFile } from "../task-state";
import type { DeerConfig } from "../config";
import type { PreflightResult } from "../preflight";
import { startAgent, destroyAgent, deleteTask } from "../agent";
import { updatePullRequest, createPullRequest } from "../git/finalize";
import { isTmuxSessionDead, captureTmuxPane, applyTmuxStatusBar } from "../sandbox/index";
import { resolveRuntime } from "../sandbox/resolve";
import { transition } from "../state-machine";
import { advancePaneState, isIdleState, seedIdleState } from "../pane-idle";
import type { PaneState } from "../pane-idle";
import {
  appendLog,
  isActive,
  stripAnsi,
  captureSnapshot,
  truncate,
  withSuspendedTerminal,
} from "../dashboard-utils";
import {
  DEFAULT_MODEL,
  DASHBOARD_POLL_MS,
  IDLE_THRESHOLD,
} from "../constants";

// ── Runtime handle map ───────────────────────────────────────────────

interface AgentRuntime {
  abortController: AbortController;
  timer: ReturnType<typeof setInterval>;
}

function toTaskStateFile(agent: AgentState): TaskStateFile {
  return {
    taskId: agent.taskId,
    prompt: agent.prompt,
    status: agent.status as TaskStateFile["status"],
    elapsed: agent.elapsed,
    lastActivity: agent.lastActivity,
    finalBranch: agent.result?.finalBranch ?? null,
    prUrl: agent.result?.prUrl ?? null,
    error: agent.error || null,
    logs: [...agent.logs],
    idle: agent.idle,
    createdAt: agent.createdAt,
    ownerPid: process.pid,
    worktreePath: agent.worktreePath,
  };
}

/** Persist agent state to the live task state file (fire-and-forget). */
function persistState(agent: AgentState): void {
  writeTaskState(toTaskStateFile(agent)).catch(() => {});
}

/** Persist agent state to the live task state file (awaited). */
async function persistStateAsync(agent: AgentState): Promise<void> {
  await writeTaskState(toTaskStateFile(agent));
}

async function saveToHistory(agent: AgentState, repoPath: string): Promise<void> {
  if (agent.historical) return;
  const task: PersistedTask = {
    taskId: agent.taskId,
    prompt: agent.prompt,
    status: agent.status as PersistedTask["status"],
    createdAt: agent.createdAt,
    completedAt: new Date().toISOString(),
    elapsed: agent.elapsed,
    prUrl: agent.result?.prUrl ?? null,
    finalBranch: agent.result?.finalBranch ?? null,
    error: agent.error || null,
    lastActivity: agent.lastActivity,
  };
  await upsertHistory(repoPath, task);
}

interface AgentActionDeps {
  cwd: string;
  setAgents: Dispatch<SetStateAction<AgentState[]>>;
  deletedTaskIdsRef: MutableRefObject<Set<string>>;
  baseBranchRef: MutableRefObject<string>;
  configRef: MutableRefObject<DeerConfig | null>;
  preflight: PreflightResult | null;
  setSuspended: (v: boolean) => void;
}

export function useAgentActions({
  cwd,
  setAgents,
  deletedTaskIdsRef,
  baseBranchRef,
  configRef,
  preflight,
  setSuspended,
}: AgentActionDeps) {
  /** Per-task runtime handles: abort controller and elapsed timer */
  const runtimeRef = useRef(new Map<string, AgentRuntime>());

  /** Per-task pane snapshot state shared between the poll loop and attachToAgent */
  const paneStateRef = useRef(new Map<string, PaneState>());

  // ── Poll loop ────────────────────────────────────────────────────

  /** Poll tmux pane until the agent exits or is aborted. */
  async function runAgentPoll(agent: AgentState, sessionName: string, signal: AbortSignal): Promise<void> {
    paneStateRef.current.set(agent.taskId, { snapshot: "", unchangedCount: 0 });

    while (true) {
      await Bun.sleep(DASHBOARD_POLL_MS);
      if (signal.aborted) return;

      const dead = await isTmuxSessionDead(sessionName);
      if (dead) {
        appendLog(agent, "[tmux] Claude process exited");
        return;
      }

      const lines = await captureTmuxPane(sessionName);
      if (!lines) continue;

      const snapshot = captureSnapshot(lines);
      const prev = paneStateRef.current.get(agent.taskId) ?? { snapshot: "", unchangedCount: 0 };
      const next = advancePaneState(prev, snapshot);
      paneStateRef.current.set(agent.taskId, next);

      if (next.unchangedCount === 0) {
        // Update lastActivity with the latest bullet line (Claude's text output)
        const lastOutput = lines
          .map(stripAnsi)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("\u25CF"))
          .pop();
        if (lastOutput) {
          const activity = truncate(lastOutput, 120);
          if (activity !== agent.lastActivity) {
            agent.lastActivity = activity;
            appendLog(agent, `[tmux] ${truncate(lastOutput, 200)}`);
            await persistStateAsync(agent);
            setAgents((prev) => [...prev]);
          }
        }
      }

      // Claude is idle when the pane hasn't changed for several consecutive polls
      if (isIdleState(next, IDLE_THRESHOLD) && !agent.idle) {
        agent.idle = true;
        agent.lastActivity = "Idle \u2014 press \u23CE to attach";
        appendLog(agent, "[deer] Claude is idle");
        await persistStateAsync(agent);
        setAgents((prev) => [...prev]);
      } else if (next.unchangedCount === 0 && agent.idle) {
        agent.idle = false;
        await persistStateAsync(agent);
        setAgents((prev) => [...prev]);
      }
    }
  }

  // ── Spawn agent ───────────────────────────────────────────────────

  const spawnAgent = useCallback(async (prompt: string, baseBranch?: string, continueSession?: { taskId: string; worktreePath: string; branch: string }) => {
    if (!prompt.trim()) return;
    if (preflight && !preflight.ok) return;

    const config = configRef.current;
    if (!config) return;

    const effectiveBranch = baseBranch ?? baseBranchRef.current;

    // Pre-generate the taskId so the agent has a stable React key
    // during setup before startAgent resolves.
    const taskId = continueSession?.taskId ?? generateTaskId();

    const agent = createAgentState({
      taskId,
      prompt: prompt.trim(),
      baseBranch: effectiveBranch,
      createdAt: new Date().toISOString(),
      ...(continueSession && {
        worktreePath: continueSession.worktreePath,
        branch: continueSession.branch,
      }),
    });

    const abortController = new AbortController();

    setAgents((prev) => [...prev, agent]);

    try {
      // Phase 1: Start the sandboxed agent
      appendLog(agent, continueSession ? "[setup] Resuming session..." : "[setup] Creating worktree and sandbox...");
      agent.lastActivity = "Setting up sandbox...";
      setAgents((prev) => [...prev]);

      const handle = await startAgent({
        repoPath: cwd,
        prompt: prompt.trim(),
        baseBranch: effectiveBranch,
        config,
        model: DEFAULT_MODEL,
        runtime: resolveRuntime(config),
        taskId,
        continueSession,
        onStatus: (status) => {
          const detail = "message" in status ? status.message : status.phase;
          appendLog(agent, `[setup] ${detail}`);
          agent.lastActivity = detail;
          setAgents((prev) => [...prev]);
        },
      });

      // Sync worktree/branch from handle (for fresh starts)
      agent.worktreePath = handle.worktreePath;
      agent.branch = handle.branch;

      // Start elapsed timer — pauses while agent is idle, persists elapsed every 10s
      let ticks = 0;
      const timer = setInterval(() => {
        if (!agent.idle) agent.elapsed++;
        ticks++;
        if (ticks % 10 === 0) persistState(agent);
        setAgents((prev) => [...prev]);
      }, 1000);

      runtimeRef.current.set(taskId, { abortController, timer });
      await persistStateAsync(agent);

      agent.status = transition(agent.status, "SETUP_COMPLETE") ?? agent.status;
      appendLog(agent, `[running] Claude started in tmux session: ${handle.sessionName}`);
      agent.lastActivity = "Claude running...";
      setAgents((prev) => [...prev]);

      // Phase 2: Poll for completion
      await runAgentPoll(agent, handle.sessionName, abortController.signal);

      if (abortController.signal.aborted) return;

      // Process exited — agent is now at rest, idle until deleted
      agent.idle = true;
      agent.result = { finalBranch: handle.branch, prUrl: "" };
      agent.lastActivity = "Idle \u2014 press p to create PR, \u23CE to attach";
    } catch (err) {
      if (!abortController.signal.aborted) {
        agent.status = transition(agent.status, "ERROR") ?? "failed";
        agent.error = err instanceof Error ? err.message : String(err);
        agent.lastActivity = truncate(agent.error, 120);
      }
    } finally {
      const runtime = runtimeRef.current.get(taskId);
      if (runtime) {
        clearInterval(runtime.timer);
        runtimeRef.current.delete(taskId);
      }
      paneStateRef.current.delete(taskId);
      if (!agent.deleted) {
        await saveToHistory(agent, cwd);
      }
      // Remove the live state file — the JSONL history entry is now authoritative
      await removeTaskState(taskId).catch(() => {});
      setAgents((prev) => [...prev]);
    }
  }, [cwd, preflight]);

  // ── Kill agent ────────────────────────────────────────────────────

  const killAgent = useCallback((agent: AgentState) => {
    if (!isActive(agent)) return;
    agent.status = transition(agent.status, "USER_KILL") ?? "cancelled";
    agent.lastActivity = "Cancelled by user";

    const runtime = runtimeRef.current.get(agent.taskId);
    if (runtime) {
      runtime.abortController.abort();
      clearInterval(runtime.timer);
      runtimeRef.current.delete(agent.taskId);
    }

    // Kill the tmux session by its conventional name
    Bun.spawn(["tmux", "kill-session", "-t", `deer-${agent.taskId}`], {
      stdout: "pipe", stderr: "pipe",
    }).exited.catch(() => {});

    saveToHistory(agent, cwd);
    persistState(agent);
    setAgents((prev) => [...prev]);
  }, [cwd]);

  // ── Abort all agents (for dashboard shutdown) ─────────────────────

  const abortAllAgents = useCallback(() => {
    for (const [, runtime] of runtimeRef.current) {
      runtime.abortController.abort();
      clearInterval(runtime.timer);
    }
    runtimeRef.current.clear();
  }, []);

  // ── Attach to running agent (just tmux attach) ────────────────────

  const attachToAgent = useCallback(async (agent: AgentState) => {
    if (!agent.taskId) return;
    const sessionName = `deer-${agent.taskId}`;

    await withSuspendedTerminal(setSuspended, async () => {
      // Small delay to let any pending keypress (e.g. the Enter that triggered
      // attach) flush through before tmux takes over stdin.
      await Bun.sleep(50);
      const { spawnSync } = await import("node:child_process");
      spawnSync("tmux", ["attach", "-t", sessionName], {
        stdio: "inherit",
      });
    });

    // After detach, eagerly check whether Claude is still idle rather than
    // waiting for the poll loop to accumulate IDLE_THRESHOLD stable polls.
    if (agent.status === "running") {
      // Let the pane settle after the detach event
      await Bun.sleep(DASHBOARD_POLL_MS);
      const linesA = await captureTmuxPane(sessionName);
      await Bun.sleep(DASHBOARD_POLL_MS);
      const linesB = await captureTmuxPane(sessionName);

      if (linesA && linesB) {
        const snapA = captureSnapshot(linesA);
        const snapB = captureSnapshot(linesB);

        if (snapA === snapB) {
          // Pane is stable — seed the poll loop's counter so idle is recognised
          // on the very next tick, and update the UI immediately.
          paneStateRef.current.set(agent.taskId, seedIdleState(snapB));
          agent.idle = true;
          agent.lastActivity = "Idle — press ⏎ to attach";
        } else {
          // Pane is changing — Claude started working; let poll loop handle it.
          const lastLine = linesB.map(stripAnsi).map((l) => l.trim()).filter(Boolean).pop();
          if (lastLine) agent.lastActivity = truncate(lastLine, 120);
        }
      }
      setAgents((prev) => [...prev]);
    }
  }, [setSuspended]);

  // ── Open shell in worktree ────────────────────────────────────────

  const openShell = useCallback(async (agent: AgentState) => {
    if (!agent.taskId) return;
    const worktreePath = `${dataDir()}/tasks/${agent.taskId}/worktree`;
    const shell = process.env.SHELL ?? "/bin/sh";
    const sessionName = `deer-shell-${agent.taskId}`;

    await withSuspendedTerminal(setSuspended, async () => {
      await Bun.sleep(50);
      const { spawnSync } = await import("node:child_process");
      // Create detached session (no-op if already exists); then apply the
      // deer status bar, then attach — so ctrl+b d returns to deer like attach.
      spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", worktreePath, shell]);
      await applyTmuxStatusBar(sessionName);
      spawnSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
    });
  }, [setSuspended]);

  // ── Create PR ─────────────────────────────────────────────────────

  const createPr = useCallback(async (agent: AgentState) => {
    if (!agent.worktreePath || agent.result?.prUrl) return;

    agent.creatingPr = true;
    agent.lastActivity = "Creating PR...";
    setAgents((prev) => [...prev]);

    try {
      const result = await createPullRequest({
        repoPath: cwd,
        worktreePath: agent.worktreePath,
        branch: agent.branch,
        baseBranch: agent.baseBranch,
        prompt: agent.prompt,
      });
      agent.result = { finalBranch: result.finalBranch, prUrl: result.prUrl };
      agent.lastActivity = "PR created";
    } catch (err) {
      agent.lastActivity = `PR failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      agent.creatingPr = false;
    }
    await saveToHistory(agent, cwd);
    setAgents((prev) => [...prev]);
  }, [cwd]);

  // ── Update PR ─────────────────────────────────────────────────────

  const updatePr = useCallback(async (agent: AgentState) => {
    if (!agent.result?.prUrl || !agent.result?.finalBranch) return;

    const worktreePath = `${dataDir()}/tasks/${agent.taskId}/worktree`;

    agent.updatingPr = true;
    agent.lastActivity = "Updating PR...";
    setAgents((prev) => [...prev]);

    try {
      await updatePullRequest({
        repoPath: cwd,
        worktreePath,
        finalBranch: agent.result.finalBranch,
        baseBranch: agent.baseBranch,
        prompt: agent.prompt,
        prUrl: agent.result.prUrl,
      });
      agent.lastActivity = "PR updated";
    } catch (err) {
      agent.lastActivity = `PR update failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      agent.updatingPr = false;
    }
    await saveToHistory(agent, cwd);
    setAgents((prev) => [...prev]);
  }, [cwd]);

  // ── Delete agent ──────────────────────────────────────────────────

  const deleteAgent = useCallback((agent: AgentState) => {
    agent.deleted = true;

    const runtime = runtimeRef.current.get(agent.taskId);
    if (runtime) {
      runtime.abortController.abort();
      clearInterval(runtime.timer);
      runtimeRef.current.delete(agent.taskId);
    }

    deleteTask(agent.taskId, cwd).catch(() => {});
    setAgents((prev) => prev.filter((a) => a !== agent));
    deletedTaskIdsRef.current.add(agent.taskId);
    removeFromHistory(cwd, agent.taskId).finally(() => {
      deletedTaskIdsRef.current.delete(agent.taskId);
    });
  }, [cwd, setAgents, deletedTaskIdsRef]);

  // ── Retry agent ───────────────────────────────────────────────────

  const retryAgent = useCallback((agent: AgentState) => {
    // Clean up any existing runtime (abort poll loop, clear timer)
    const runtime = runtimeRef.current.get(agent.taskId);
    if (runtime) {
      runtime.abortController.abort();
      clearInterval(runtime.timer);
      runtimeRef.current.delete(agent.taskId);
    }

    const { prompt, baseBranch, worktreePath, branch, taskId } = agent;

    if (worktreePath) {
      // Kill the tmux session but preserve the worktree for --continue
      Bun.spawn(["tmux", "kill-session", "-t", `deer-${taskId}`], {
        stdout: "pipe", stderr: "pipe",
      }).exited.catch(() => {});
      setAgents((prev) => prev.filter((a) => a !== agent));
      spawnAgent(prompt, baseBranch, { taskId, worktreePath, branch });
    } else {
      deleteAgent(agent);
      spawnAgent(prompt, baseBranch);
    }
  }, [spawnAgent, deleteAgent, setAgents]);

  return { spawnAgent, killAgent, abortAllAgents, attachToAgent, openShell, createPr, updatePr, deleteAgent, retryAgent };
}
