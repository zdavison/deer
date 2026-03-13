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
import { startAgent, deleteTask } from "../agent";
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
  parseCostFromPane,
} from "../dashboard-utils";
import {
  DEFAULT_MODEL,
  DASHBOARD_POLL_MS,
  IDLE_THRESHOLD,
} from "../constants";
import { t } from "../i18n";

// ── Runtime handle map ───────────────────────────────────────────────

interface AgentRuntime {
  abortController: AbortController;
  timer: ReturnType<typeof setInterval>;
}

function toTaskStateFile(agent: AgentState, repoPath: string): TaskStateFile {
  return {
    taskId: agent.taskId,
    prompt: agent.prompt,
    baseBranch: agent.baseBranch,
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
    cost: agent.cost ?? null,
    repoPath,
  };
}

/** Persist agent state to the live task state file (fire-and-forget). */
function persistState(agent: AgentState, repoPath: string): void {
  writeTaskState(toTaskStateFile(agent, repoPath)).catch(() => {});
}

/** Persist agent state to the live task state file (awaited). */
async function persistStateAsync(agent: AgentState, repoPath: string): Promise<void> {
  await writeTaskState(toTaskStateFile(agent, repoPath));
}

async function saveToHistory(agent: AgentState, repoPath: string): Promise<void> {
  if (agent.historical) return;
  const task: PersistedTask = {
    taskId: agent.taskId,
    prompt: agent.prompt,
    baseBranch: agent.baseBranch,
    worktreePath: agent.worktreePath,
    status: agent.status as PersistedTask["status"],
    createdAt: agent.createdAt,
    completedAt: new Date().toISOString(),
    elapsed: agent.elapsed,
    prUrl: agent.result?.prUrl ?? null,
    finalBranch: agent.result?.finalBranch ?? null,
    error: agent.error || null,
    lastActivity: agent.lastActivity,
    cost: agent.cost ?? null,
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
        appendLog(agent, t("log_tmux_exited"));
        return;
      }

      const lines = await captureTmuxPane(sessionName);
      if (!lines) continue;

      const snapshot = captureSnapshot(lines);
      const prev = paneStateRef.current.get(agent.taskId) ?? { snapshot: "", unchangedCount: 0 };
      const next = advancePaneState(prev, snapshot);
      paneStateRef.current.set(agent.taskId, next);

      // Parse cost from pane output (only meaningful for API key users)
      const parsedCost = parseCostFromPane(lines);
      if (parsedCost !== null && parsedCost !== agent.cost) {
        agent.cost = parsedCost;
      }

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
            appendLog(agent, `[tmux] ${lastOutput}`);
            await persistStateAsync(agent, cwd);
            setAgents((prev) => [...prev]);
          }
        }
      }

      // Claude is idle when the pane hasn't changed for several consecutive polls
      if (isIdleState(next, IDLE_THRESHOLD) && !agent.idle) {
        agent.idle = true;
        agent.lastActivity = t("activity_idle_attach");
        appendLog(agent, t("log_deer_idle"));
        await persistStateAsync(agent, cwd);
        setAgents((prev) => [...prev]);
      } else if (next.unchangedCount === 0 && agent.idle) {
        agent.idle = false;
        await persistStateAsync(agent, cwd);
        setAgents((prev) => [...prev]);
      }
    }
  }

  // ── Spawn agent ───────────────────────────────────────────────────

  const spawnAgent = useCallback(async (prompt: string, baseBranch?: string, continueSession?: { taskId: string; worktreePath: string; branch: string; result?: { finalBranch: string; prUrl: string } | null }, createdAt?: string) => {
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
      createdAt: createdAt ?? new Date().toISOString(),
      ...(continueSession && {
        worktreePath: continueSession.worktreePath,
        branch: continueSession.branch,
        result: continueSession.result ?? null,
      }),
    });

    const abortController = new AbortController();

    setAgents((prev) => [...prev, agent]);

    try {
      // Phase 1: Start the sandboxed agent
      appendLog(agent, continueSession ? t("log_setup_resuming") : t("log_setup_creating"));
      agent.lastActivity = t("activity_setting_up");
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
        onProxyLog: (message) => {
          appendLog(agent, message, true);
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
        if (ticks % 10 === 0) persistState(agent, cwd);
        setAgents((prev) => [...prev]);
      }, 1000);

      runtimeRef.current.set(taskId, { abortController, timer });
      await persistStateAsync(agent, cwd);

      agent.status = transition(agent.status, "SETUP_COMPLETE") ?? agent.status;
      appendLog(agent, t("log_running_started", { session: handle.sessionName }));
      agent.lastActivity = t("activity_running");
      setAgents((prev) => [...prev]);

      // Phase 2: Poll for completion
      await runAgentPoll(agent, handle.sessionName, abortController.signal);

      if (abortController.signal.aborted) return;

      // Process exited — agent is now at rest, idle until deleted
      agent.idle = true;
      const existingPrUrl = agent.result?.prUrl || "";
      agent.result = { finalBranch: agent.result?.finalBranch || handle.branch, prUrl: existingPrUrl };
      agent.lastActivity = existingPrUrl
        ? t("activity_idle_update_pr")
        : t("activity_idle_create_pr");
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
    agent.lastActivity = t("activity_cancelled");

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
    persistState(agent, cwd);
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

    if (process.env.TMUX) {
      // Already inside tmux — switch-client is non-blocking; deer keeps running.
      const { spawnSync } = await import("node:child_process");
      // Rebind prefix-d to a command block: switch back to the deer session,
      // then immediately restore d to detach-client so the next Ctrl+b d in
      // the deer session detaches normally. The {} block runs as a single
      // binding (tmux 3.2+), unlike ; which is a top-level command separator.
      spawnSync("tmux", ["bind-key", "d", "{", "switch-client", "-l", ";", "bind-key", "d", "detach-client", "}"], { stdio: "inherit" });
      spawnSync("tmux", ["switch-client", "-t", sessionName], { stdio: "inherit" });
    } else {
      await withSuspendedTerminal(setSuspended, async () => {
        // Small delay to let any pending keypress (e.g. the Enter that triggered
        // attach) flush through before tmux takes over stdin.
        await Bun.sleep(50);
        const { spawnSync } = await import("node:child_process");
        spawnSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
      });
    }

    // Default to idle on detach and seed the pane state with the current
    // snapshot. If Claude is actually doing something, the poll loop will
    // detect the pane changing and flip idle back to false within one tick.
    if (agent.status === "running") {
      const lines = await captureTmuxPane(sessionName);
      if (lines) {
        paneStateRef.current.set(agent.taskId, seedIdleState(captureSnapshot(lines)));
      }
      agent.idle = true;
      agent.lastActivity = t("activity_idle_attach");
      setAgents((prev) => [...prev]);
    }
  }, [setSuspended]);

  // ── Open shell in worktree ────────────────────────────────────────

  const openShell = useCallback(async (agent: AgentState) => {
    if (!agent.taskId) return;
    const worktreePath = `${dataDir()}/tasks/${agent.taskId}/worktree`;
    const shell = process.env.SHELL ?? "/bin/sh";
    const sessionName = `deer-shell-${agent.taskId}`;

    const { spawnSync } = await import("node:child_process");
    // Create detached session (no-op if already exists); then apply the
    // deer status bar, then switch/attach — so ctrl+b d returns to deer.
    spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", worktreePath, shell]);
    await applyTmuxStatusBar(sessionName);

    if (process.env.TMUX) {
      // Already inside tmux — switch-client is non-blocking; deer keeps running.
      // Rebind prefix-d to a command block: switch back to the deer session,
      // then immediately restore d to detach-client so the next Ctrl+b d in
      // the deer session detaches normally. The {} block runs as a single
      // binding (tmux 3.2+), unlike ; which is a top-level command separator.
      spawnSync("tmux", ["bind-key", "d", "{", "switch-client", "-l", ";", "bind-key", "d", "detach-client", "}"], { stdio: "inherit" });
      spawnSync("tmux", ["switch-client", "-t", sessionName], { stdio: "inherit" });
    } else {
      await withSuspendedTerminal(setSuspended, async () => {
        await Bun.sleep(50);
        const { spawnSync } = await import("node:child_process");
        spawnSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
      });
    }
  }, [setSuspended]);

  // ── Create PR ─────────────────────────────────────────────────────

  const createPr = useCallback(async (agent: AgentState) => {
    if (!agent.worktreePath) return;
    if (agent.result?.prUrl && agent.prState !== "merged") return;

    agent.creatingPr = true;
    agent.lastActivity = t("activity_creating_pr");
    appendLog(agent, t("log_pr_starting_create"), true);
    appendLog(agent, `[pr] worktreePath=${agent.worktreePath} branch=${agent.branch} baseBranch=${agent.baseBranch}`, true);
    setAgents((prev) => [...prev]);

    try {
      const result = await createPullRequest({
        repoPath: cwd,
        worktreePath: agent.worktreePath,
        branch: agent.branch,
        baseBranch: agent.baseBranch,
        prompt: agent.prompt,
        onLog: (msg) => {
          appendLog(agent, msg, true);
          setAgents((prev) => [...prev]);
        },
      });
      agent.result = { finalBranch: result.finalBranch, prUrl: result.prUrl };
      agent.lastActivity = t("activity_pr_created");
      appendLog(agent, t("log_pr_created", { url: result.prUrl }), true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(agent, `[pr] Error: ${msg}`, true);
      agent.status = transition(agent.status, "PR_FAILED") ?? agent.status;
      agent.error = msg;
      agent.lastActivity = t("activity_pr_failed", { msg: truncate(msg, 120) });
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
    agent.lastActivity = t("activity_updating_pr");
    appendLog(agent, t("log_pr_starting_update"), true);
    appendLog(agent, `[pr] worktreePath=${worktreePath} branch=${agent.result.finalBranch} baseBranch=${agent.baseBranch}`, true);
    setAgents((prev) => [...prev]);

    try {
      await updatePullRequest({
        repoPath: cwd,
        worktreePath,
        finalBranch: agent.result.finalBranch,
        baseBranch: agent.baseBranch,
        prompt: agent.prompt,
        prUrl: agent.result.prUrl,
        onLog: (msg) => {
          appendLog(agent, msg, true);
          setAgents((prev) => [...prev]);
        },
      });
      agent.lastActivity = t("activity_pr_updated");
      appendLog(agent, t("log_pr_updated", { url: agent.result.prUrl }), true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(agent, `[pr] Error: ${msg}`, true);
      agent.lastActivity = t("activity_pr_update_failed", { msg: truncate(msg, 120) });
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

    const { prompt, baseBranch, worktreePath, branch, taskId, createdAt, result } = agent;
    // Use the finalized branch name if the PR was already created (branch gets
    // renamed from deer/<taskId> → deer/<branchName> during PR creation).
    const effectiveBranch = result?.finalBranch || branch;

    if (worktreePath) {
      // Kill the tmux session but preserve the worktree for --continue
      Bun.spawn(["tmux", "kill-session", "-t", `deer-${taskId}`], {
        stdout: "pipe", stderr: "pipe",
      }).exited.catch(() => {});
      setAgents((prev) => prev.filter((a) => a !== agent));
      spawnAgent(prompt, baseBranch, { taskId, worktreePath, branch: effectiveBranch, result }, createdAt);
    } else {
      deleteAgent(agent);
      spawnAgent(prompt, baseBranch, undefined, createdAt);
    }
  }, [spawnAgent, deleteAgent, setAgents]);

  // ── Resume live session (tmux still running after deer restart) ──────

  /**
   * Re-attach a poll loop to a tmux session that survived a deer restart.
   * Called when syncWithHistory detects a dead-owner task whose tmux session
   * is still alive. Takes ownership of the session without re-creating the
   * sandbox or worktree.
   */
  const resumeLiveSession = useCallback(async (agent: AgentState) => {
    // Immediately take ownership so subsequent syncs skip this agent
    if (runtimeRef.current.has(agent.taskId)) return;
    agent.historical = false;

    const sessionName = `deer-${agent.taskId}`;
    const dead = await isTmuxSessionDead(sessionName);
    if (dead) {
      // Session ended between the sync check and now — revert to interrupted
      agent.historical = true;
      agent.status = "interrupted";
      agent.idle = false;
      agent.lastActivity = t("activity_interrupted");
      setAgents((prev) => [...prev]);
      return;
    }

    agent.status = "running";
    const abortController = new AbortController();
    let ticks = 0;
    const timer = setInterval(() => {
      if (!agent.idle) agent.elapsed++;
      ticks++;
      if (ticks % 10 === 0) persistState(agent, cwd);
      setAgents((prev) => [...prev]);
    }, 1000);

    runtimeRef.current.set(agent.taskId, { abortController, timer });
    await persistStateAsync(agent, cwd); // Claim ownership: update ownerPid
    appendLog(agent, t("log_deer_resuming"));
    setAgents((prev) => [...prev]);

    try {
      await runAgentPoll(agent, sessionName, abortController.signal);

      if (abortController.signal.aborted) return;

      agent.idle = true;
      agent.result = { finalBranch: agent.branch, prUrl: agent.result?.prUrl ?? "" };
      agent.lastActivity = t("activity_idle_create_pr");
    } catch (err) {
      if (!abortController.signal.aborted) {
        agent.status = transition(agent.status, "ERROR") ?? "failed";
        agent.error = err instanceof Error ? err.message : String(err);
        agent.lastActivity = truncate(agent.error, 120);
      }
    } finally {
      const runtime = runtimeRef.current.get(agent.taskId);
      if (runtime) {
        clearInterval(runtime.timer);
        runtimeRef.current.delete(agent.taskId);
      }
      paneStateRef.current.delete(agent.taskId);
      if (!agent.deleted) {
        await saveToHistory(agent, cwd);
      }
      await removeTaskState(agent.taskId).catch(() => {});
      setAgents((prev) => [...prev]);
    }
  }, [cwd]);

  return { spawnAgent, killAgent, abortAllAgents, attachToAgent, openShell, createPr, updatePr, deleteAgent, retryAgent, resumeLiveSession };
}
