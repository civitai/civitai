#!/usr/bin/env node
/**
 * Hook to require user approval for --writable database commands.
 * This ensures write access to the database always requires explicit user consent,
 * even when running in bypass permissions mode.
 */

import { stdin } from 'process';

let input = '';

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => { input += chunk; });
stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const command = data?.tool_input?.command || '';

    // Check if this is a postgres-query command with --writable flag
    if (command.includes('--writable') && command.includes('postgres-query')) {
      console.log(JSON.stringify({
        decision: 'ask',
        reason: 'Database write access requested. Please confirm you want to run this command against the primary (writable) database.'
      }));
    }
  } catch (e) {
    // On error, allow the command to proceed (fail open)
  }
});
