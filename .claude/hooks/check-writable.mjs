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

// `prettier --write <targets>`: the incident was a repo-WIDE rewrite, not formatting a directory
// this change owns. Read the targets instead of matching `--write`, so a scoped path just runs.
function prettierWriteTargets(command) {
  return command
    .split(/[;&|]+/)
    .filter((seg) => /\bprettier\b/.test(seg) && /--write/.test(seg))
    .flatMap((seg) =>
      seg
        .slice(seg.indexOf('--write') + '--write'.length)
        .split(/\s+/)
        .map((t) => t.replace(/^['"]|['"]$/g, ''))
        .filter((t) => t && !t.startsWith('-'))
    );
}

// Reaches the whole repo: the root, a bare glob, or a glob rooted at a top-level dir.
function isUnscoped(target) {
  const t = target.replace(/\\/g, '/').replace(/\/+$/, '');
  if (t === '' || t === '.' || t === '*' || t.startsWith('**')) return true;
  if (!t.includes('*')) return false;
  const fixed = t.split('*')[0].replace(/\/+$/, '');
  return fixed.split('/').filter(Boolean).length < 2;
}

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
    check: (command) => prettierWriteTargets(command).some((t) => t === '*' || t.replace(/\\/g, '/').startsWith('**')),
    reason:
      'A repo-wide `prettier --write` rewrites ~1000 committed files (the repo is not prettier-2-clean) and reformats other people\'s uncommitted work in place. Use `pnpm run prettier:write`, which scopes to dirty files.',
  },
];

// Expensive or historically destructive, but sometimes legitimate — confirm rather than block.
const GUARDED_PATTERNS = [
  {
    pattern: /svelte-kit\s+sync|pnpm\s+(run\s+)?check\b/i,
    reason:
      '`svelte-kit sync` regenerates ~690 files under .svelte-kit/, which the Vite dev server watches — the collision that froze this window repeatedly. Use `pnpm run typecheck` unless the route tree changed.',
  },
  {
    // Only the unscoped shapes ask. `prettier --write src/components/Sticker/` runs.
    check: (command) => {
      const targets = prettierWriteTargets(command);
      return targets.length === 0 ? false : targets.some(isUnscoped);
    },
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
    for (const { pattern, check, reason } of DANGEROUS_PATTERNS) {
      if (check ? check(command) : pattern.test(command)) {
        console.error(`BLOCKED: ${reason}\nCommand: ${rawCommand}`);
        process.exit(2); // Exit code 2 blocks the command immediately
      }
    }

    for (const { pattern, check, reason } of GUARDED_PATTERNS) {
      if (check ? check(command) : pattern.test(command)) {
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
