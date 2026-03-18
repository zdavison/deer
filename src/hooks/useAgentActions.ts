import { useCallback, useRef } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { AgentState } from "../agent-state";
import { createAgentState } from "../agent-state";
import { generateTaskId, dataDir } from "../task";
import { insertTask, updateTask, deleteTaskRow, claimPoller, releasePoller } from "../db";
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

interface AgentActionDeps {
  cwd: string;
  setAgents: Dispatch<SetStateAction<AgentState[]>>;
  baseBranchRef: MutableRefObject<string>;
  configRef: MutableRefObject<DeerConfig | null>;
  preflight: PreflightResult | null;
  setSuspended: (v: boolean) => void;
  runtimeTaskIdsRef: MutableRefObject<Set<string>>;
}

export function useAgentActions({
  cwd,
  setAgents,
  baseBranchRef,
  configRef,
  preflight,
  setSuspended,
  runtimeTaskIdsRef,
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

      // Parse cost from pane output
      const parsedCost = parseCostFromPane(lines);
      if (parsedCost !== null && parsedCost !== agent.cost) {
        agent.cost = parsedCost;
        updateTask(agent.taskId, { cost: parsedCost });
      }

      if (next.unchangedCount === 0) {
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
            updateTask(agent.taskId, { lastActivity: activity });
            setAgents((prev) => [...prev]);
          }
        }
      }

      // Idle detection
      if (isIdleState(next, IDLE_THRESHOLD) && !agent.idle) {
        agent.idle = true;
        agent.lastActivity = t("activity_idle_attach");
        appendLog(agent, t("log_deer_idle"));
        updateTask(agent.taskId, { idle: true, lastActivity: agent.lastActivity });
        setAgents((prev) => [...prev]);
      } else if (next.unchangedCount === 0 && agent.idle) {
        agent.idle = false;
        updateTask(agent.taskId, { idle: false });
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
    const taskId = continueSession?.taskId ?? generateTaskId();
    const createdAtMs = createdAt ? new Date(createdAt).getTime() : Date.now();

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

    // Insert into DB (skip if continuing — row already exists)
    if (!continueSession) {
      insertTask({
        taskId,
        repoPath: cwd,
        prompt: prompt.trim(),
        baseBranch: effectiveBranch,
        createdAt: createdAtMs,
      });
    } else {
      updateTask(taskId, { status: "setup" });
    }

    setAgents((prev) => [...prev, agent]);

    // Register as runtime task immediately so reconcile() doesn't mark it as
    // interrupted while startAgent() is still creating the tmux session.
    runtimeTaskIdsRef.current.add(taskId);

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

      agent.worktreePath = handle.worktreePath;
      agent.branch = handle.branch;

      // Update DB with worktree info and mark as running
      updateTask(taskId, {
        worktreePath: handle.worktreePath,
        branch: handle.branch,
        status: "running",
        pollerPid: process.pid,
      });

      // Start elapsed timer
      const timer = setInterval(() => {
        if (!agent.idle) agent.elapsed++;
        setAgents((prev) => [...prev]);
      }, 1000);

      runtimeRef.current.set(taskId, { abortController, timer });

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
      runtimeTaskIdsRef.current.delete(taskId);
      paneStateRef.current.delete(taskId);

      if (!agent.deleted) {
        updateTask(taskId, {
          status: agent.status,
          finishedAt: Date.now(),
          error: agent.error || null,
          idle: agent.idle,
          lastActivity: agent.lastActivity,
          elapsed: agent.elapsed,
          cost: agent.cost,
          finalBranch: agent.result?.finalBranch ?? null,
          prUrl: agent.result?.prUrl ?? null,
        });
        releasePoller(taskId, process.pid);
      }
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
    runtimeTaskIdsRef.current.delete(agent.taskId);

    // Kill the tmux session
    Bun.spawn(["tmux", "kill-session", "-t", `deer-${agent.taskId}`], {
      stdout: "pipe", stderr: "pipe",
    }).exited.catch(() => {});

    updateTask(agent.taskId, {
      status: "cancelled",
      finishedAt: Date.now(),
      lastActivity: agent.lastActivity,
      elapsed: agent.elapsed,
    });
    releasePoller(agent.taskId, process.pid);
    setAgents((prev) => [...prev]);
  }, [cwd]);

  // ── Abort all agents (for dashboard shutdown) ─────────────────────

  const abortAllAgents = useCallback(() => {
    for (const [, runtime] of runtimeRef.current) {
      runtime.abortController.abort();
      clearInterval(runtime.timer);
    }
    runtimeRef.current.clear();
    runtimeTaskIdsRef.current.clear();
  }, []);

  // ── Attach to running agent (just tmux attach) ────────────────────

  const attachToAgent = useCallback(async (agent: AgentState) => {
    if (!agent.taskId) return;
    const sessionName = `deer-${agent.taskId}`;

    if (process.env.TMUX) {
      const { spawnSync } = await import("node:child_process");
      spawnSync("tmux", [
        "bind-key", "d",
        "if-shell", "-F", "#{m:deer-*,#{session_name}}",
        "switch-client -l",
        "detach-client",
      ], { stdio: "inherit" });
      spawnSync("tmux", ["switch-client", "-t", sessionName], { stdio: "inherit" });
    } else {
      await withSuspendedTerminal(setSuspended, async () => {
        await Bun.sleep(50);
        const { spawnSync } = await import("node:child_process");
        spawnSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
      });
    }

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
    spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", worktreePath, shell]);
    await applyTmuxStatusBar(sessionName);

    if (process.env.TMUX) {
      spawnSync("tmux", [
        "bind-key", "d",
        "if-shell", "-F", "#{m:deer-*,#{session_name}}",
        "switch-client -l",
        "detach-client",
      ], { stdio: "inherit" });
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
    updateTask(agent.taskId, {
      prUrl: agent.result?.prUrl ?? null,
      finalBranch: agent.result?.finalBranch ?? null,
      status: agent.status,
      error: agent.error || null,
      lastActivity: agent.lastActivity,
      branch: agent.result?.finalBranch ?? agent.branch,
    });
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
    updateTask(agent.taskId, {
      lastActivity: agent.lastActivity,
      status: agent.status,
      error: agent.error || null,
    });
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
    runtimeTaskIdsRef.current.delete(agent.taskId);

    deleteTask(agent.taskId, cwd).catch(() => {});
    deleteTaskRow(agent.taskId);
    setAgents((prev) => prev.filter((a) => a !== agent));
  }, [cwd, setAgents]);

  // ── Retry agent ───────────────────────────────────────────────────

  const retryAgent = useCallback((agent: AgentState) => {
    const runtime = runtimeRef.current.get(agent.taskId);
    if (runtime) {
      runtime.abortController.abort();
      clearInterval(runtime.timer);
      runtimeRef.current.delete(agent.taskId);
    }
    runtimeTaskIdsRef.current.delete(agent.taskId);

    const { prompt, baseBranch, worktreePath, branch, taskId, createdAt, result } = agent;
    const effectiveBranch = result?.finalBranch || branch;

    if (worktreePath) {
      agent.deleted = true;
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

  const resumeLiveSession = useCallback(async (agent: AgentState) => {
    if (runtimeRef.current.has(agent.taskId)) return;
    if (!claimPoller(agent.taskId, process.pid)) return;

    const sessionName = `deer-${agent.taskId}`;
    const dead = await isTmuxSessionDead(sessionName);
    if (dead) {
      releasePoller(agent.taskId, process.pid);
      updateTask(agent.taskId, {
        status: "interrupted",
        finishedAt: Date.now(),
      });
      agent.status = "interrupted";
      agent.idle = false;
      agent.lastActivity = t("activity_interrupted");
      setAgents((prev) => [...prev]);
      return;
    }

    agent.status = "running";
    const abortController = new AbortController();
    const timer = setInterval(() => {
      if (!agent.idle) agent.elapsed++;
      setAgents((prev) => [...prev]);
    }, 1000);

    runtimeRef.current.set(agent.taskId, { abortController, timer });
    runtimeTaskIdsRef.current.add(agent.taskId);
    updateTask(agent.taskId, { status: "running", pollerPid: process.pid });
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
      runtimeTaskIdsRef.current.delete(agent.taskId);
      paneStateRef.current.delete(agent.taskId);

      if (!agent.deleted) {
        updateTask(agent.taskId, {
          status: agent.status,
          finishedAt: Date.now(),
          error: agent.error || null,
          idle: agent.idle,
          lastActivity: agent.lastActivity,
          elapsed: agent.elapsed,
          cost: agent.cost,
          finalBranch: agent.result?.finalBranch ?? null,
          prUrl: agent.result?.prUrl ?? null,
        });
        releasePoller(agent.taskId, process.pid);
      }
      setAgents((prev) => [...prev]);
    }
  }, [cwd]);

  return { spawnAgent, killAgent, abortAllAgents, attachToAgent, openShell, createPr, updatePr, deleteAgent, retryAgent, resumeLiveSession };
}
