#!/usr/bin/env node
/**
 * Dev Server Console for Humans
 * Human-friendly wrapper that starts a dev server and tails logs.
 * The server continues running after you disconnect (Ctrl+C).
 */

import { spawn, execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Find the project root (where package.json is)
function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

const projectRoot = findProjectRoot(__dirname);
const pidFile = resolve(__dirname, 'daemon.pid');
const serverScript = resolve(__dirname, 'scripts/daemon.mjs');

const DAEMON_PORT = 9444;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

// ANSI colors
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
};

function log(msg) {
  console.log(msg);
}

async function daemonRequest(path, options = {}) {
  const url = `${DAEMON_URL}${path}`;
  try {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

function isDaemonRunning() {
  return new Promise(async (resolve) => {
    const result = await daemonRequest('/');
    resolve(result.ok);
  });
}

async function startDaemon() {
  const spawnOptions = {
    detached: true,
    stdio: 'ignore',
    cwd: projectRoot,
    windowsHide: true,
    shell: true,
  };

  // Use quoted command string for shell: true on Windows
  const command = `"${process.execPath}" "${serverScript}"`;
  const child = spawn(command, [], spawnOptions);
  child.unref();

  writeFileSync(pidFile, String(child.pid));

  // Wait for daemon to be ready
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await isDaemonRunning()) {
      return true;
    }
  }
  return false;
}

async function ensureDaemon() {
  if (await isDaemonRunning()) {
    return true;
  }
  log(`${c.dim}Starting daemon...${c.reset}`);
  const started = await startDaemon();
  if (!started) {
    log(`${c.red}Failed to start daemon${c.reset}`);
    process.exit(1);
  }
  return true;
}

async function listSessions() {
  await ensureDaemon();
  const result = await daemonRequest('/sessions');
  if (!result.ok) {
    log(`${c.red}Error: ${result.error || result.data?.error}${c.reset}`);
    process.exit(1);
  }

  const sessions = result.data.sessions;
  if (!sessions.length) {
    log(`${c.dim}No running sessions${c.reset}`);
    return null;
  }

  log(`\n${c.bold}Running Sessions:${c.reset}\n`);
  sessions.forEach((s, i) => {
    const status = s.status === 'running'
      ? `${c.green}running${c.reset}`
      : `${c.yellow}${s.status}${c.reset}`;
    const ready = s.ready ? `${c.green}ready${c.reset}` : `${c.yellow}starting${c.reset}`;
    log(`  ${c.cyan}${i + 1}.${c.reset} [${s.id}] ${s.branch}`);
    log(`     ${c.dim}Port:${c.reset} ${s.port}  ${c.dim}Status:${c.reset} ${status}  ${c.dim}Ready:${c.reset} ${ready}`);
    log(`     ${c.dim}URL:${c.reset} ${s.url}`);
    log('');
  });

  return sessions;
}

async function selectSession(sessions) {
  if (sessions.length === 1) {
    return sessions[0];
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${c.cyan}Select session (1-${sessions.length}): ${c.reset}`, (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < sessions.length) {
        resolve(sessions[idx]);
      } else {
        log(`${c.red}Invalid selection${c.reset}`);
        process.exit(1);
      }
    });
  });
}

async function stopSession(sessionId) {
  await ensureDaemon();

  // If no session ID, list and select
  if (!sessionId) {
    const sessions = await listSessions();
    if (!sessions || !sessions.length) {
      return;
    }
    const session = await selectSession(sessions);
    sessionId = session.id;
  }

  const result = await daemonRequest(`/sessions/${sessionId}`, { method: 'DELETE' });
  if (!result.ok) {
    log(`${c.red}Error: ${result.error || result.data?.error}${c.reset}`);
    process.exit(1);
  }
  log(`${c.green}Session ${sessionId} stopped${c.reset}`);
}

async function tailLogs(sessionId) {
  await ensureDaemon();

  let lastIndex = -1;

  const poll = async () => {
    const result = await daemonRequest(`/sessions/${sessionId}/logs?since=${lastIndex}`);
    if (!result.ok) {
      if (result.status === 404) {
        log(`${c.red}Session not found${c.reset}`);
        process.exit(1);
      }
      return;
    }
    for (const entry of result.data.logs) {
      const level = entry.level;
      let prefix = '';
      if (level === 'stderr') prefix = c.red;
      else if (level === 'error') prefix = c.red;
      else if (level === 'warn') prefix = c.yellow;
      else if (level === 'info') prefix = c.cyan;

      log(`${prefix}${entry.message}${c.reset}`);
      lastIndex = entry.index;
    }
  };

  await poll();
  const interval = setInterval(poll, 500);

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    clearInterval(interval);
    log(`\n${c.dim}Disconnected from session ${sessionId}. Dev server still running.${c.reset}`);
    log(`${c.dim}Reconnect:  npm run dev:daemon -- ${sessionId}${c.reset}`);
    log(`${c.dim}Stop:       npm run dev:daemon -- --stop ${sessionId}${c.reset}`);
    process.exit(0);
  });
}

async function startAndTail(worktree) {
  await ensureDaemon();

  const cwd = worktree ? resolve(worktree) : projectRoot;
  log(`${c.dim}Starting dev server in ${cwd}...${c.reset}`);

  const result = await daemonRequest('/sessions', {
    method: 'POST',
    body: JSON.stringify({ worktree: cwd }),
  });

  if (!result.ok) {
    log(`${c.red}Error: ${result.error || result.data?.error}${c.reset}`);
    process.exit(1);
  }

  const session = result.data.session;
  if (result.data.existing) {
    log(`${c.yellow}Already running:${c.reset} ${session.url}`);
  } else {
    log(`${c.green}Started:${c.reset} ${session.url}`);
  }
  log(`${c.dim}Session ID: ${session.id}${c.reset}`);
  log('');

  await tailLogs(session.id);
}

async function connectToSession(sessionId) {
  await ensureDaemon();

  // Verify session exists
  const result = await daemonRequest(`/sessions/${sessionId}`);
  if (!result.ok) {
    log(`${c.red}Session not found: ${sessionId}${c.reset}`);
    process.exit(1);
  }

  const session = result.data.session;
  log(`${c.cyan}Connected to:${c.reset} ${session.url}`);
  log(`${c.dim}Branch: ${session.branch}${c.reset}`);
  log('');

  await tailLogs(sessionId);
}

// Parse arguments
const args = process.argv.slice(2);

if (args.includes('--kill') || args.includes('-k')) {
  // Shutdown the daemon entirely
  (async () => {
    const result = await daemonRequest('/shutdown', { method: 'POST' });
    if (result.ok) {
      log(`${c.green}Daemon shutdown${c.reset}`);
    } else if (result.status === 0) {
      log(`${c.dim}Daemon not running${c.reset}`);
    } else {
      log(`${c.red}Error: ${result.error || result.data?.error}${c.reset}`);
    }
  })();
} else if (args.includes('--list') || args.includes('-l')) {
  listSessions().then(() => process.exit(0));
} else if (args.includes('--stop') || args.includes('-s')) {
  const stopIdx = args.findIndex(a => a === '--stop' || a === '-s');
  const sessionId = args[stopIdx + 1];
  stopSession(sessionId);
} else if (args.includes('--help') || args.includes('-h')) {
  log(`
${c.bold}Dev Server Console${c.reset}

Usage:
  npm run dev:daemon                    Start dev server and tail logs
  npm run dev:daemon -- <session-id>    Connect to existing session
  npm run dev:daemon -- --list          List running sessions
  npm run dev:daemon -- --stop [id]     Stop a session (interactive if no ID)
  npm run dev:daemon -- --kill          Shutdown the daemon entirely

When you Ctrl+C, the dev server keeps running. Use --stop to actually stop it.
`);
} else if (args[0] && !args[0].startsWith('-')) {
  // Argument provided - check if it's a session ID or path
  const arg = args[0];
  if (arg.length === 8 && /^[a-z0-9]+$/.test(arg)) {
    // Looks like a session ID
    connectToSession(arg);
  } else if (existsSync(arg)) {
    // Looks like a path
    startAndTail(arg);
  } else {
    // Try as session ID anyway
    connectToSession(arg);
  }
} else {
  startAndTail();
}
