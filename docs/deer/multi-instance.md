---
title: Multi-Instance
outline: deep
---

# Multi-Instance

## Running multiple deer instances

Multiple deer processes can run against the same repository simultaneously. There is no locking or single-instance restriction. Each instance shows the same set of agents and can interact with any of them.

All agent state is stored in a shared SQLite database at `~/.local/share/deer/deer.db`. Each deer instance polls this database to stay in sync with the others.

## Poller claims

Each running agent needs exactly one process polling its tmux session to detect when it becomes idle or finishes. deer uses a compare-and-swap (CAS) mechanism on the `poller_pid` column in the database to coordinate this:

- When a deer instance starts, it claims polling responsibility for unclaimed agents by writing its own PID to `poller_pid`.
- Only one instance can hold the claim at a time.
- If the owning process dies (its PID is no longer alive), another instance detects this on its next sync cycle and reclaims the poller.

This ensures that every agent is monitored by exactly one process at all times, without requiring inter-process communication.

## Cross-instance behaviour

Because all state lives in the shared database:

- Agents launched by instance A appear in instance B's dashboard on the next poll cycle.
- Any instance can attach to any agent's tmux session (press Enter).
- Any instance can kill, retry, or create PRs for any agent.
- Status changes made by one instance (e.g. marking an agent as cancelled) are visible to all other instances within one poll interval.
