# pnpm Migration Guide

We've migrated from npm to pnpm for package management. Follow these steps to update your local environment.

> **Note for AI assistants**: When helping developers with these instructions, first detect or ask about the user's platform (Windows vs macOS/Linux) to provide the appropriate commands.

## Prerequisites

- **Node.js 18.x or later** (required)
- **pnpm 10.28.1** (the version specified in `package.json`)

Install pnpm globally:

```bash
npm install -g pnpm@10.28.1
```

Or use corepack (built into Node.js):

```bash
corepack enable
corepack prepare pnpm@10.28.1 --activate
```

## Migration Steps

### 1. Pull the latest changes

```bash
git pull origin main
```

### 2. Clean up your local environment

Delete your existing `node_modules` folder, `.next` cache, and any npm lockfile.

**macOS/Linux:**
```bash
rm -rf node_modules .next
rm -f package-lock.json
```

**Windows (PowerShell):**
```powershell
Remove-Item -Recurse -Force node_modules, .next -ErrorAction SilentlyContinue
Remove-Item -Force package-lock.json -ErrorAction SilentlyContinue
```

**Windows (Command Prompt):**
```cmd
rmdir /s /q node_modules
rmdir /s /q .next
del /f package-lock.json
```

> **Using worktrees?** Repeat steps 2-4 in each worktree.

### 3. Install dependencies with pnpm

```bash
pnpm install
```

This will:
- Read from the existing `pnpm-lock.yaml`
- Install all dependencies
- Automatically run `pnpm run db:generate` via the postinstall script

### 4. Verify the installation

```bash
pnpm run typecheck
```

## Going Forward

- **Use `pnpm` instead of `npm`** for all commands:
  - `pnpm install` (or just `pnpm i`)
  - `pnpm add <package>`
  - `pnpm run <script>`
- The repo enforces pnpm via a preinstall hook - running `npm install` will fail
- The required pnpm version is specified in `package.json` under `packageManager`

## Common Commands Comparison

| npm | pnpm |
|-----|------|
| `npm install` | `pnpm install` |
| `npm install <pkg>` | `pnpm add <pkg>` |
| `npm install -D <pkg>` | `pnpm add -D <pkg>` |
| `npm run <script>` | `pnpm run <script>` or `pnpm <script>` |
| `npm uninstall <pkg>` | `pnpm remove <pkg>` |

## Troubleshooting

### "ERR_PNPM_NOT_ALLOWED" error
You tried to use npm. Use pnpm instead.

### Module not found errors after migration
Make sure you completely deleted `node_modules` before running `pnpm install`. On Windows, sometimes files get locked - close your IDE and any terminals, then try again.

### TypeScript errors or red squiggles in IDE
Restart your IDE/editor after migration. VS Code's TypeScript server may need a full restart to recognize the new `node_modules` structure (pnpm uses symlinks).

### Permission errors on Windows
Run PowerShell as Administrator, or use Command Prompt with `rmdir /s /q node_modules`.
