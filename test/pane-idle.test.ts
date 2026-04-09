import { test, expect, describe } from "bun:test";
import { advancePaneState, isIdleState, seedIdleState } from "../src/pane-idle";
import type { PaneState } from "../src/pane-idle";
import { IDLE_THRESHOLD } from "../src/constants";

function emptyState(): PaneState {
  return { snapshot: "", unchangedCount: 0 };
}

describe("advancePaneState", () => {
  test("new snapshot resets count to 0", () => {
    const state = advancePaneState(emptyState(), "hello");
    expect(state.unchangedCount).toBe(0);
    expect(state.snapshot).toBe("hello");
  });

  test("same snapshot increments count", () => {
    let state = advancePaneState(emptyState(), "hello");
    state = advancePaneState(state, "hello");
    expect(state.unchangedCount).toBe(1);
  });

  test("count accumulates across stable polls", () => {
    let state = advancePaneState(emptyState(), "x");
    for (let i = 0; i < 5; i++) {
      state = advancePaneState(state, "x");
    }
    expect(state.unchangedCount).toBe(5);
  });

  test("count resets when snapshot changes again", () => {
    let state = advancePaneState(emptyState(), "x");
    state = advancePaneState(state, "x"); // count = 1
    state = advancePaneState(state, "y"); // changed → count = 0
    expect(state.unchangedCount).toBe(0);
    expect(state.snapshot).toBe("y");
  });
});

describe("isIdleState", () => {
  test("not idle below threshold", () => {
    expect(isIdleState({ snapshot: "x", unchangedCount: IDLE_THRESHOLD - 1 }, IDLE_THRESHOLD)).toBe(false);
  });

  test("idle at threshold", () => {
    expect(isIdleState({ snapshot: "x", unchangedCount: IDLE_THRESHOLD }, IDLE_THRESHOLD)).toBe(true);
  });

  test("idle above threshold", () => {
    expect(isIdleState({ snapshot: "x", unchangedCount: IDLE_THRESHOLD + 5 }, IDLE_THRESHOLD)).toBe(true);
  });
});

describe("seedIdleState", () => {
  test("returns state with count equal to threshold", () => {
    const state = seedIdleState("stable-snapshot");
    expect(state.snapshot).toBe("stable-snapshot");
    expect(state.unchangedCount).toBe(IDLE_THRESHOLD);
  });

  test("seeded state is immediately considered idle", () => {
    const state = seedIdleState("stable-snapshot");
    expect(isIdleState(state, IDLE_THRESHOLD)).toBe(true);
  });

  test("advancing seeded state with same snapshot stays idle", () => {
    let state = seedIdleState("stable-snapshot");
    state = advancePaneState(state, "stable-snapshot");
    expect(isIdleState(state, IDLE_THRESHOLD)).toBe(true);
  });

  test("advancing seeded state with new snapshot resets to not-idle", () => {
    let state = seedIdleState("stable-snapshot");
    state = advancePaneState(state, "changed-snapshot");
    expect(isIdleState(state, IDLE_THRESHOLD)).toBe(false);
  });
});
