#!/usr/bin/env node
/**
 * PreToolUse hook for Bash commands.
 *
 * Behaviors:
 *   - Dangerous commands (taskkill node.exe, etc): Block outright (exit code 2)
 *   - Database writes (--writable): Prompt user for confirmation (JSON with "ask")
 *   - Everything else: Allow (exit code 0)
 */

import { stdin } from 'process';

// Patterns that would kill Claude Code or critical processes - BLOCK OUTRIGHT
const DANGEROUS_PATTERNS = [
  { pattern: /taskkill\s+\/\/F\s+\/\/IM\s+node\.exe/i, reason: 'This would kill all Node.js processes including Claude Code itself' },
  { pattern: /taskkill\s+.*node\.exe/i, reason: 'This would kill Node.js processes including Claude Code' },
  { pattern: /taskkill\s+.*python\.exe/i, reason: 'This could kill Python processes used by Claude Code' },
  { pattern: /kill\s+-9\s+.*node/i, reason: 'This would kill Node.js processes including Claude Code' },
  { pattern: /pkill\s+.*node/i, reason: 'This would kill Node.js processes including Claude Code' },
  { pattern: /rm\s+-rf\s+\/(?!\w)/i, reason: 'This would recursively delete the root filesystem' },
  {
    pattern: /prettier[^;&|]*prettier-plugin-svelte/i,
    reason:
      'Ad-hoc prettier with prettier-plugin-svelte EMPTIES .svelte files to zero bytes while reporting success (28 components lost, 2026-08-07). Use `pnpm run prettier:write`.',
  },
  {
    pattern: /prettier[^;&|]*--write[^;&|]*\*\*/i,
    reason:
      "A repo-wide `prettier --write` rewrites ~1000 committed files (the repo is not prettier-2-clean) and reformats other people's uncommitted work in place. Use `pnpm run prettier:write`, which scopes to dirty files.",
  },
  {
    // The glob rule above misses the commoner spellings. `--write` must name FILES: the next token
    // has to carry an extension, so `--write .`, `--write src` and `--write src/` are refused while
    // `--write "src/a.ts" "src/b.ts"` passes. Explicit per-file writes are allowlisted in settings,
    // so these two patterns are the only thing between that grant and a ~1000-file commit.
    pattern: /prettier[^;&|]*--write\s+(?!["']?[^\s;&|"']*\.[a-z]{1,6}\b)/i,
    reason:
      'Name the files explicitly (`--write "src/a.ts"`), or use `pnpm run prettier:write`, which scopes to what git reports as dirty. A directory or bare `.` target reformats the whole repo.',
  },
];

// Expensive or historically destructive, but sometimes legitimate — confirm rather than block.
const GUARDED_PATTERNS = [
  {
    // `svelte-kit sync` alone is cheap (121 generated files) and is deliberately NOT guarded.
    // A full build writes ~1,800 files / 25MB and is not a check — it catches nothing `svelte-check`
    // does not, apart from Svelte's TS stripping leaving `?` on optional parameters, which
    // check-svelte-ts.mjs now catches on write instead.
    pattern: /(apps[\/\\](moderator|auth|creator-studio)[^;&|]*\bbuild\b|\bvite\s+build\b)/i,
    reason:
      'A SvelteKit build writes ~1,800 files into the workspace and is NOT a verification step — use `pnpm --filter ./apps/<app> run typecheck`. Confirm only if you are diagnosing a build-only failure or producing a real artifact.',
  },
  {
    pattern: /prettier[^;&|]*--write/i,
    reason:
      'Formatting outside `pnpm run prettier:write` can reach files this change does not own. Confirm the target is scoped.',
  },
];

let input = '';

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => { input += chunk; });
stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const rawCommand = data?.tool_input?.command || '';

    // Match against the command MINUS heredoc bodies and -m messages: a commit message or doc that
    // describes a blocked command is not an attempt to run it, and blocking those makes the incident
    // impossible to write down.
    const command = rawCommand
      .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?^\1$/gm, ' ')
      .replace(/-m\s+(['"])[\s\S]*?\1/g, ' ');

    // Check for dangerous commands that should be blocked outright (no confirmation possible)
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        console.error(`BLOCKED: ${reason}\nCommand: ${rawCommand}`);
        process.exit(2); // Exit code 2 blocks the command immediately
      }
    }

    for (const { pattern, reason } of GUARDED_PATTERNS) {
      if (pattern.test(command)) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: reason,
          }
        }));
        process.exit(0);
      }
    }

    // Check if this is a database query command with --writable flag
    // These should prompt for user confirmation
    const isWritable = command.includes('--writable');
    const isDbQuery = command.includes('postgres-query') || command.includes('clickhouse-query');

    if (isWritable && isDbQuery) {
      const dbType = command.includes('clickhouse') ? 'ClickHouse' : 'PostgreSQL (primary)';
      // Output JSON with "ask" decision to prompt user for confirmation
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `Database write access requested for ${dbType}. Please confirm you want to execute this command.`
        }
      }));
      process.exit(0);
    }

    // Allow the command
    process.exit(0);
  } catch (e) {
    // On parse error, allow the command to proceed (fail open)
    process.exit(0);
  }
});
