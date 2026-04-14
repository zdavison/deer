---
title: Creating PRs
outline: deep
---

# Creating PRs

## Creating a PR

Once an agent becomes idle (finished its work), you can create a pull request directly from the dashboard:

1. Select the agent in the agent list.
2. Press `p`.
3. deer stages all changes in the worktree and creates a commit.
4. Claude generates a descriptive branch name, PR title, and PR body from the diff.
5. The branch is renamed from `deer/<taskId>` to `deer/<descriptive-name>`.
6. Changes are pushed and the PR is created via `gh pr create`.

The PR opens in your browser automatically once created. If the agent already has a PR, pressing `p` opens the existing PR in your browser instead.

## PR templates

deer automatically looks for `.github/PULL_REQUEST_TEMPLATE.md` in your repository. When a template exists, Claude conforms the PR body to your template's structure, filling in each section based on the changes made.

## Updating a PR

If an agent already has a PR and you want to push additional changes:

1. Select the agent.
2. Press `u`.
3. deer commits the new changes, regenerates the PR metadata (title and body) from the full diff, and pushes.
4. If you authored the PR, the title and body are updated on GitHub to reflect the latest changes.

## PR language

The `--lang` flag controls the language Claude uses when writing PR titles and bodies:

```sh
deer --lang=ja
```

When set, Claude writes the PR title and description in the specified language. Branch names always remain ASCII English regardless of this setting.

See [Configuration](/configuration/) for all supported language codes.

## PR footer

All PRs created by deer include a footer:

> Created by deer -- review carefully.
