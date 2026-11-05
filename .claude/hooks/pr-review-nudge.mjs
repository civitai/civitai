#!/usr/bin/env node
/**
 * PostToolUse hook for Bash: after a call that opened or readied a civitai/civitai PR, adds
 * context pointing the session at the `pr-review` skill. Never blocks: any failure exits 0 silent.
 *
 * Wiring only; every decision lives in pr-review-nudge.logic.mjs, which is what tests import.
 * No "am I the main module" check, for the reason check-writable.mjs gives.
 */

import { stdin } from 'process';

import { nudge, prEvent } from './pr-review-nudge.logic.mjs';

let input = '';

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  input += chunk;
});
stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const event = prEvent(data?.tool_input?.command || '', data?.tool_response);
    if (event) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge(event) },
        })
      );
    }
  } catch {
    // A nudge that cannot run must never get in the way of the command it follows.
  }
  process.exit(0);
});
