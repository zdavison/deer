import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./task";
import type { TaskMetadata } from "./task";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Live state for a running task, written to disk by the owning deer instance
 * and read by any other instances watching the same tasks directory.
 *
 * Stored at: ~/.local/share/deer/tasks/<taskId>/state.json
 */
export interface TaskStateFile extends TaskMetadata {
  /** Capped ring buffer of recent log lines */
  logs: string[];
  /** True when Claude is idle (waiting for user input) */
  idle: boolean;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** PID of the deer process that owns this task */
  ownerPid: number;
}

// ── Paths ─────────────────────────────────────────────────────────────

/**
 * Returns the state file path for a task.
 * @example "/home/user/.local/share/deer/tasks/deer_xxx/state.json"
 */
export function taskStatePath(taskId: string): string {
  return join(dataDir(), "tasks", taskId, "state.json");
}

// ── Read / Write / Remove ─────────────────────────────────────────────

/**
 * Read the live state file for a task.
 * Returns null if no state file exists (task is not live).
 */
export async function readTaskState(taskId: string): Promise<TaskStateFile | null> {
  const file = Bun.file(taskStatePath(taskId));
  if (!(await file.exists())) return null;
  try {
    return await file.json() as TaskStateFile;
  } catch {
    return null;
  }
}

/**
 * Write the live state file for a task, creating the task directory if needed.
 * Only the owning deer instance should call this.
 */
export async function writeTaskState(state: TaskStateFile): Promise<void> {
  const path = taskStatePath(state.taskId);
  await mkdir(join(dataDir(), "tasks", state.taskId), { recursive: true });
  await Bun.write(path, JSON.stringify(state));
}

/**
 * Remove the live state file for a task.
 * Called when a task completes, fails, or is deleted.
 */
export async function removeTaskState(taskId: string): Promise<void> {
  const path = taskStatePath(taskId);
  try {
    await Bun.$`rm -f ${path}`.quiet();
  } catch {
    // Ignore — file may already be gone
  }
}

// ── Owner Detection ───────────────────────────────────────────────────

/**
 * Returns true if the process with the given PID is still running.
 * Uses signal 0 which tests process existence without sending a real signal.
 */
export function isOwnerAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Directory Scan ────────────────────────────────────────────────────

/**
 * Scan the tasks directory for all taskIds that have a live state file.
 * Returns an empty array if the directory does not exist.
 */
export async function scanLiveTaskIds(): Promise<string[]> {
  const tasksDir = join(dataDir(), "tasks");
  try {
    const glob = new Bun.Glob("*/state.json");
    const taskIds: string[] = [];
    for await (const match of glob.scan({ cwd: tasksDir })) {
      // match is like "deer_xxx/state.json" — extract the taskId
      const taskId = match.replace("/state.json", "");
      if (taskId.startsWith("deer_")) {
        taskIds.push(taskId);
      }
    }
    return taskIds;
  } catch {
    return [];
  }
}
