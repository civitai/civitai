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
// A segment RUNS prettier only if the invocation starts it — optionally behind a runner or leading
// env assignments. A segment that merely CONTAINS the word is quoting it: a `for cmd in '…'` list,
// an echo, a doc string. A hook reading text cannot tell those apart in general (which is why
// heredocs and `-m` messages are stripped above), but position gets the common cases right, and a
// mention that never runs must not be blocked — that is what made this guard annoying enough to
// route around, and a guard people route around protects nothing.
const PRETTIER_INVOCATION = /^\s*(?:\w+=\S*\s+)*(?:sudo\s+)?(?:(?:pnpm|yarn|bun)\s+(?:exec|dlx|run)\s+|npx\s+|\.\/node_modules\/\.bin\/)?prettier\b/;

export function prettierSegments(command) {
  return command.split(/[;&|\n]+/).filter((seg) => PRETTIER_INVOCATION.test(seg));
}

function prettierWriteTargets(command) {
  return prettierSegments(command)
    .filter((seg) => /--write/.test(seg))
    .flatMap((seg) =>
      seg
        .slice(seg.indexOf('--write') + '--write'.length)
        // Drop redirections and their operands (`2>&1`, `> out.log`) — they are not format targets.
        .replace(/\d*[<>]+&?\s*[^\s]*/g, ' ')
        .split(/\s+/)
        .map((t) => t.replace(/^['"]|['"]$/g, ''))
        // Not targets: flags, and redirections (`2>&1`, `> out.txt`) that survive the segment split.
        .filter((t) => t && !t.startsWith('-') && !/[<>]/.test(t))
        // Not judgeable: `$FILE`, `$(cat list.txt)`, backticks. The hook sees the command before
        // the shell expands it, so these are not paths it can measure — and scoring an unexpanded
        // token as a bare directory made `prettier --write "$FILE"` ask on a single named file.
        // Skipped rather than treated as unscoped; the outright block on a literal `*` / `**`
        // below is what still stops the breadth case this guard exists for.
        .filter((t) => !/[$`()]/.test(t))
    );
}

// The rule from CLAUDE.md is about BREADTH, not about prettier: a run may only reach files this
// change owns, because the repo is not Prettier-clean (789 of 4,116 `src` files) and a broad `--write`
// both buries the change and rewrites colleagues' uncommitted work in place. So a named file or a
// directory deep enough to belong to one feature runs; anything that could sweep an app or the repo
// asks first. `pnpm run prettier:write` (dirty files only) always runs.
const OWNED_DIR_DEPTH = 3; // e.g. src/components/Sticker — an app or a top-level dir is not owned

// Depth alone is not ownership: apps/moderator/src is three deep and is still a whole app. A
// directory named after the tree it holds, rather than after a feature, needs one more level.
const CONTAINER_DIRS = new Set([
  'src', 'app', 'apps', 'lib', 'libs', 'packages', 'components', 'pages', 'routes', 'server',
  'scripts', 'utils', 'hooks', 'store', 'stores', 'types', 'styles', 'public', 'tests', 'test',
]);

function isUnscoped(target) {
  const t = target.replace(/\\/g, '/').replace(/\/+$/, '');
  if (t === '' || t === '.' || t === '*' || t.startsWith('**')) return true;

  // Judge a glob by the fixed prefix it can never escape: src/**/*.tsx is still all of src.
  const dir = t.includes('*') ? t.slice(0, t.indexOf('*')).replace(/\/+$/, '') : t;
  const segments = dir.split('/').filter(Boolean);
  const leaf = segments[segments.length - 1] || '';

  // A named file is one file, at any depth.
  if (!t.includes('*') && /\.[a-z0-9]+$/i.test(leaf)) return false;

  const required = CONTAINER_DIRS.has(leaf.toLowerCase()) ? OWNED_DIR_DEPTH + 1 : OWNED_DIR_DEPTH;
  return segments.length < required;
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
    check: (command) => prettierSegments(command).some((seg) => /prettier-plugin-svelte/i.test(seg)),
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
