#!/usr/bin/env node
/**
 * Ralph - Autonomous Agent Management
 *
 * CLI for creating, running, and monitoring Ralph autonomous agent sessions.
 * The daemon starts automatically if not running.
 *
 * Usage:
 *   ralph.mjs <command> [options]
 *
 * Commands:
 *   create      Create a new session
 *   list        List all sessions
 *   status      Get session status
 *   start       Start a session
 *   pause       Pause a session
 *   resume      Resume a session
 *   inject      Inject guidance into a session
 *   abort       Abort a session
 *   destroy     Destroy (delete) a session
 *   logs        Get session logs
 *   spawn       Spawn a child session (orchestration)
 *   children    List children of a session
 *   wait        Wait for children to complete
 *   tree        Show session tree
 *
 * Examples:
 *   ralph.mjs create --prd path/to/prd.json --start
 *   ralph.mjs status my-session-abc123
 *   ralph.mjs logs my-session --follow
 *   ralph.mjs inject my-session --message "Try a different approach"
 */

import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_SERVER = resolve(__dirname, 'daemon', 'server.mjs');
const DAEMON_PID_FILE = resolve(__dirname, 'daemon', 'daemon.pid');
const DEFAULT_HOST = 'http://localhost:9333';
const DAEMON_URL = process.env.RALPH_DAEMON_URL || DEFAULT_HOST;

// Check if daemon is responding
async function isDaemonRunning() {
  try {
    const res = await fetch(`${DAEMON_URL}/api/sessions`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Start daemon in background
async function startDaemon() {
  console.log('Starting Ralph daemon...');

  const child = spawn('node', [DAEMON_SERVER], {
    detached: true,
    stdio: 'ignore',
    cwd: __dirname,
  });

  child.unref();

  // Write PID file
  writeFileSync(DAEMON_PID_FILE, String(child.pid));

  // Wait for daemon to be ready
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isDaemonRunning()) {
      console.log('Ralph daemon started successfully.\n');
      return true;
    }
  }

  throw new Error('Failed to start daemon - timeout waiting for server');
}

// Ensure daemon is running before any command
async function ensureDaemon() {
  if (await isDaemonRunning()) {
    return;
  }
  await startDaemon();
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const options = {};
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      // Handle boolean flags
      if (!nextArg || nextArg.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = nextArg;
        i++;
      }
    } else if (arg.startsWith('-')) {
      // Short flags
      const key = arg.slice(1);
      const nextArg = args[i + 1];

      if (!nextArg || nextArg.startsWith('-')) {
        options[key] = true;
      } else {
        options[key] = nextArg;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, options, positional };
}

// Make HTTP request to daemon
async function request(method, path, body = null) {
  const url = `${DAEMON_URL}${path}`;

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok && data.error) {
    throw new Error(data.error);
  }

  return data;
}

// Format output for display
function formatOutput(data, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Custom formatting based on data type
  if (data.type === 'sessions') {
    if (data.sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }
    console.log(`Sessions (${data.sessions.length}):\n`);
    for (const s of data.sessions) {
      const progress = `${s.storiesCompleted || 0}/${s.storiesTotal || 0}`;
      const parent = s.parentId ? ` (child of ${s.parentId})` : '';
      const children = s.childIds?.length ? ` [${s.childIds.length} children]` : '';
      console.log(`  ${s.status.padEnd(10)} ${s.id}${parent}${children}`);
      console.log(`             ${s.name || 'Unnamed'} - ${progress} stories, turn ${s.turnCount || 0}/${s.maxTurns || 100}`);
    }
    return;
  }

  if (data.type === 'session_status') {
    console.log(`Session: ${data.id}`);
    console.log(`  Status:   ${data.status}`);
    console.log(`  Health:   ${data.health}`);
    if (data.currentStory) {
      console.log(`  Story:    ${data.currentStory.id} - ${data.currentStory.title}`);
    }
    console.log(`  Progress: ${data.progress.storiesCompleted}/${data.progress.storiesTotal} stories`);
    console.log(`  Turns:    ${data.progress.turnCount}/${data.progress.maxTurns}`);
    if (data.lock) {
      console.log(`  Locked:   By ${data.lock.holder} (${data.lock.reason || 'no reason'})`);
    }
    return;
  }

  if (data.type === 'session_tree') {
    const printTree = (node, indent = '') => {
      const status = node.status.padEnd(10);
      const progress = `${node.storiesCompleted || 0}/${node.storiesTotal || 0}`;
      console.log(`${indent}${status} ${node.id} (${progress} stories)`);
      for (const child of node.children || []) {
        printTree(child, indent + '  ');
      }
    };
    console.log('Session Tree:\n');
    printTree(data.tree);
    return;
  }

  if (data.type === 'logs') {
    if (!data.logs || data.logs.length === 0) {
      console.log('No logs found.');
      return;
    }
    for (const log of data.logs) {
      const time = new Date(log.createdAt).toLocaleTimeString();
      console.log(`[${time}] [${log.level}] ${log.message}`);
    }
    return;
  }

  if (data.type === 'children') {
    if (!data.children || data.children.length === 0) {
      console.log('No children found.');
      return;
    }
    console.log(`Children of ${data.sessionId}:\n`);
    for (const c of data.children) {
      const progress = `${c.storiesCompleted || 0}/${c.storiesTotal || 0}`;
      console.log(`  ${c.status.padEnd(10)} ${c.id} - ${progress} stories`);
    }
    return;
  }

  if (data.type === 'wait_result') {
    if (data.completed) {
      console.log('All children completed:');
      for (const c of data.children) {
        console.log(`  ${c.status.padEnd(10)} ${c.id} - ${c.storiesCompleted}/${c.storiesTotal} stories`);
      }
    } else if (data.timedOut) {
      console.log('Timed out. Pending children:');
      for (const c of data.pendingChildren) {
        console.log(`  ${c.status.padEnd(10)} ${c.id}`);
      }
    }
    return;
  }

  // Default: print success message
  if (data.type) {
    const messages = {
      session_created: `Session created: ${data.session?.id}`,
      session_started: `Session ${data.sessionId} started`,
      session_aborted: `Session ${data.sessionId} aborted`,
      session_destroyed: `Session ${data.sessionId} destroyed`,
      pause_requested: `Pause requested for ${data.sessionId}${data.lockToken ? ` (lock: ${data.lockToken})` : ''}`,
      resume_requested: `Resume requested for ${data.sessionId}`,
      guidance_injected: `Guidance injected into ${data.sessionId}`,
      child_spawned: `Child session spawned: ${data.child?.id}`,
      cascade_aborted: `Aborted ${Array.isArray(data.aborted) ? data.aborted.length : 0} sessions: ${Array.isArray(data.aborted) ? data.aborted.join(', ') : 'none'}`,
    };
    console.log(messages[data.type] || `Success: ${data.type}`);
    return;
  }

  // Fallback to JSON
  console.log(JSON.stringify(data, null, 2));
}

// Commands
const commands = {
  async create(options, positional) {
    const prd = options.prd || positional[0];
    if (!prd) {
      throw new Error('PRD path required. Usage: ralph.mjs create --prd <path>');
    }

    const data = await request('POST', '/api/sessions', {
      prd: resolve(prd),
      name: options.name,
      model: options.model || options.m,
      maxTurns: options['max-turns'] ? parseInt(options['max-turns'], 10) : undefined,
      workingDirectory: options.cwd,
      autoStart: options.start || false,
    });

    formatOutput(data, options);
    return data;
  },

  async list(options) {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.active) params.set('active', 'true');

    const path = `/api/sessions${params.toString() ? '?' + params.toString() : ''}`;
    const data = await request('GET', path);
    formatOutput(data, options);
    return data;
  },

  async status(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs status <session-id>');
    }

    const data = await request('GET', `/api/sessions/${sessionId}`);
    formatOutput(data, options);
    return data;
  },

  async start(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs start <session-id>');
    }

    const data = await request('POST', `/api/sessions/${sessionId}/start`);
    formatOutput(data, options);
    return data;
  },

  async pause(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs pause <session-id>');
    }

    const data = await request('POST', `/api/sessions/${sessionId}/pause`, {
      source: options.source || 'cli',
      reason: options.reason,
    });
    formatOutput(data, options);
    return data;
  },

  async resume(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs resume <session-id>');
    }

    const data = await request('POST', `/api/sessions/${sessionId}/resume`, {
      source: options.source || 'cli',
      guidance: options.guidance || options.g,
      guidanceType: options.type,
      lockToken: options.token,
      force: options.force || false,
    });
    formatOutput(data, options);
    return data;
  },

  async inject(options, positional) {
    const sessionId = options.session || positional[0];
    const content = options.message || options.m || positional[1];

    if (!sessionId || !content) {
      throw new Error('Session ID and message required. Usage: ralph.mjs inject <session-id> --message "..."');
    }

    const data = await request('POST', `/api/sessions/${sessionId}/inject`, {
      content,
      type: options.type || 'HINT',
      source: options.source || 'cli',
    });
    formatOutput(data, options);
    return data;
  },

  async abort(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs abort <session-id>');
    }

    const endpoint = options.cascade
      ? `/api/sessions/${sessionId}/abort-cascade`
      : `/api/sessions/${sessionId}/abort`;

    const data = await request('POST', endpoint, {
      source: options.source || 'cli',
    });
    formatOutput(data, options);
    return data;
  },

  async destroy(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs destroy <session-id>');
    }

    const data = await request('DELETE', `/api/sessions/${sessionId}`);
    formatOutput(data, options);
    return data;
  },

  async logs(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs logs <session-id>');
    }

    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit);

    const path = `/api/sessions/${sessionId}/logs${params.toString() ? '?' + params.toString() : ''}`;

    if (options.follow || options.f) {
      // Poll for new logs
      let lastId = 0;
      const poll = async () => {
        try {
          const pollParams = new URLSearchParams();
          pollParams.set('limit', '50');
          pollParams.set('offset', String(lastId));

          const data = await request('GET', `/api/sessions/${sessionId}/logs?${pollParams.toString()}`);
          if (data.logs && data.logs.length > 0) {
            for (const log of data.logs) {
              const time = new Date(log.createdAt).toLocaleTimeString();
              console.log(`[${time}] [${log.level}] ${log.message}`);
              if (log.id > lastId) lastId = log.id;
            }
          }
        } catch (err) {
          // Session might have ended
          console.log(`\nSession ended or error: ${err.message}`);
          process.exit(0);
        }
      };

      console.log(`Following logs for ${sessionId}... (Ctrl+C to stop)\n`);
      await poll();
      setInterval(poll, 2000);
      return; // Don't exit
    }

    const data = await request('GET', path);
    formatOutput(data, options);
    return data;
  },

  // Orchestration commands
  async spawn(options, positional) {
    const parentId = options.parent || positional[0];
    const prd = options.prd || positional[1];

    if (!parentId || !prd) {
      throw new Error('Parent session ID and PRD path required. Usage: ralph.mjs spawn <parent-id> --prd <path>');
    }

    const data = await request('POST', `/api/sessions/${parentId}/spawn`, {
      prd: resolve(prd),
      name: options.name,
      model: options.model || options.m,
      maxTurns: options['max-turns'] ? parseInt(options['max-turns'], 10) : undefined,
      autoStart: options.start || false,
    });
    formatOutput(data, options);

    // Optionally wait for completion
    if (options.wait) {
      console.log(`\nWaiting for child ${data.child.id} to complete...`);
      const childId = data.child.id;

      const pollStatus = async () => {
        while (true) {
          const status = await request('GET', `/api/sessions/${childId}`);
          if (['COMPLETED', 'ABORTED'].includes(status.status)) {
            console.log(`\nChild ${childId} ${status.status.toLowerCase()}`);
            return status;
          }
          await new Promise(r => setTimeout(r, 5000));
          process.stdout.write('.');
        }
      };

      await pollStatus();
    }

    return data;
  },

  async children(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs children <session-id>');
    }

    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);

    const path = `/api/sessions/${sessionId}/children${params.toString() ? '?' + params.toString() : ''}`;
    const data = await request('GET', path);
    formatOutput(data, options);
    return data;
  },

  async wait(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs wait <session-id>');
    }

    console.log(`Waiting for children of ${sessionId} to complete...`);

    const data = await request('POST', `/api/sessions/${sessionId}/wait`, {
      timeout: options.timeout ? parseInt(options.timeout, 10) * 1000 : 0,
      pollInterval: options.interval ? parseInt(options.interval, 10) * 1000 : 2000,
    });
    formatOutput(data, options);
    return data;
  },

  // Watch a session for significant state changes (blocked, completed, story done, etc.)
  async watch(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs watch <session-id>');
    }

    console.log(`Watching ${sessionId} for state changes...`);

    const data = await request('POST', `/api/sessions/${sessionId}/wait-state`, {
      timeout: options.timeout ? parseInt(options.timeout, 10) * 1000 : 0,
      pollInterval: options.interval ? parseInt(options.interval, 10) * 1000 : 2000,
    });

    // Pretty print the result
    if (data.changed) {
      console.log(`\nState change detected: ${data.reason}`);
      if (data.reason === 'status_change') {
        console.log(`  Status: ${data.previousStatus} -> ${data.currentStatus}`);
      } else if (data.reason === 'story_completed') {
        console.log(`  Stories: ${data.storiesCompleted}/${data.storiesTotal} completed`);
      }
    } else {
      console.log(`\nNo state change (${data.reason})`);
    }

    formatOutput(data, options);
    return data;
  },

  async tree(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph.mjs tree <session-id>');
    }

    const data = await request('GET', `/api/sessions/${sessionId}/tree`);
    formatOutput(data, options);
    return data;
  },

  async help() {
    console.log(`
Ralph - Autonomous Agent Management

Usage:
  ralph.mjs <command> [options]

Session Commands:
  create                 Create a new session
    --prd <path>           PRD file path (required)
    --name <name>          Session name
    --model <model>        Model: opus, sonnet, haiku (default: sonnet)
    --max-turns <n>        Max turns per iteration (default: 100)
    --start                Auto-start after creation

  list                   List all sessions
    --status <status>      Filter by status (RUNNING, PAUSED, COMPLETED, ABORTED)
    --active               Show only active sessions

  status <session-id>    Get session status
  start <session-id>     Start a session

  pause <session-id>     Pause a session
    --reason <reason>      Reason for pausing

  resume <session-id>    Resume a session
    --guidance <text>      Guidance to inject on resume
    --force                Force resume even without lock token

  inject <session-id>    Inject guidance into a running session
    --message <text>       Guidance message (required)
    --type <type>          Type: CORRECTION, HINT, ENVIRONMENT_UPDATE

  abort <session-id>     Abort a session
    --cascade              Also abort all children

  destroy <session-id>   Delete a session permanently

  logs <session-id>      Get session logs
    --follow, -f           Follow logs in real-time
    --limit <n>            Number of logs to fetch

Orchestration Commands:
  spawn <parent-id>      Spawn a child session
    --prd <path>           Child PRD path (required)
    --start                Auto-start child
    --wait                 Wait for child to complete

  children <session-id>  List children of a session
  wait <session-id>      Wait for all children to complete
    --timeout <seconds>    Max wait time (0 = forever)

  watch <session-id>     Watch for state changes (blocked, story done, completed)
    --timeout <seconds>    Max wait time (0 = forever)

  tree <session-id>      Show session tree (parent + all descendants)

Global Options:
  --json                 Output raw JSON
  --help                 Show this help

The daemon starts automatically if not already running.

Examples:
  # Create and start a session
  ralph.mjs create --prd .claude/skills/ralph/projects/my-feature/prd.json --start

  # Monitor a session
  ralph.mjs logs my-session-abc123 --follow

  # Inject guidance into a running session
  ralph.mjs inject my-session-abc123 --message "Try using the existing helper function"

  # Spawn a child and wait for it
  ralph.mjs spawn parent-123 --prd child/prd.json --start --wait

  # View session hierarchy
  ralph.mjs tree orchestrator-123
`);
  },
};

// Main
async function main() {
  const { command, options, positional } = parseArgs();

  if (!command || command === 'help' || options.help) {
    await commands.help();
    process.exit(0);
  }

  if (!commands[command]) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "ralph.mjs help" for usage information.');
    process.exit(1);
  }

  try {
    // Ensure daemon is running before any command
    await ensureDaemon();
    await commands[command](options, positional);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
