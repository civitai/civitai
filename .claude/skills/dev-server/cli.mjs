#!/usr/bin/env node
/**
 * Dev Server CLI for Agents
 * Communicates with the dev daemon to manage dev servers.
 */

import { spawn, execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

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
  console.log('Starting daemon...');
  const started = await startDaemon();
  if (!started) {
    console.error('Failed to start daemon');
    process.exit(1);
  }
  console.log('Daemon started');
  return true;
}

async function cmdStatus() {
  await ensureDaemon();
  const result = await daemonRequest('/status');
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdList() {
  await ensureDaemon();
  const result = await daemonRequest('/sessions');
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdStart(worktree) {
  await ensureDaemon();
  const cwd = worktree ? resolve(worktree) : process.cwd();
  const result = await daemonRequest('/sessions', {
    method: 'POST',
    body: JSON.stringify({ worktree: cwd }),
  });
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdLogs(sessionId, since) {
  await ensureDaemon();

  // If no session ID, get the first running session
  if (!sessionId) {
    const listResult = await daemonRequest('/sessions');
    if (!listResult.ok || !listResult.data.sessions?.length) {
      console.error('No sessions found');
      process.exit(1);
    }
    const running = listResult.data.sessions.find(s => s.status === 'running');
    sessionId = running ? running.id : listResult.data.sessions[0].id;
  }

  const query = since ? `?since=${since}` : '';
  const result = await daemonRequest(`/sessions/${sessionId}/logs${query}`);
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdTail(sessionId) {
  await ensureDaemon();

  // If no session ID, get the first running session
  if (!sessionId) {
    const listResult = await daemonRequest('/sessions');
    if (!listResult.ok || !listResult.data.sessions?.length) {
      console.error('No sessions found');
      process.exit(1);
    }
    const running = listResult.data.sessions.find(s => s.status === 'running');
    sessionId = running ? running.id : listResult.data.sessions[0].id;
  }

  let lastIndex = -1;

  const poll = async () => {
    const result = await daemonRequest(`/sessions/${sessionId}/logs?since=${lastIndex}`);
    if (!result.ok) {
      console.error('Error:', result.error || result.data?.error);
      process.exit(1);
    }
    for (const log of result.data.logs) {
      console.log(`[${log.level}] ${log.message}`);
      lastIndex = log.index;
    }
  };

  await poll();
  setInterval(poll, 1000);
}

async function cmdStop(sessionId) {
  await ensureDaemon();
  if (!sessionId) {
    console.error('Session ID required');
    process.exit(1);
  }
  const result = await daemonRequest(`/sessions/${sessionId}`, { method: 'DELETE' });
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdRestart(sessionId) {
  await ensureDaemon();
  if (!sessionId) {
    console.error('Session ID required');
    process.exit(1);
  }
  const result = await daemonRequest(`/sessions/${sessionId}/restart`, { method: 'POST' });
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdShutdown() {
  const result = await daemonRequest('/shutdown', { method: 'POST' });
  if (!result.ok && result.status !== 0) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log('Daemon shutdown');
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

// Parse arguments
const args = process.argv.slice(2);
const command = args[0];
const arg1 = args[1];
const arg2 = args[2];

switch (command) {
  case 'status':
    cmdStatus();
    break;
  case 'list':
    cmdList();
    break;
  case 'start':
    cmdStart(arg1);
    break;
  case 'logs':
    cmdLogs(arg1, arg2);
    break;
  case 'tail':
    cmdTail(arg1);
    break;
  case 'stop':
    cmdStop(arg1);
    break;
  case 'restart':
    cmdRestart(arg1);
    break;
  case 'shutdown':
    cmdShutdown();
    break;
  default:
    console.log(`Dev Server CLI

Commands:
  status              Check daemon status and list sessions
  list                List all sessions
  start [worktree]    Start a dev server (default: current directory)
  logs [session-id]   Get logs for a session
  tail [session-id]   Tail logs continuously
  stop <session-id>   Stop a session
  restart <session-id> Restart a session
  shutdown            Shutdown the daemon
`);
    if (command) {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
