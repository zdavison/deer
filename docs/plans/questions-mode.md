# Questions Mode: Persist Chat When No Code Changes

## Problem

Deer has two usage modes:

1. **Code tasks** — agent writes code, deer opens a PR
2. **Questions** — user asks a question, agent answers with no code changes

For mode 2, the current flow hits the "no changes" path in teardown and displays `No changes` in the dashboard with nothing actionable. The conversation — which contains the actual answer — is lost.

## Goal

When a deer run produces no code changes, persist the conversation transcript to a file and let the user press Enter to open it in their editor.

## Design

### Transcript Capture

The NDJSON stream from Claude already flows through `parseNdjsonLine()` in `dashboard.tsx`. We capture a clean, human-readable transcript alongside the existing `logs[]` array.

Add a `transcript: string[]` field to `AgentState`. As NDJSON events arrive:

| Event type                  | Append to transcript                       |
| --------------------------- | ------------------------------------------ |
| `assistant` → `text` block  | `## Assistant\n\n{text}`                   |
| `assistant` → `tool_use`    | (skip — not useful in Q&A context)         |
| `result` with `.result`     | (skip — tool results, not conversation)    |
| User prompt (initial)       | `## User\n\n{prompt}` (prepended at start) |

The transcript is a markdown document that reads well in any editor.

### Detecting "No Changes"

The teardown script already handles this — when `COMMITS_AHEAD=0`, it outputs `{"finalBranch":"","prUrl":""}`. The dashboard receives this as `agent.result.prUrl === ""`.

No new detection logic needed. We just branch on this existing signal.

### Persisting the Transcript

When teardown completes with no PR (empty `prUrl`):

1. Write transcript to `~/.local/share/deer/transcripts/{taskId}.md`
2. Store the path in a new `AgentState.transcriptPath: string | null` field
3. Set `agent.lastActivity` to something like `"Answer ready — press Enter to view"`

File format:

```markdown
# deer — {first 80 chars of prompt}

**Date:** 2026-03-04 14:23
**Repo:** github.com/org/repo

---

## User

{original prompt}

## Assistant

{agent response text}
```

### Opening in Editor

The dashboard already handles Enter on completed agents — it opens the PR URL. Extend this:

```
if (agent.result?.prUrl)     → openUrl(prUrl)
else if (agent.transcriptPath) → openInEditor(transcriptPath)
```

`openInEditor` implementation:

```typescript
function openInEditor(filePath: string) {
  const editor = process.env.EDITOR || "vim";
  // Same suspend/restore pattern as shellIntoAgent
  Bun.spawn([editor, filePath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}
```

This follows the same suspend/restore pattern already used by `shellIntoAgent` and `attachToAgent` — leave alternate screen, release raw mode, wait for process exit, restore.

### UI Changes

**Status display for Q&A completions:**

| State                    | Icon | Activity text                       |
| ------------------------ | ---- | ----------------------------------- |
| Completed with PR        | ✓    | `https://github.com/org/repo/pull/1`|
| Completed with transcript| ✓    | `Answer ready — Enter to view`      |

**Footer hint update:** Change `⏎ attach/open` to `⏎ attach/view/open` (or just leave it — "open" covers both cases).

## Changes Required

### `src/dashboard.tsx`

1. **AgentState** — add `transcript: string[]` and `transcriptPath: string | null`
2. **parseNdjsonLine()** — append readable text blocks to `agent.transcript`
3. **spawnAgent()** — after teardown completes with empty prUrl:
   - Build markdown from `agent.transcript`
   - Write to `~/.local/share/deer/transcripts/{id}.md`
   - Set `agent.transcriptPath`
   - Update `agent.lastActivity`
4. **Enter key handler** — if `agent.transcriptPath`, call `openInEditor(agent)` instead of `openUrl`
5. **openInEditor()** — new function, mirrors `shellIntoAgent` suspend/restore pattern

### `src/task.ts`

6. Add `transcriptsDir()` helper returning `~/.local/share/deer/transcripts`

### New files

None.

## Non-Goals

- Persisting transcripts for code-change runs (they have PRs)
- Streaming the transcript to disk during the run (only write on completion)
- Any changes to the teardown script
- Chat-style back-and-forth (deer is single-prompt today)
