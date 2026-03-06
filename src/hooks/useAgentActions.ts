import { useCallback } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { AgentState } from "../agent-state";
import { createAgentState } from "../agent-state";
import { upsertHistory, removeFromHistory, dataDir } from "../task";
import type { PersistedTask } from "../task";
import type { DeerConfig } from "../config";
import type { PreflightResult } from "../preflight";
import { startAgent, destroyAgent, deleteTask, createAgentPR } from "../agent";
import { updatePullRequest } from "../git/finalize";
import { isTmuxSessionDead, captureTmuxPane } from "../sandbox/index";
import { resolveRuntime } from "../sandbox/resolve";
import { transition } from "../state-machine";
import {
  appendLog,
  isActive,
  stripAnsi,
  truncate,
  withSuspendedTerminal,
  MODEL,
  POLL_MS,
  IDLE_THRESHOLD,
} from "../dashboard-utils";

async function saveToHistory(agent: AgentState, repoPath: string): Promise<void> {
  if (agent.historical) return;
  const task: PersistedTask = {
    taskId: agent.taskId,
    prompt: agent.prompt,
    status: agent.status as PersistedTask["status"],
    createdAt: new Date(Date.now() - agent.elapsed * 1000).toISOString(),
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
  nextId: MutableRefObject<number>;
  deletedTaskIdsRef: MutableRefObject<Set<string>>;
  baseBranchRef: MutableRefObject<string>;
  configRef: MutableRefObject<DeerConfig | null>;
  preflight: PreflightResult | null;
  setSuspended: (v: boolean) => void;
}

export function useAgentActions({
  cwd,
  setAgents,
  nextId,
  deletedTaskIdsRef,
  baseBranchRef,
  configRef,
  preflight,
  setSuspended,
}: AgentActionDeps) {

  // ── Spawn agent ───────────────────────────────────────────────────

  const spawnAgent = useCallback(async (prompt: string, baseBranch?: string, continueSession?: { taskId: string; worktreePath: string; branch: string }) => {
    if (!prompt.trim()) return;
    if (preflight && !preflight.ok) return;

    const config = configRef.current;
    if (!config) return;

    const id = nextId.current++;
    const effectiveBranch = baseBranch ?? baseBranchRef.current;
    const agent = createAgentState({
      id,
      prompt: prompt.trim(),
      baseBranch: effectiveBranch,
    });

    const abortController = new AbortController();
    agent.abortController = abortController;

    // Start elapsed timer — pauses while agent is idle
    agent.timer = setInterval(() => {
      if (!agent.idle) agent.elapsed++;
      setAgents((prev) => [...prev]);
    }, 1000);

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
        model: MODEL,
        runtime: resolveRuntime(config),
        continueSession,
        onStatus: (status) => {
          const detail = "message" in status ? status.message : status.phase;
          appendLog(agent, `[setup] ${detail}`);
          agent.lastActivity = detail;
          setAgents((prev) => [...prev]);
        },
      });

      agent.handle = handle;
      agent.taskId = handle.taskId;

      // Persist immediately so the task survives if deer closes
      await upsertHistory(cwd, {
        taskId: agent.taskId,
        prompt: agent.prompt,
        status: "running",
        createdAt: new Date().toISOString(),
        completedAt: null,
        elapsed: 0,
        prUrl: null,
        finalBranch: null,
        error: null,
        lastActivity: "",
      });

      agent.status = transition(agent.status, "SETUP_COMPLETE") ?? agent.status;
      appendLog(agent, `[running] Claude started in tmux session: ${handle.sessionName}`);
      agent.lastActivity = "Claude running...";
      setAgents((prev) => [...prev]);

      // Phase 2: Poll for completion (process exit or idle detection)
      let lastPaneSnapshot = "";
      let unchangedCount = 0;
      while (true) {
        await Bun.sleep(POLL_MS);
        if (abortController.signal.aborted) return;

        const dead = await isTmuxSessionDead(handle.sessionName);
        if (dead) {
          appendLog(agent, "[tmux] Claude process exited");
          break;
        }

        // Capture visible pane content and diff against previous frame
        const lines = await captureTmuxPane(handle.sessionName);
        if (lines) {
          const snapshot = lines.map(stripAnsi).map((l) => l.trim()).filter(Boolean).join("\n");

          if (snapshot === lastPaneSnapshot) {
            unchangedCount++;
          } else {
            unchangedCount = 0;
            lastPaneSnapshot = snapshot;

            // Update lastActivity with the latest ● line (Claude's text output)
            const lastOutput = lines
              .map(stripAnsi)
              .map((l) => l.trim())
              .filter((l) => l.startsWith("●"))
              .pop();
            if (lastOutput) {
              const activity = truncate(lastOutput, 120);
              if (activity !== agent.lastActivity) {
                agent.lastActivity = activity;
                appendLog(agent, `[tmux] ${truncate(lastOutput, 200)}`);
                // Persist progress so other deer instances see the current activity
                await upsertHistory(cwd, {
                  taskId: agent.taskId,
                  prompt: agent.prompt,
                  status: "running",
                  createdAt: new Date(Date.now() - agent.elapsed * 1000).toISOString(),
                  completedAt: null,
                  elapsed: agent.elapsed,
                  prUrl: null,
                  finalBranch: null,
                  error: null,
                  lastActivity: agent.lastActivity,
                });
                setAgents((prev) => [...prev]);
              }
            }
          }

          // Claude is idle when the pane hasn't changed for several consecutive polls
          if (unchangedCount >= IDLE_THRESHOLD && !agent.idle) {
            agent.idle = true;
            agent.lastActivity = "Idle — press ⏎ to attach";
            appendLog(agent, "[deer] Claude is idle");
            setAgents((prev) => [...prev]);
          } else if (unchangedCount === 0 && agent.idle) {
            agent.idle = false;
            setAgents((prev) => [...prev]);
          }
        }
      }

      if (abortController.signal.aborted) return;

      // Process exited — agent is now at rest, idle until deleted
      agent.idle = true;
      agent.result = { finalBranch: handle.branch, prUrl: "" };
      agent.lastActivity = "Idle — press p to create PR, ⏎ to attach";
    } catch (err) {
      if (!abortController.signal.aborted) {
        agent.status = transition(agent.status, "ERROR") ?? "failed";
        agent.error = err instanceof Error ? err.message : String(err);
        agent.lastActivity = truncate(agent.error, 120);
      }
    } finally {
      if (agent.timer) clearInterval(agent.timer);
      agent.timer = null;
      if (!agent.deleted) {
        await saveToHistory(agent, cwd);
      }
      setAgents((prev) => [...prev]);
    }
  }, [cwd, preflight]);

  // ── Kill agent ────────────────────────────────────────────────────

  const killAgent = useCallback((agent: AgentState) => {
    if (!isActive(agent)) return;
    agent.status = transition(agent.status, "USER_KILL") ?? "cancelled";
    agent.lastActivity = "Cancelled by user";
    agent.abortController?.abort();
    if (agent.handle) {
      agent.handle.kill().catch(() => {});
    }
    if (agent.timer) clearInterval(agent.timer);
    agent.timer = null;
    saveToHistory(agent, cwd);
    setAgents((prev) => [...prev]);
  }, [cwd]);

  // ── Attach to running agent (just tmux attach) ────────────────────

  const attachToAgent = useCallback(async (agent: AgentState) => {
    if (!agent.handle) return;

    await withSuspendedTerminal(setSuspended, async () => {
      // Small delay to let any pending keypress (e.g. the Enter that triggered
      // attach) flush through before tmux takes over stdin.
      await Bun.sleep(50);
      const { spawnSync } = await import("node:child_process");
      spawnSync("tmux", ["attach", "-t", agent.handle!.sessionName], {
        stdio: "inherit",
      });
    });

    // Update lastActivity after detach
    if (agent.handle && agent.status === "running") {
      const lines = await captureTmuxPane(agent.handle.sessionName);
      if (lines) {
        const lastLine = lines.map(stripAnsi).map((l) => l.trim()).filter(Boolean).pop();
        if (lastLine) {
          agent.lastActivity = truncate(lastLine, 120);
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
      const { applyTmuxStatusBar } = await import("../sandbox/index");
      // Create detached session (no-op if already exists); then apply the
      // deer status bar, then attach — so ctrl+b d returns to deer like attach.
      spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", worktreePath, shell]);
      await applyTmuxStatusBar(sessionName);
      spawnSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
    });
  }, [setSuspended]);

  // ── Create PR ─────────────────────────────────────────────────────

  const createPr = useCallback(async (agent: AgentState) => {
    if (!agent.handle || agent.result?.prUrl) return;

    agent.creatingPr = true;
    agent.lastActivity = "Creating PR...";
    setAgents((prev) => [...prev]);

    try {
      const result = await createAgentPR(
        agent.handle,
        cwd,
        agent.baseBranch,
        agent.prompt,
      );
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
    agent.abortController?.abort();
    if (agent.timer) clearInterval(agent.timer);
    deleteTask(agent.taskId, cwd, agent.handle).catch(() => {});
    setAgents((prev) => prev.filter((a) => a !== agent));
    deletedTaskIdsRef.current.add(agent.taskId);
    removeFromHistory(cwd, agent.taskId).finally(() => {
      deletedTaskIdsRef.current.delete(agent.taskId);
    });
  }, [cwd, setAgents, deletedTaskIdsRef]);

  return { spawnAgent, killAgent, attachToAgent, openShell, createPr, updatePr, deleteAgent };
}
