#!/bin/bash
set -euo pipefail

# Creates a Docker Sandbox for a deer agent session.
# Requires CLAUDE_CODE_OAUTH_TOKEN to already be set (no interactive prompt).
# Outputs JSON metadata to stdout on success.
#
# Usage: setup-sandbox.sh <repo_root> [model]
# Env:   CLAUDE_CODE_OAUTH_TOKEN (required)
#        GH_TOKEN (optional, falls back to gh auth token)
#        DEER_GIT_NAME (optional, default: deer-agent)
#        DEER_GIT_EMAIL (optional, default: deer@noreply)

REPO_ROOT="$1"
MODEL="${2:-sonnet}"

GIT_NAME="${DEER_GIT_NAME:-deer-agent}"
GIT_EMAIL="${DEER_GIT_EMAIL:-deer@noreply}"

# ── Helpers ──────────────────────────────────────────────────────────

# All human-readable output goes to stderr so stdout stays clean for JSON
info()  { echo -e "\033[36m⏳ $*\033[0m" >&2; }
ok()    { echo -e "\033[32m✓  $*\033[0m" >&2; }
warn()  { echo -e "\033[33m⚠️  $*\033[0m" >&2; }
err()   { echo -e "\033[31m✗  $*\033[0m" >&2; }

# ── Preflight ────────────────────────────────────────────────────────

if ! docker sandbox version > /dev/null 2>&1; then
  err "Docker Sandbox not available. Install Docker Desktop 4.58+ and enable Sandbox support."
  exit 1
fi

GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
if [ -z "$GH_TOKEN" ]; then
  err "Could not obtain GH_TOKEN. Run 'gh auth login' first."
  exit 1
fi

TOKEN_FILE="$HOME/.claude/agent-oauth-token"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")"
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  err "No OAuth token found. Set CLAUDE_CODE_OAUTH_TOKEN or create $TOKEN_FILE"
  exit 1
fi

# The Docker Sandbox proxy reads ANTHROPIC_API_KEY from the host process and
# injects it into all Anthropic API requests, overriding OAuth auth. Unset it
# so the proxy doesn't interfere with CLAUDE_CODE_OAUTH_TOKEN.
unset ANTHROPIC_API_KEY 2>/dev/null || true

# Use the remote default branch (usually master) as the base for PRs
BASE_BRANCH="$(cd "$REPO_ROOT" && git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p')"
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH="master"
fi

# The worktree starts from the user's current branch, not the remote default.
# This lets agents work on top of whatever the user had checked out.
CURRENT_BRANCH="$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD)"

GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir)"

# Temporary branch name — renamed to something descriptive after the session
TEMP_BRANCH="deer/session-$(date +%s)-$(head -c4 /dev/urandom | xxd -p)"
COMMIT_MSG_FILE=".agent-commit-message"
BRANCH_NAME_FILE=".agent-branch-name"
PR_BODY_FILE=".agent-pr-body"

# ── Create worktree ──────────────────────────────────────────────────

info "Creating worktree..."

WORKTREE_DIR="$(mktemp -u)"  # path only, git worktree add creates the dir
SANDBOX_NAME="deer-$(printf '%s' "$TEMP_BRANCH" | md5sum | cut -c1-8)"

git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" -b "$TEMP_BRANCH" "$CURRENT_BRANCH" 2>&1 >&2

# Discard any dirty state so the agent starts from a clean HEAD.
# git worktree add should already produce a clean checkout, but if the
# user's branch has uncommitted index entries that leak through, this
# ensures a pristine starting point without touching the main directory.
git -C "$WORKTREE_DIR" checkout -- . 2>/dev/null || true
git -C "$WORKTREE_DIR" clean -fd 2>/dev/null || true

ok "Worktree ready (from $CURRENT_BRANCH)"

# ── Create and configure sandbox ─────────────────────────────────────

info "Creating Docker Sandbox..."

docker sandbox create \
  --name "$SANDBOX_NAME" \
  claude \
  "$WORKTREE_DIR" \
  "$GIT_DIR"

# Install tmux for interactive session management
docker sandbox exec "$SANDBOX_NAME" \
  sh -c "command -v tmux >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq tmux >/dev/null 2>&1)" 2>/dev/null \
  || warn "Could not install tmux — interactive attach will use direct exec"

# Configure git inside the sandbox
docker sandbox exec "$SANDBOX_NAME" \
  git config --global user.name "$GIT_NAME"
docker sandbox exec "$SANDBOX_NAME" \
  git config --global user.email "$GIT_EMAIL"
# Skip hooks — sandbox doesn't have deps installed for lint-staged/husky
docker sandbox exec "$SANDBOX_NAME" \
  git -C "$WORKTREE_DIR" config core.hooksPath /dev/null

# ── Configure sandbox auth ────────────────────────────────────────────
# The sandbox's `claude` template ships settings.json with apiKeyHelper
# set to "echo proxy-managed". This makes Claude Code use the proxy's
# credential injection instead of env vars. We remove it so Claude Code
# uses CLAUDE_CODE_OAUTH_TOKEN (passed via env at exec time).

SANDBOX_HOME="$(docker sandbox exec "$SANDBOX_NAME" sh -c 'echo $HOME')"

# Write settings.json without apiKeyHelper
cat > "$WORKTREE_DIR/.sandbox-settings.json" <<'SETTINGS'
{
  "themeId": 1,
  "alwaysThinkingEnabled": true,
  "defaultMode": "bypassPermissions",
  "bypassPermissionsModeAccepted": true
}
SETTINGS

docker sandbox exec "$SANDBOX_NAME" \
  sh -c "cp $WORKTREE_DIR/.sandbox-settings.json $SANDBOX_HOME/.claude/settings.json && rm $WORKTREE_DIR/.sandbox-settings.json"

# Copy ~/.claude.json (note: home dir, NOT inside ~/.claude/) into the sandbox.
# This file contains onboarding state, theme, preferences. The onboarding gate
# requires both "theme" and "hasCompletedOnboarding" to be set.
if [ -f "$HOME/.claude.json" ]; then
  cp "$HOME/.claude.json" "$WORKTREE_DIR/.claude.json.staging"
  docker sandbox exec "$SANDBOX_NAME" \
    sh -c "cp $WORKTREE_DIR/.claude.json.staging $SANDBOX_HOME/.claude.json && rm $WORKTREE_DIR/.claude.json.staging"
else
  # Fallback: write minimal .claude.json to skip onboarding
  docker sandbox exec "$SANDBOX_NAME" \
    sh -c "echo '{\"hasCompletedOnboarding\":true,\"theme\":\"dark\",\"numStartups\":100}' > $SANDBOX_HOME/.claude.json"
  warn "No ~/.claude.json found — using defaults"
fi

# Pre-accept "trust this folder", "bypass permissions", and MCP servers
# for the worktree dir. All stored per-project in ~/.claude.json.
docker sandbox exec "$SANDBOX_NAME" \
  node -e "
    const fs = require('fs');
    const p = process.env.HOME + '/.claude.json';
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!c.projects) c.projects = {};

    // Read .mcp.json to pre-approve its servers
    let mcpServers = [];
    try {
      const mcp = JSON.parse(fs.readFileSync('$WORKTREE_DIR/.mcp.json', 'utf8'));
      mcpServers = Object.keys(mcp.mcpServers || {});
    } catch {}

    c.projects['$WORKTREE_DIR'] = {
      ...(c.projects['$WORKTREE_DIR'] || {}),
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      allowedTools: [],
      enabledMcpjsonServers: mcpServers,
    };

    // Also accept bypass permissions globally
    c.bypassPermissionsModeAccepted = true;
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  "

ok "Sandbox ready"

# ── Inject agent instructions ──────────────────────────────────────────
# Metadata files (branch name, commit message, PR body) are requested in
# a follow-up message after the main task — see dashboard.tsx startClaudeMetadata().

cat >> "$WORKTREE_DIR/CLAUDE.md" <<'AGENT_RULES'

# Sandbox Agent Rules

- Do NOT modify CLAUDE.md.
AGENT_RULES

# ── Output metadata as JSON to stdout ─────────────────────────────────

cat <<EOF
{"sandboxName":"$SANDBOX_NAME","worktreePath":"$WORKTREE_DIR","tempBranch":"$TEMP_BRANCH","baseBranch":"$BASE_BRANCH","sandboxHome":"$SANDBOX_HOME","model":"$MODEL"}
EOF
