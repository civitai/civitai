---
name: typecheck
description: Fast TypeScript type checking using tsgo (TypeScript 7 native). Daemon watches for changes, agents get cached results instantly.
---

# TypeCheck Skill (tsgo)

**EXPERIMENTAL** - Fast TypeScript type checking using tsgo (TypeScript 7 native preview).

## Performance

| Scenario | Time |
|----------|------|
| `npm run typecheck` (tsc) | ~60-90 seconds |
| tsgo initial check | ~12-18 seconds |
| tsgo cached result (no changes) | instant |
| tsgo after file change | ~2-18 seconds* |

*Rebuild time depends on how many files depend on the changed file.

## npm Scripts

```bash
npm run typecheck:fast   # Get cached result (instant if daemon running)
npm run typecheck:watch  # Interactive watch mode
npm run typecheck:stop   # Stop the daemon
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `status` | Check daemon status and latest result |
| `result [--pretty]` | Get cached result (use --pretty for tsc-like output) |
| `check` | Force a fresh type check |
| `history [limit]` | Get check history |
| `watch` | Watch for results (interactive) |
| `shutdown` | Stop the daemon |
| `run` | One-off check without daemon |

## How It Works

1. **Daemon auto-starts** on first CLI command
2. **File watcher** (chokidar) monitors `src/` for changes
3. **tsgo runs** on file changes with incremental mode
4. **Results cached** for instant access

## Known Limitations

- **Windows**: Rebuild times can be slow (~12-18s) for files with many dependents
- tsgo is still in preview - may have bugs or missing features
- Incremental mode helps for repeated checks but doesn't speed up rebuilds after actual content changes

## Daemon Endpoints (port 9445)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Basic status |
| `/status` | GET | Full status with result |
| `/result` | GET | Latest result only |
| `/history` | GET | Check history |
| `/run` | POST | Trigger check |
| `/shutdown` | POST | Stop daemon |

## Notes

- Uses `tsconfig.tsgo.json` for tsgo-compatible settings
- tsgo may catch errors that tsc 5.x misses (stricter)
- Uses native binary directly (avoids npx overhead)
