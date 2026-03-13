import { useEffect } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { AgentState } from "../agent-state";
import { checkPrState } from "../github";
import { updateTask } from "../db";
import { PR_MERGE_CHECK_INTERVAL_MS } from "../constants";

export function usePrPoller(
  agentsRef: MutableRefObject<AgentState[]>,
  setAgents: Dispatch<SetStateAction<AgentState[]>>,
) {
  useEffect(() => {
    const check = async () => {
      const toCheck = agentsRef.current.filter(
        (a) => a.result?.prUrl && (a.prState === null || a.prState === "open"),
      );
      if (toCheck.length === 0) return;

      const results = await Promise.all(
        toCheck.map((agent) => checkPrState(agent.result!.prUrl)),
      );
      let changed = false;
      for (let i = 0; i < toCheck.length; i++) {
        const state = results[i];
        if (state !== toCheck[i].prState) {
          toCheck[i].prState = state;
          updateTask(toCheck[i].taskId, { prState: state });
          changed = true;
        }
      }
      if (changed) setAgents((prev) => [...prev]);
    };

    check();
    const interval = setInterval(check, PR_MERGE_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
}
