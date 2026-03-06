import { IDLE_THRESHOLD } from "./constants";

export interface PaneState {
  snapshot: string;
  unchangedCount: number;
}

/**
 * Advance pane state given a new snapshot. Increments the unchanged count
 * when the snapshot is stable, resets it on any change.
 */
export function advancePaneState(state: PaneState, newSnapshot: string): PaneState {
  if (newSnapshot === state.snapshot) {
    return { snapshot: newSnapshot, unchangedCount: state.unchangedCount + 1 };
  }
  return { snapshot: newSnapshot, unchangedCount: 0 };
}

/**
 * Returns true when the pane has been stable long enough to consider Claude idle.
 */
export function isIdleState(state: PaneState, threshold = IDLE_THRESHOLD): boolean {
  return state.unchangedCount >= threshold;
}

/**
 * Creates a PaneState pre-seeded as idle for a given snapshot. Used after
 * detaching from tmux when the pane is confirmed stable, so the next poll
 * immediately recognises idle without waiting for the full threshold again.
 */
export function seedIdleState(snapshot: string): PaneState {
  return { snapshot, unchangedCount: IDLE_THRESHOLD };
}
