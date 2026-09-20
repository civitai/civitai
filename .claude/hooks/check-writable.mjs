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
import { readFileSync } from 'fs';

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

// A dev server that has stopped answering does not refuse connections — it accepts and never
// replies, so an unbounded request against it hangs until the 300s tool timeout and the agent
// learns nothing. Chaining several in one call multiplies that.
//
// This ASKS rather than blocks. A hard block was tried and is wrong: the matcher reads text, so it
// cannot reliably tell a request from a shell comment, a note being written down, or a production
// URL carrying a dev port in a query parameter — and `$(curl ...)` defeats it anyway. A guard with
// those false positives and no override is one people route around, and the routes around it are
// shorter than the compliant path. Asking keeps the nudge and costs a keystroke when it is wrong.
//
// The daemon's port comes from the dev-server skill rather than being baked in here. A hardcoded
// copy meant a second daemon was never guarded at all; replacing the default with the override
// then meant the FIRST one stopped being guarded. Both are live, so the set is additive.
//
// Defensive on purpose: a hook that throws breaks EVERY Bash call, so a missing skill directory
// or a malformed DEV_DAEMON_PORT must degrade, not propagate.
let devPortsRe = null;
export function daemonPortsGuarded(env = process.env) {
  const ports = new Set();
  try {
    // Synchronous require-equivalent is unavailable in ESM, so the port is read from the module
    // source. A regex over the declaration is deliberately duller than an import: it cannot
    // execute skill code inside a hook that runs before every command.
    //
    // Anchored on `export const`, loose only about spacing and digit separators. An earlier
    // version dropped the anchor to survive a reformat — which it never needed to, since a
    // reformat does not rewrite `export const NAME =` — and that let the FIRST match anywhere in
    // the file win, including one inside a comment.
    const source = readFileSync(
      new URL('../skills/dev-server/scripts/daemon-port.mjs', import.meta.url),
      'utf8'
    );
    const declared = /export\s+const\s+DEFAULT_DAEMON_PORT\s*=\s*([\d_]+)/.exec(source);
    if (declared) ports.add(declared[1].replace(/_/g, ''));
  } catch {
    /* skill absent — the 30xx/516x-517x ranges still guard the dev servers themselves */
  }

  // The override ADDS a port, it does not move one. `DEV_DAEMON_PORT` stands a second daemon
  // BESIDE the shared one (SKILL.md), so both are live and both need guarding. Replacing the
  // default here silently un-guarded the shared daemon for anyone who set the variable.
  const override = env.DEV_DAEMON_PORT?.trim();
  if (/^\d+$/.test(override ?? '') && Number(override) >= 1 && Number(override) <= 65535) {
    ports.add(String(Number(override)));
  }
  return [...ports];
}

// The laziness lives here, not in daemonPortsGuarded: building the pattern on first use rather
// than at import keeps this file free of top-level await. Per-process cache, and the process is
// per-command, so it cannot go stale within a run.
function devPorts() {
  if (devPortsRe) return devPortsRe;
  const daemon = daemonPortsGuarded().map((p) => `|${p}`).join('');
  devPortsRe = new RegExp(
    String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?):(?:30\d\d|51[67]\d${daemon})\b`,
    'i'
  );
  return devPortsRe;
}

// Any of curl's, wget's or PowerShell's own timeout flags, including `-m5` and bundled shorts.
// `-T` is wget's timeout but curl's --upload-file, and `-m` is curl's --max-time but wget's
// --mirror, so the ambiguous shorts are scoped to the tool that means "timeout" by them.
const BOUNDED_LONG = /--max-time|--connect-timeout|--timeout|-TimeoutSec/i;
const BOUNDED_CURL = /(?:^|\s)-[a-zA-Z]*m\s*\d/i;
const BOUNDED_WGET = /(?:^|\s)-T\s*\d/i;
const isBounded = (seg) =>
  BOUNDED_LONG.test(seg) ||
  (/(?:^|[;&|`]|\$\()\s*(?:\w+=\S*\s+)*(?:sudo\s+)?curl\b/i.test(seg) && BOUNDED_CURL.test(seg)) ||
  (/(?:^|[;&|`]|\$\()\s*(?:\w+=\S*\s+)*(?:sudo\s+)?wget\b/i.test(seg) && BOUNDED_WGET.test(seg));

// Command position only: start of a segment, after a pipe, or inside `$(`/backticks.
const REQUEST_TOOL =
  /(?:^|[;&|`]|\$\()\s*(?:\w+=\S*\s+)*(?:sudo\s+)?(?:curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)(?:\s|$)/i;

export function unboundedDevRequest(command) {
  return command
    .split(/[;&|\n]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && !seg.startsWith('#'))
    .filter((seg) => devPorts().test(seg.replace(/[?&][^\s"']*/g, '')))
    .filter((seg) => REQUEST_TOOL.test(seg))
    .filter((seg) => !isBounded(seg));
}

// The full unit suite belongs at the END of a task, once — not between edits.
//
// The numbers below are measured, and the "~75s" they replace was not: a day of the daemon's own
// queue history (50 full runs, 12 worktrees, 2026-09-17/18) puts the RUN at a median of 549s and
// the QUEUE WAIT in front of it at a median of 186s, mean 405s, worst 2247s. An agent budgeting a
// mid-iteration suite run against 75s is off by 7x on the run alone, which is precisely the
// miscalculation that fills the queue this hook exists to protect. Denied rather than asked, so the redirect reaches
// the agent at the moment of the mistake instead of interrupting the user. FULL_SUITE=1 is the
// deliberate opt-in for the single pre-commit run or an explicit user request.
const VITEST_INVOCATION =
  /^\s*(?:\w+=\S*\s+)*(?:(?:pnpm|yarn|bun)\s+(?:exec|run|dlx)\s+|npx\s+|\.?[\\/]?node_modules[\\/]\.bin[\\/])?vitest\b/;
const UNIT_RUN_SCRIPT =
  /^\s*(?:\w+=\S*\s+)*(?:pnpm|yarn|bun|npm)(?:\s+(?:run|-{1,2}[\w-]+(?:[= ]\S+)?))*\s+test:unit:run\b/;
const SCOPED_TARGET = /\.(?:test|spec)\.[cm]?[jt]sx?\b|__tests__/;

export function fullUnitSuiteRun(command) {
  if (/FULL_SUITE\s*=\s*1|\$env:FULL_SUITE/.test(command)) return false;
  return command.split(/[;&|\n]+/).some((seg) => {
    if (SCOPED_TARGET.test(seg)) return false;
    if (UNIT_RUN_SCRIPT.test(seg)) return true;
    if (!VITEST_INVOCATION.test(seg)) return false;
    const projects = [...seg.matchAll(/--project[=\s]+['"]?([^'"\s]+)/g)].map((m) => m[1]);
    return projects.length === 0 || projects.some((p) => p.includes('unit'));
  });
}

const FULL_SUITE_REASON =
  'Full unit suite blocked mid-iteration: it is ~25,000 tests, ~9 minutes to run, and serialised ' +
  "through the dev-server queue behind a typical 3-minute wait — blocking everyone else's runs. " +
  'Run only the test files covering your change: ' +
  "`pnpm exec vitest run --project 'unit*' <files>` — find them with " +
  '`grep -rln \'<symbol>\' src --include=*.test.ts`. The full suite runs ONCE, right before ' +
  'committing; for that single run (or when the user explicitly asked for a full run), prefix the ' +
  'command with FULL_SUITE=1.';

// A full-program `tsc` run directly, instead of through `pnpm run typecheck`. Two reasons, and the
// second would hold even if the first went away:
//   1. It skips the typecheck lane of the dev-server queue, so several agents doing it at once is
//      N single-core 8 GB heaps pegging the box — the condition the lane exists to prevent.
//   2. It is the WRONG CHECK. tsc at node's default heap can abort part-way with ZERO diagnostics
//      and a log that reads as clean; scripts/typecheck.mjs raises the heap and names that crash.
//      Measured: a file with 8 real errors reported "No errors found" under `npx tsc -p
//      tsconfig.json` and 8 errors under `pnpm run typecheck`.
// Narrow runs are left alone: a sub-project (`-p tsconfig.scripts.json`, which the scripts gate
// itself recommends), named files, `--build`, and informational flags. TYPECHECK_DIRECT=1 is the
// deliberate opt-out for diagnosing tsc itself.
// The runner may carry its own flags before `exec`: `pnpm -w exec tsc` and `pnpm --filter x exec
// tsc` are the two spellings a monorepo reaches for first, and both walked past the original
// pattern, which required `exec` IMMEDIATELY after the runner. `npm` and `bunx` were missing
// outright. Measured on the merged version: five spellings of a full root typecheck ran unguarded.
const TSC_INVOCATION = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+)*(?:` +
    String.raw`(?:(?:pnpm|yarn|bun|npm)(?:\s+-{1,2}[\w-]+(?:=\S+)?(?:\s+\S+)?)*\s+(?:exec|dlx)\s+(?:--\s+)?` +
    String.raw`|npx\s+(?:--\s+)?|bunx\s+|\.?[\\/]?node_modules[\\/]\.bin[\\/])?['"]?tsc['"]?(?=\s|$)` +
    String.raw`|node\s+(?:--\S+\s+)*\S*typescript[\\/]lib[\\/]tsc\.js\b)`
);
const TSC_ROOT_PROJECT = /^(?:\.[\\/]?|(?:\.[\\/])?tsconfig\.json)$/;
const TSC_NOT_A_CHECK = /(?:^|\s)(?:-v|--version|-h|--help|--init|--showConfig|--all|-b|--build)\b/;
// A run aimed at ONE workspace package is not the run this guard exists to stop: `pnpm run
// typecheck` cannot see `apps/` at all (only CI's scripts/ci/typecheck-apps.mjs does), so denying
// it and printing that remedy sends an agent to a command that cannot check its files.
const WORKSPACE_TARGET = /(?:^|[\s'"=\\/])(?:apps|packages)[\\/][\w.-]+/;
const RUNNER_DIR_FLAG = /(?:^|\s)(?:-C|--dir|--prefix|--filter|-F)(?:=|\s+)(\S+)/;

/**
 * The directory a segment runs in, as far as the command line says: the last `cd` before it, or a
 * runner's own directory flag. `cd apps/x && npx tsc --noEmit` splits into two segments and the
 * second carries no trace of the first, so the split cannot be per-segment alone.
 */
function segmentTarget(previousSegments, seg) {
  const flag = RUNNER_DIR_FLAG.exec(seg);
  if (flag) return flag[1];
  for (const prev of [...previousSegments].reverse()) {
    const cd = /^\s*cd\s+(?:\/d\s+)?(['"]?)(.+?)\1\s*$/.exec(prev);
    if (cd) return cd[2];
  }
  return null;
}

export function directRootTypecheck(command) {
  if (/TYPECHECK_DIRECT\s*=\s*1|\$env:TYPECHECK_DIRECT/.test(command)) return false;
  const segments = command.split(/[;&|\n]+/);
  return segments.some((seg, i) => {
    if (!TSC_INVOCATION.test(seg)) return false;
    if (TSC_NOT_A_CHECK.test(seg)) return false;
    const target = segmentTarget(segments.slice(0, i), seg);
    if (target && WORKSPACE_TARGET.test(target)) return false;
    const tokens = seg
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^['"]|['"]$/g, ''));
    // Named source files make tsc ignore tsconfig entirely: a narrow check of those files only.
    if (tokens.some((t) => !t.startsWith('-') && /\.(?:[cm]?tsx?|d\.ts)$/.test(t))) return false;
    const at = tokens.findIndex((t) => /^(?:-p|--project)(?:=|$)/.test(t));
    if (at === -1) return true;
    const inline = tokens[at]?.includes('=') ? tokens[at].split('=')[1] : tokens[at + 1];
    if (inline && WORKSPACE_TARGET.test(inline)) return false;
    if (TSC_ROOT_PROJECT.test(inline ?? '')) return true;
    // `-p ../another-worktree/tsconfig.json` is the same root program reached by another path.
    return /(?:^|[\\/])tsconfig\.json$/.test(inline ?? '');
  });
}

const DIRECT_TSC_REASON =
  'Direct full-program tsc blocked: use `pnpm run typecheck`. That script queues the run in the ' +
  "dev-server typecheck lane (several agents' 8 GB tsc heaps at once is what pegs the box), and it " +
  'is also the only form that cannot report a crashed run as clean — plain tsc at the default ' +
  'heap can abort with zero diagnostics. A sub-project (`-p tsconfig.scripts.json`), named files, ' +
  'and a run aimed at one workspace package (`cd apps/<name> && …`, `pnpm --filter <name> exec …`) ' +
  'still run directly — `pnpm run typecheck` does not cover `apps/`. To diagnose tsc itself, ' +
  'prefix the command with TYPECHECK_DIRECT=1.';

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
    check: (command) => unboundedDevRequest(command).length > 0,
    reason:
      'An unbounded request at a local dev port hangs for the full 300s tool timeout when the ' +
      'server is unhealthy, and tells you nothing about why. Prefer: node ' +
      '.claude/skills/dev-server/cli.mjs probe <route> — it bounds the request and reports WHY it ' +
      'was slow, with the matching remedy. Or add --max-time <seconds>.',
  },
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
    // Only the unscoped shapes ask. `prettier --write src/components/Sticker/` runs.
    check: (command) => {
      const targets = prettierWriteTargets(command);
      return targets.length === 0 ? false : targets.some(isUnscoped);
    },
    reason: 'Formatting outside `pnpm run prettier:write` can reach files this change does not own. Confirm the target is scoped.',
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
      // `^[ \t]*\1[ \t]*$`, not `^\1$`: the `<<-` form exists precisely to allow an indented
      // terminator, and a heredoc written inside an indented block has one too. Requiring column 0
      // leaked those bodies into the matcher, so writing the incident down got flagged.
      .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?^[ \t]*\1[ \t]*$/gm, ' ')
      .replace(/-m\s+(['"])[\s\S]*?\1/g, ' ');

    // Check for dangerous commands that should be blocked outright (no confirmation possible)
    for (const { pattern, check, reason } of DANGEROUS_PATTERNS) {
      if (check ? check(command) : pattern.test(command)) {
        console.error(`BLOCKED: ${reason}\nCommand: ${rawCommand}`);
        process.exit(2); // Exit code 2 blocks the command immediately
      }
    }

    if (fullUnitSuiteRun(command)) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: FULL_SUITE_REASON,
        }
      }));
      process.exit(0);
    }

    if (directRootTypecheck(command)) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: DIRECT_TSC_REASON,
        }
      }));
      process.exit(0);
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
