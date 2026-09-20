#!/usr/bin/env node
/**
 * PreToolUse hook for Bash commands: reads the tool call on stdin and answers on stdout.
 *
 * Wiring only — every decision lives in check-writable.logic.mjs, which is what tests import.
 * There is deliberately NO "am I the main module" check here: the one that was tried compared
 * `resolve(process.argv[1])` against the realpath in `import.meta.url`, so a symlink or a
 * directory junction anywhere in the path made the hook attach nothing, exit 0, and allow every
 * command — with no error to read. A file that is only ever executed cannot get that wrong.
 */

import { stdin } from 'process';

import {
  DANGEROUS_PATTERNS,
  DIRECT_TSC_REASON,
  FULL_SUITE_REASON,
  GUARDED_PATTERNS,
  directRootTypecheck,
  fullUnitSuiteRun,
} from './check-writable.logic.mjs';

let input = '';

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  input += chunk;
});
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
    //
    // 🔴 Do NOT add `-e`/`--eval` to that list. It was tried, to stop a `node -e` probe whose
    // STRINGS named blocked commands from being denied, and it disabled every guard in this file:
    // the strip runs in front of all of them, so `node -e "require('child_process').execSync(
    // 'taskkill /F /IM node.exe')"` was ALLOWED while the bare command blocks — measured, by
    // spawning this hook. A heredoc body and a `-m` message are inert text; an `-e` body is the
    // code that runs, and it is the one place where hiding the text hides the act. If a probe of
    // your own trips a guard, put the script in a file.

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
