---
name: worktree
description: Create and manage git worktrees with automatic environment setup. Creates worktrees at ../model-share-<branch>, copies .env, and runs pnpm install.
---

# Worktree Setup Skill

Creates git worktrees with all necessary setup for running the dev server. Handles the tedious setup steps so you can start working immediately.

## Quick Start

```bash
# Create a worktree for a new branch
node .claude/skills/worktree/cli.mjs create feature/my-feature

# Create a worktree for an existing branch
node .claude/skills/worktree/cli.mjs create existing-branch

# List all worktrees
node .claude/skills/worktree/cli.mjs list

# Remove a worktree
node .claude/skills/worktree/cli.mjs remove feature/my-feature
```

## What It Does

When you create a worktree, the skill:

1. **Creates the git worktree** at `../model-share-<branch-name>` (slashes in branch names are replaced with dashes)
2. **Copies `.env`** from the main worktree to the new worktree
3. **Runs `pnpm install`** to set up dependencies (leverages pnpm's content-addressable store for fast installs)

## CLI Commands

| Command | Description |
|---------|-------------|
| `create <branch>` | Create a new worktree for the specified branch |
| `list` | List all worktrees |
| `remove <branch>` | Remove a worktree (deletes directory and prunes git worktree) |

## Examples

```bash
# Create worktree for a new feature
node .claude/skills/worktree/cli.mjs create feature/user-auth
# Creates: ../model-share-feature-user-auth

# Create worktree for a bugfix
node .claude/skills/worktree/cli.mjs create fix/login-issue
# Creates: ../model-share-fix-login-issue

# Remove when done
node .claude/skills/worktree/cli.mjs remove fix/login-issue
```

## Notes

- Branch names with slashes are converted to dashes in the directory name
- The `.env` file is copied (not symlinked) so you can customize environment per worktree if needed
- Uses pnpm's content-addressable store, so subsequent worktree installs are fast
- After creation, use `/dev-server` skill to start the dev server in the new worktree
