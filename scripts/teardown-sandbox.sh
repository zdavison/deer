#!/bin/bash
set -euo pipefail

# Post-session teardown: commit changes, push branch, create PR.
# Outputs JSON result to stdout on success.
#
# Usage: teardown-sandbox.sh <repo_root> <worktree_path> <sandbox_name> <temp_branch> <base_branch> [model] [deer_tmp_dir]
# Env:   GH_TOKEN (optional, falls back to gh auth token)

REPO_ROOT="$1"
WORKTREE_DIR="$2"
SANDBOX_NAME="$3"
TEMP_BRANCH="$4"
BASE_BRANCH="$5"
MODEL="${6:-sonnet}"
# Temp dir for deer artifacts (outside the worktree, inside GIT_DIR).
# Falls back to WORKTREE_DIR for backward compatibility.
DEER_TMP_DIR="${7:-$WORKTREE_DIR}"

COMMIT_MSG_FILE=".agent-commit-message"
BRANCH_NAME_FILE=".agent-branch-name"
PR_BODY_FILE=".agent-pr-body"

# ── Helpers ──────────────────────────────────────────────────────────

info()  { echo -e "\033[36m⏳ $*\033[0m" >&2; }
ok()    { echo -e "\033[32m✓  $*\033[0m" >&2; }
warn()  { echo -e "\033[33m⚠️  $*\033[0m" >&2; }
err()   { echo -e "\033[31m✗  $*\033[0m" >&2; }

# ── Stop sandbox ─────────────────────────────────────────────────────

info "Stopping sandbox..."
docker sandbox rm "$SANDBOX_NAME" 2>/dev/null || true
ok "Sandbox stopped"

# ── Clean up agent artifacts ─────────────────────────────────────────

rm -f "$DEER_TMP_DIR/.agent-prompt" "$DEER_TMP_DIR/.agent-metadata-prompt"

# ── Read agent-written metadata files ────────────────────────────────

if [ -f "$DEER_TMP_DIR/$COMMIT_MSG_FILE" ]; then
  COMMIT_MSG=$(cat "$DEER_TMP_DIR/$COMMIT_MSG_FILE")
  rm -f "$DEER_TMP_DIR/$COMMIT_MSG_FILE"
else
  COMMIT_MSG="chore: changes from sandboxed Claude session"
fi

AGENT_BRANCH_SLUG=""
if [ -f "$DEER_TMP_DIR/$BRANCH_NAME_FILE" ]; then
  AGENT_BRANCH_SLUG=$(cat "$DEER_TMP_DIR/$BRANCH_NAME_FILE" | tr -d '\n' \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//' \
    | cut -c1-50)
  rm -f "$DEER_TMP_DIR/$BRANCH_NAME_FILE"
fi

PR_BODY=""
if [ -f "$DEER_TMP_DIR/$PR_BODY_FILE" ]; then
  PR_BODY=$(cat "$DEER_TMP_DIR/$PR_BODY_FILE")
  rm -f "$DEER_TMP_DIR/$PR_BODY_FILE"
fi

# Clean up the session temp dir
rm -rf "$DEER_TMP_DIR"

# ── Clean up stale git locks ────────────────────────────────────────
# The sandbox may have been killed mid-git-operation, leaving lock files.

GIT_DIR=$(git -C "$WORKTREE_DIR" rev-parse --git-dir 2>/dev/null || true)
if [ -n "$GIT_DIR" ]; then
  rm -f "$GIT_DIR/index.lock" 2>/dev/null || true
fi

# ── Commit uncommitted changes (if any) ─────────────────────────────
# The agent may have already committed its work. Only create a commit if
# there are staged, unstaged, or untracked changes left over.

HAS_UNCOMMITTED=false
if ! git -C "$WORKTREE_DIR" diff --quiet \
   || ! git -C "$WORKTREE_DIR" diff --cached --quiet \
   || [ -n "$(git -C "$WORKTREE_DIR" ls-files --others --exclude-standard)" ]; then
  HAS_UNCOMMITTED=true
fi

if [ "$HAS_UNCOMMITTED" = true ]; then
  info "Committing uncommitted changes..."
  git -C "$WORKTREE_DIR" add -A
  # After cleanup, agent artifacts may have been the only changes — check before committing
  if ! git -C "$WORKTREE_DIR" diff --cached --quiet; then
    git -C "$WORKTREE_DIR" commit -m "$COMMIT_MSG"
    ok "Committed"
  else
    info "No real changes after cleanup — skipping commit"
  fi
fi

# ── Check if branch has any commits ahead of base ────────────────────

COMMITS_AHEAD=$(git -C "$WORKTREE_DIR" rev-list --count "$BASE_BRANCH..HEAD" 2>/dev/null || echo "0")
if [ "$COMMITS_AHEAD" = "0" ]; then
  warn "No changes were made. Skipping PR."
  echo '{"finalBranch":"","prUrl":""}'
  exit 0
fi

# ── Rename branch ────────────────────────────────────────────────────

# Remove worktree before renaming (can't rename a checked-out branch)
git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true

if [ -n "$AGENT_BRANCH_SLUG" ]; then
  FINAL_BRANCH="deer/$AGENT_BRANCH_SLUG"

  # Avoid collision with existing remote branches
  if git -C "$REPO_ROOT" ls-remote --heads origin "$FINAL_BRANCH" | grep -q .; then
    FINAL_BRANCH="${FINAL_BRANCH}-$(head -c2 /dev/urandom | xxd -p)"
  fi
else
  FINAL_BRANCH="$TEMP_BRANCH"
fi

if [ "$FINAL_BRANCH" != "$TEMP_BRANCH" ]; then
  info "Renaming branch to $FINAL_BRANCH"
  git -C "$REPO_ROOT" branch -m "$TEMP_BRANCH" "$FINAL_BRANCH"
fi

# ── Push ─────────────────────────────────────────────────────────────

info "Pushing..."
git -C "$REPO_ROOT" push origin "$FINAL_BRANCH"

ok "Branch pushed"

# ── Create PR ────────────────────────────────────────────────────────

info "Creating pull request..."

export GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"

FIRST_SUBJECT=$(echo "$COMMIT_MSG" | head -1)
PR_TITLE="🦌 $FIRST_SUBJECT"

if [ -z "$PR_BODY" ]; then
  PR_BODY="## Summary

Automated PR created from a sandboxed Claude session.

**Model:** $MODEL
**Base branch:** $BASE_BRANCH

### Commit message
$COMMIT_MSG

---

> Review carefully — this PR was created by deer in a sandboxed session."
fi

PR_URL=$(cd "$REPO_ROOT" && gh pr create \
  --base "$BASE_BRANCH" \
  --head "$FINAL_BRANCH" \
  --title "$PR_TITLE" \
  --body "$PR_BODY")

ok "PR created: $PR_URL"

# ── Output result as JSON to stdout ──────────────────────────────────

# Escape strings for JSON
FINAL_BRANCH_JSON=$(printf '%s' "$FINAL_BRANCH" | sed 's/\\/\\\\/g; s/"/\\"/g')
PR_URL_JSON=$(printf '%s' "$PR_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat <<EOF
{"finalBranch":"$FINAL_BRANCH_JSON","prUrl":"$PR_URL_JSON"}
EOF
