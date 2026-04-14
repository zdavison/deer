---
title: Context System
outline: deep
---

# Context System

The context system lets you attach extra information to a prompt before launching an agent. Context chips appear in the chip bar above the prompt input.

## The @ picker

Type `@` in the prompt input to open the context picker. A fuzzy search overlay appears, listing all available context sources. Type to filter, then select a source to attach it as a chip.

Selected chips appear in the context chip bar above the input. You can attach multiple chips to a single prompt (subject to per-source limits).

## Available sources

### Branch

| | |
|---|---|
| **Icon** | fork symbol |
| **Limit** | 1 per prompt |
| **Searches** | Local and remote git branches |

Selecting a branch overrides the base branch for that agent. Instead of branching from the repository's default branch, the agent's worktree starts from the selected branch.

This is useful when you want an agent to build on work from another branch -- for example, adding tests to a feature branch or fixing a bug on a release branch.

## How context affects agents

Each context source translates into a parameter override when launching the agent:

| Source | Effect |
|--------|--------|
| Branch | Overrides `baseBranch` -- the agent's worktree checks out from the selected branch instead of the repo default. |
