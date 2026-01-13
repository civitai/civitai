#!/usr/bin/env node
/**
 * Hook to require user approval for --writable database commands.
 * This ensures write access to databases always requires explicit user consent,
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

    // Check if this is a database query command with --writable flag
    const isWritable = command.includes('--writable');
    const isDbQuery = command.includes('postgres-query') || command.includes('clickhouse-query');

    if (isWritable && isDbQuery) {
      const dbType = command.includes('clickhouse') ? 'ClickHouse' : 'PostgreSQL (primary)';
      console.log(JSON.stringify({
        decision: 'ask',
        reason: `Database write access requested. Please confirm you want to run this command against ${dbType}.`
      }));
    }
  } catch (e) {
    // On error, allow the command to proceed (fail open)
  }
});
