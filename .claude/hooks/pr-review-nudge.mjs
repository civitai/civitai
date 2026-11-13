#!/usr/bin/env node
/**
 * PostToolUse hook for Bash and the GitHub MCP PR tools: after a call that opened or readied a
 * civitai/civitai PR whose head is in this repo, adds context pointing the session at the
 * `pr-review` skill. Never blocks: any failure exits 0 silent.
 *
 * Wiring only; every decision lives in pr-review-nudge.logic.mjs, which is what tests import.
 * No "am I the main module" check, for the reason check-writable.mjs gives.
 */

import { stdin } from 'process';

import { hookEvent, nudge } from './pr-review-nudge.logic.mjs';

let input = '';

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  input += chunk;
});
stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const event = hookEvent(data);
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
