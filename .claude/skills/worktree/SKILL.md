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
2. **Initializes git submodules** (`git submodule update --init --recursive`) - required for `event-engine-common`
3. **Copies `.env`** from the main worktree to the new worktree
4. **Runs `pnpm install`** to set up dependencies (leverages pnpm's content-addressable store for fast installs)

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

## Merging a Worktree to Main

When the user asks to "merge the worktree" or "merge to main", follow this workflow:

1. **Commit changes in the worktree:**
   ```bash
   cd /path/to/worktree
   git add <files>
   git commit -m "feat/fix: description"
   ```

2. **Update and merge to main:**
   ```bash
   cd /path/to/main-worktree
   git fetch origin && git checkout main && git pull origin main
   git merge <branch-name> --no-edit
   git push origin main
   ```

3. **Clean up the worktree and branch:**
   ```bash
   # Remove the worktree directory (use --force if needed)
   rm -rf /path/to/worktree

   # Delete the local branch
   git branch -d <branch-name>

   # Optionally delete remote branch
   git push origin --delete <branch-name>
   ```

### Example

```bash
# 1. Commit in worktree
cd ../model-share-fix-my-bug
git add src/file.ts
git commit -m "fix: resolve the bug"

# 2. Merge to main
cd ../model-share
git fetch origin && git checkout main && git pull origin main
git merge fix/my-bug --no-edit
git push origin main

# 3. Clean up
rm -rf ../model-share-fix-my-bug
git branch -d fix/my-bug
```

## Notes

- Branch names with slashes are converted to dashes in the directory name
- The `.env` file is copied (not symlinked) so you can customize environment per worktree if needed
- Uses pnpm's content-addressable store, so subsequent worktree installs are fast
- After creation, use `/dev-server` skill to start the dev server in the new worktree
