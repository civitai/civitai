#!/usr/bin/env node
/**
 * Ralph CLI - Command-line interface for Ralph Daemon
 *
 * A clean interface for agents and humans to interact with the Ralph Daemon.
 * Eliminates the need for complex curl commands and JSON parsing.
 *
 * Usage:
 *   ralph-cli <command> [options]
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
 *   ralph-cli create --prd path/to/prd.json --model opus --start
 *   ralph-cli status my-session-abc123
 *   ralph-cli pause my-session --reason "Waiting for dev server"
 *   ralph-cli resume my-session --guidance "Dev server is running on port 3000"
 *   ralph-cli spawn parent-session --prd child/prd.json --start --wait
 *   ralph-cli logs my-session --follow
 */

const DEFAULT_HOST = 'http://localhost:9333';

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
  const host = process.env.RALPH_DAEMON_URL || DEFAULT_HOST;
  const url = `${host}${path}`;

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, options);
    const data = await res.json();

    if (!res.ok && data.error) {
      throw new Error(data.error);
    }

    return data;
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Cannot connect to Ralph Daemon at ${host}. Is it running?`);
    }
    throw err;
  }
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
      const time = new Date(log.timestamp).toLocaleTimeString();
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
      cascade_aborted: `Aborted ${data.aborted?.length || 0} sessions: ${data.aborted?.join(', ')}`,
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
      throw new Error('PRD path required. Usage: ralph-cli create --prd <path>');
    }

    const data = await request('POST', '/api/sessions', {
      prd,
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
      throw new Error('Session ID required. Usage: ralph-cli status <session-id>');
    }

    const data = await request('GET', `/api/sessions/${sessionId}`);
    formatOutput(data, options);
    return data;
  },

  async start(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph-cli start <session-id>');
    }

    const data = await request('POST', `/api/sessions/${sessionId}/start`);
    formatOutput(data, options);
    return data;
  },

  async pause(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph-cli pause <session-id>');
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
      throw new Error('Session ID required. Usage: ralph-cli resume <session-id>');
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
      throw new Error('Session ID and message required. Usage: ralph-cli inject <session-id> --message "..."');
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
      throw new Error('Session ID required. Usage: ralph-cli abort <session-id>');
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
      throw new Error('Session ID required. Usage: ralph-cli destroy <session-id>');
    }

    const data = await request('DELETE', `/api/sessions/${sessionId}`);
    formatOutput(data, options);
    return data;
  },

  async logs(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph-cli logs <session-id>');
    }

    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit);

    const path = `/api/sessions/${sessionId}/logs${params.toString() ? '?' + params.toString() : ''}`;

    if (options.follow || options.f) {
      // Poll for new logs
      let lastTimestamp = null;
      const poll = async () => {
        const pollParams = new URLSearchParams();
        pollParams.set('limit', '50');
        if (lastTimestamp) pollParams.set('since', lastTimestamp);

        const data = await request('GET', `/api/sessions/${sessionId}/logs?${pollParams.toString()}`);
        if (data.logs && data.logs.length > 0) {
          for (const log of data.logs) {
            const time = new Date(log.timestamp).toLocaleTimeString();
            console.log(`[${time}] [${log.level}] ${log.message}`);
            lastTimestamp = log.timestamp;
          }
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
      throw new Error('Parent session ID and PRD path required. Usage: ralph-cli spawn <parent-id> --prd <path>');
    }

    const data = await request('POST', `/api/sessions/${parentId}/spawn`, {
      prd,
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
      throw new Error('Session ID required. Usage: ralph-cli children <session-id>');
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
      throw new Error('Session ID required. Usage: ralph-cli wait <session-id>');
    }

    console.log(`Waiting for children of ${sessionId} to complete...`);

    const data = await request('POST', `/api/sessions/${sessionId}/wait`, {
      timeout: options.timeout ? parseInt(options.timeout, 10) * 1000 : 0,
      pollInterval: options.interval ? parseInt(options.interval, 10) * 1000 : 2000,
    });
    formatOutput(data, options);
    return data;
  },

  async tree(options, positional) {
    const sessionId = options.session || positional[0];
    if (!sessionId) {
      throw new Error('Session ID required. Usage: ralph-cli tree <session-id>');
    }

    const data = await request('GET', `/api/sessions/${sessionId}/tree`);
    formatOutput(data, options);
    return data;
  },

  async help() {
    console.log(`
Ralph CLI - Command-line interface for Ralph Daemon

Usage:
  ralph-cli <command> [options]

Session Commands:
  create                 Create a new session
    --prd <path>           PRD file path (required)
    --name <name>          Session name
    --model <model>        Model: opus, sonnet, haiku (default: sonnet)
    --max-turns <n>        Max turns per iteration (default: 100)
    --start                Auto-start after creation

  list                   List all sessions
    --status <status>      Filter by status (RUNNING,PAUSED,etc)
    --active               Show only active sessions

  status <session-id>    Get session status
  start <session-id>     Start a session

  pause <session-id>     Pause a session
    --reason <reason>      Reason for pausing

  resume <session-id>    Resume a session
    --guidance <text>      Guidance to inject on resume
    --force                Force resume even without lock token

  inject <session-id>    Inject guidance
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

  tree <session-id>      Show session tree

Global Options:
  --json                 Output raw JSON
  --help                 Show this help

Environment:
  RALPH_DAEMON_URL       Daemon URL (default: http://localhost:9333)

Examples:
  # Create and start a session
  ralph-cli create --prd .claude/skills/ralph/projects/my-feature/prd.json --start

  # Pause a session
  ralph-cli pause my-session-abc123 --reason "Waiting for build"

  # Resume with guidance
  ralph-cli resume my-session-abc123 --guidance "Build completed successfully"

  # Orchestration: spawn child and wait
  ralph-cli spawn orchestrator-123 --prd child/prd.json --start --wait

  # Watch session tree
  ralph-cli tree orchestrator-123
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
    console.error('Run "ralph-cli help" for usage information.');
    process.exit(1);
  }

  try {
    await commands[command](options, positional);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
