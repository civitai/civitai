#!/usr/bin/env node
/**
 * Dev Server CLI for Agents
 * Communicates with the dev daemon to manage dev servers.
 */

import { spawn, execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { exitCodeFor, isTerminal as isTerminalStatus } from './scripts/test-queue.mjs';
import { resolveDaemonUrl } from './scripts/daemon-port.mjs';
import { resolveDaemonHome } from './scripts/paths.mjs';

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

// ONE daemon serves every worktree, so it must not live inside one. The skill directory is
// committed, so `__dirname` names whichever tree the agent happened to run the CLI from — and a
// daemon spawned there holds that directory open for its whole life, so `wt rm` on it fails EBUSY
// for whoever finishes their PR first. It also survives the tree: the daemon's own copy of
// daemon.mjs would be deleted out from under it.
//
// So the daemon's script, its pid file and its cwd all come from the checkout that owns the .git
// directory. Falls back to the caller's own tree when git cannot answer — a wrong-tree daemon is
// worse than a right-tree one, but no daemon at all is worse than either.
const daemonHome = resolveDaemonHome(__dirname, projectRoot);

const pidFile = resolve(daemonHome.skillDir, 'daemon.pid');
const serverScript = resolve(daemonHome.skillDir, 'scripts/daemon.mjs');

/**
 * Exit after draining pending writes.
 *
 * process.exit() terminates the process WITHOUT waiting for buffered writes to finish, so the last
 * `console.log`/`console.error` lines can be LOST when stdout/stderr is a pipe-backed capture (e.g.
 * exec background). Call this instead of process.exit whenever a waiter has just printed output:
 * the empty-string write is queued after the pending data, and the callback fires only once all
 * earlier writes have been flushed to the kernel.
 */
function drainThenExit(code) {
  let pending = 2;
  const done = () => { if (--pending === 0) process.exit(code); };
  process.stdout.write('', done);
  process.stderr.write('', done);
  // Safety: if neither callback fires within 500ms (unlikely but makes the bug unreproducible
  // rather than systemic), exit anyway — a slightly stale exit code is better than a hung process.
  setTimeout(() => process.exit(code), 500).unref();
}

// Overridable via DEV_DAEMON_PORT, so a second daemon can be exercised without touching the
// shared one. The whole decision — port included — is made in scripts/daemon-port.mjs, which is
// also what the daemon reads, so this file does no arithmetic on a port and cannot drift from it.
const DAEMON_URL = resolveDaemonUrl();

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
    // The primary checkout, not the caller's. A cwd inside a worktree is itself a handle on that
    // directory, so pointing only the script at the primary would still pin the tree.
    cwd: daemonHome.home,
    windowsHide: true,
  };

  // No shell. windowsHide reaches only the process node creates, so with `shell: true` it lands on
  // cmd.exe and never on the daemon cmd.exe then starts: that node gets a fresh console, Windows 11
  // hands it to the default terminal app, and a Windows Terminal window opens and takes focus off
  // whatever the user was doing. No --port: the daemon resolves DEV_DAEMON_PORT through the same
  // function this file does, off the environment it inherits here, so the two cannot disagree.
  const child = spawn(process.execPath, [serverScript], spawnOptions);
  child.unref();

  writeFileSync(pidFile, String(child.pid));

  // Wait for daemon to be ready
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
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

// `--prod db,buzz` / `--dev search`, repeatable. Groups come from env-modes.local, so the daemon
// validates the names — this only has to get the shape right.
// Flags on `start` and the app verbs that consume the following token. A fourth value-flag added to
// parseModeFlags without being added here has its value silently eaten as the worktree.
//
// Not `probe`'s own VALUE_FLAGS further down — different verb, different set.
const SESSION_VALUE_FLAGS = new Set(['--app', '--prod', '--dev']);

function parseModeFlags(flags) {
  const modes = { prod: [], dev: [], app: null };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const inlineApp = flag.match(/^--app=(.*)$/);
    if (inlineApp) {
      if (!inlineApp[1].trim()) throw new Error('--app= needs an app name, e.g. --app=moderator');
      modes.app = inlineApp[1].trim();
      continue;
    }
    if (flag === '--app') {
      const value = flags[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--app needs an app name, e.g. --app moderator');
      }
      modes.app = value;
      continue;
    }
    const inline = flag.match(/^--(prod|dev)=(.*)$/);
    if (inline) {
      // `--prod=` would otherwise be an empty, silent no-op while the spaced form errors.
      if (!inline[2].trim()) {
        throw new Error(`--${inline[1]}= needs a group list, e.g. --${inline[1]}=db,buzz`);
      }
      modes[inline[1]].push(inline[2]);
      continue;
    }
    if (flag === '--prod' || flag === '--dev') {
      const value = flags[++i];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} needs a group list, e.g. ${flag} db,buzz`);
      }
      modes[flag.slice(2)].push(value);
      continue;
    }
    throw new Error(
      `Unknown option "${flag}". Usage: start [worktree] [--app name] [--prod a,b] [--dev a,b]`
    );
  }
  return { app: modes.app, prod: modes.prod.join(','), dev: modes.dev.join(',') };
}

async function cmdStart(worktree, flags = []) {
  await ensureDaemon();
  const cwd = worktree ? resolve(worktree) : process.cwd();

  let modes;
  try {
    modes = parseModeFlags(flags);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // `start --app moderator` is the same gesture as `start`, aimed at a different app in the same
  // worktree. It routes to /app/<name>/start rather than /sessions: an app is not a Next.js session
  // and has no build dir, prewarm or branch watching to configure.
  //
  // Parsing happens BEFORE the branch so an unknown flag still fails here, and so a mode flag on an
  // app start is refused rather than silently dropped — apps get the raw env chain, with no overlay
  // applied, which is precisely the difference a `--prod db` would be trying to express.
  const { app, ...sessionModes } = modes;
  if (app) {
    if (sessionModes.prod || sessionModes.dev) {
      console.error(
        `Error: --prod/--dev are not supported with --app. Apps run on the .env chain with no ` +
          `overlay; only the main app has env modes.`
      );
      process.exit(1);
    }
    return cmdAppStart(app, cwd);
  }

  const result = await daemonRequest('/sessions', {
    method: 'POST',
    body: JSON.stringify({ worktree: cwd, ...sessionModes }),
  });
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

// `--app <name>` on a session verb means "the app in this worktree", so the whole lifecycle uses one
// gesture rather than `start --app x` followed by `app x stop`. Returns null when no --app was given.
//
// It delegates to parseModeFlags rather than matching `--app` itself. A second hand-rolled matcher
// was not equivalent to the first: it accepted `--app=` as empty and fell through, so `logs --app=`
// silently tailed the MAIN app where `start --app=` errored — the same silent-wrong-target this
// change exists to remove. One parser, one policy.
function appFromFlags(flags = []) {
  const appFlags = flags.filter((f) => f === '--app' || f.startsWith('--app='));
  if (!appFlags.length) return null;
  const i = flags.indexOf('--app');
  const pair = i === -1 ? appFlags : ['--app', flags[i + 1]].filter((v) => v !== undefined);
  try {
    return parseModeFlags(pair).app;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
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
    const running = listResult.data.sessions.find((s) => s.status === 'running');
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
    const running = listResult.data.sessions.find((s) => s.status === 'running');
    sessionId = running ? running.id : listResult.data.sessions[0].id;
  }

  await followLogs((since) => `/sessions/${sessionId}/logs?since=${since}`);
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

async function cmdRgb(subcmd) {
  await ensureDaemon();
  const action = subcmd || 'status';
  let result;
  switch (action) {
    case 'status':
      result = await daemonRequest('/rgb');
      break;
    case 'start':
      result = await daemonRequest('/rgb/start', { method: 'POST' });
      break;
    case 'stop':
      result = await daemonRequest('/rgb/stop', { method: 'POST' });
      break;
    case 'restart':
      result = await daemonRequest('/rgb/restart', { method: 'POST' });
      break;
    case 'logs':
      result = await daemonRequest('/rgb/logs');
      break;
    default:
      console.error(`Unknown rgb subcommand: ${action}`);
      console.error('Usage: rgb [status|start|stop|restart|logs]');
      process.exit(1);
  }
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error || JSON.stringify(result.data));
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdAuth(subcmd) {
  await ensureDaemon();
  const action = subcmd || 'status';
  let result;
  switch (action) {
    case 'status':
      result = await daemonRequest('/auth');
      break;
    case 'start':
      result = await daemonRequest('/auth/start', { method: 'POST' });
      break;
    case 'stop':
      result = await daemonRequest('/auth/stop', { method: 'POST' });
      break;
    case 'restart':
      result = await daemonRequest('/auth/restart', { method: 'POST' });
      break;
    case 'logs':
      result = await daemonRequest('/auth/logs');
      break;
    default:
      console.error(`Unknown auth subcommand: ${action}`);
      console.error('Usage: auth [status|start|stop|restart|logs]');
      process.exit(1);
  }
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error || JSON.stringify(result.data));
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

// Shared by `start --app <name>` and `app <name> start`. The worktree travels with the request:
// without it the daemon serves whichever checkout launched it, and does so silently.
async function cmdAppStart(name, worktree) {
  const result = await daemonRequest(`/app/${name}/start`, {
    method: 'POST',
    body: JSON.stringify({ worktree }),
  });
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error || JSON.stringify(result.data));
    if (result.data?.available) console.error('Available apps:', result.data.available.join(', '));
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

// `tail` differs from `logs` only in that it follows. Routing --app to the one-shot printer made the
// verb quietly mean the other one, and an agent reads that snapshot as "the app stopped producing
// output". Both endpoints take `since`, so one loop serves both — written once so a colour, a level
// filter or a --since added later cannot land on only one of them.
async function followLogs(urlFor) {
  let lastIndex = 0;
  const poll = async () => {
    const result = await daemonRequest(urlFor(lastIndex));
    if (!result.ok) {
      console.error('Error:', result.error || result.data?.error || JSON.stringify(result.data));
      if (result.data?.running?.length) {
        console.error(`Running in: ${result.data.running.join(', ')}`);
      }
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

async function cmdAppTail(name, worktreeArg) {
  await ensureDaemon();
  // Same validation as cmdApp. `tail` dispatches straight here rather than through it, so without
  // this `tail --app moderator 500` still turned 500 into a worktree — the exact confusing 404 the
  // validation was added to remove, left open on one verb.
  const worktree = resolveWorktreeArg(worktreeArg);
  const query = `?worktree=${encodeURIComponent(worktree)}`;
  await followLogs((since) => `/app/${name}/logs${query}&since=${since}`);
}

// The positional on an app verb is a worktree, and only that. `logs --app moderator 500` reads like
// `logs <session> <since>` and would otherwise become a worktree, 404ing with "moderator is not
// running in <cwd>/500" — which sends the reader looking for the app rather than at what they typed.
// Fails closed either way; this says which. statSync, not existsSync, so the message is true: a file
// would otherwise pass the check and 404 anyway.
function resolveWorktreeArg(worktreeArg) {
  if (!worktreeArg) return process.cwd();
  const resolved = resolve(worktreeArg);
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch (e) {}
  if (!isDir) {
    console.error(`Error: "${worktreeArg}" is not a directory.`);
    console.error(`Usage: app <name> [status|start|stop|restart|logs] [worktree]`);
    console.error(`The positional on an app command is a worktree path — there is no "since" here.`);
    process.exit(1);
  }
  return resolved;
}

async function cmdApp(name, subcmd, worktreeArg) {
  await ensureDaemon();
  const cwd = resolveWorktreeArg(worktreeArg);

  // `app` with no name lists what is registered and what is running where.
  if (!name) {
    const result = await daemonRequest('/apps');
    if (!result.ok) {
      console.error('Error:', result.error || JSON.stringify(result.data));
      process.exit(1);
    }
    if (!result.data.apps.length) {
      console.log(`No apps running. Available: ${result.data.available.join(', ')}`);
      return;
    }
    for (const app of result.data.apps) {
      const state = app.ready ? 'ready' : app.status;
      console.log(`${app.name.padEnd(16)} ${state.padEnd(9)} ${app.url.padEnd(24)} ${app.worktree}`);
      if (app.lastError) console.log(`${' '.repeat(16)} ${app.lastError}`);
    }
    return;
  }

  const action = subcmd || 'status';
  if (action === 'start') return cmdAppStart(name, cwd);

  const routes = {
    status: ['', 'GET'],
    logs: ['/logs', 'GET'],
    stop: ['/stop', 'POST'],
    restart: ['/restart', 'POST'],
  };
  const route = routes[action];
  if (!route) {
    console.error(`Unknown app subcommand: ${action}`);
    console.error('Usage: app <name> [status|start|stop|restart|logs] [worktree]');
    process.exit(1);
  }

  const [suffix, method] = route;
  const result = await daemonRequest(
    `/app/${name}${suffix}?worktree=${encodeURIComponent(cwd)}`,
    method === 'POST' ? { method, body: JSON.stringify({ worktree: cwd }) } : undefined
  );
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error || JSON.stringify(result.data));
    if (result.data?.available) console.error('Available apps:', result.data.available.join(', '));
    if (result.data?.running?.length) {
      console.error(`${name} is running in: ${result.data.running.join(', ')}`);
    }
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

const WAIT_POLL_MS = 2000;

// Exit codes: the run's own code when it ran, 2 when the daemon can no longer tell us anything.
const EXIT_UNKNOWN_RUN = 2;

function describeRun(run) {
  const lines = [];
  if (run.status === 'running') {
    lines.push(`Run ${run.id} started (nothing ahead of it).`);
  } else if (run.paused) {
    lines.push(
      `Run ${run.id} queued at position ${run.position}, but the queue is PAUSED (concurrency 0).`,
      `Nothing will start until someone raises it: node .claude/skills/dev-server/cli.mjs test config 1`
    );
  } else {
    lines.push(
      `Run ${run.id} queued at position ${run.position} of ${run.queueLength} ` +
        `(${run.running}/${run.concurrency} running).`
    );
  }
  lines.push(`Wait for it in the background: ${run.waitCommand}`);
  return lines.join('\n');
}

async function cmdTestRun(rest) {
  await ensureDaemon();
  const sep = rest.indexOf('--');
  const args = sep === -1 ? [] : rest.slice(sep + 1);
  const target = (sep === -1 ? rest : rest.slice(0, sep)).find((a) => !a.startsWith('--'));
  const worktree = target ? resolve(target) : process.cwd();

  const result = await daemonRequest('/test-runs', {
    method: 'POST',
    body: JSON.stringify({ worktree, args }),
  });
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(describeRun(result.data));
}

async function cmdTestWait(id) {
  if (!id) {
    console.error('Usage: test wait <run-id>');
    process.exit(1);
  }

  let lastStatus = null;
  let lastLogIndex = -1;
  let announcedPause = false;

  for (;;) {
    const result = await daemonRequest(`/test-runs/${id}`);

    // A daemon that has forgotten this run — or that is gone — is terminal, not something to keep
    // polling. Restarting the daemon drops the in-memory queue, and a waiter that polled through
    // that would hang forever.
    if (result.status === 404) {
      console.error(
        `Run ${id} is unknown to the daemon. It was most likely restarted, which drops queued and ` +
          `in-flight runs. Request a new run.`
      );
      drainThenExit(EXIT_UNKNOWN_RUN);
    }
    if (!result.ok) {
      console.error(`Cannot reach the daemon: ${result.error || result.data?.error}`);
      drainThenExit(EXIT_UNKNOWN_RUN);
    }

    const run = result.data;
    if (run.status !== lastStatus) {
      console.log(
        run.status === 'queued'
          ? `queued at position ${run.position} of ${run.queueLength}`
          : `${run.status}`
      );
      lastStatus = run.status;
    }
    if (run.paused && !announcedPause && !isTerminalStatus(run.status)) {
      console.log('queue is PAUSED (concurrency 0) — nothing will start until it is raised');
      announcedPause = true;
    }

    if (run.status === 'running' || isTerminalStatus(run.status)) {
      const logs = await daemonRequest(`/test-runs/${id}/logs?since=${lastLogIndex}`);
      for (const entry of logs.data?.logs ?? []) {
        console.log(entry.message);
        lastLogIndex = entry.index;
      }
    }

    if (isTerminalStatus(run.status)) {
      // Both waiters say this, in the same place, for the same reason: a truncated log that does
      // not announce itself is read as a whole one. See `warnIfLogsDropped` in test-unit-run.mjs.
      if (run.logsDropped) {
        console.error(
          `WARNING: this log is INCOMPLETE — the queue dropped the oldest ${run.logsDropped} of ` +
            `${run.logIndex} output lines. Do not read the text above as the whole run.`
        );
      }
      console.log(`Run ${id} ${run.status}${run.error ? ` (${run.error})` : ''}`);
      drainThenExit(exitCodeFor(run));
    }

    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

async function cmdTest(sub, rest) {
  const action = sub || 'list';
  if (action === 'run') return cmdTestRun(rest);
  if (action === 'wait') return cmdTestWait(rest[0]);

  await ensureDaemon();
  let result;
  switch (action) {
    case 'list':
    case 'status':
      result = await daemonRequest('/test-runs');
      break;
    case 'show':
      result = await daemonRequest(`/test-runs/${rest[0]}`);
      break;
    case 'logs':
      result = await daemonRequest(`/test-runs/${rest[0]}/logs`);
      break;
    case 'cancel':
      result = await daemonRequest(`/test-runs/${rest[0]}`, { method: 'DELETE' });
      break;
    case 'config':
      result = rest[0]
        ? await daemonRequest('/test-runs/config', {
            method: 'POST',
            body: JSON.stringify({ concurrency: Number(rest[0]) }),
          })
        : await daemonRequest('/test-runs/config');
      break;
    default:
      console.error(`Unknown test subcommand: ${action}`);
      console.error('Usage: test [run|wait|list|show|logs|cancel|config]');
      process.exit(1);
  }
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error || JSON.stringify(result.data));
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

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

async function resolveSession(sessionId) {
  const result = await daemonRequest('/sessions');
  const sessions = result.data?.sessions ?? [];
  if (sessionId) {
    const found = sessions.find((s) => s.id === sessionId);
    if (!found) {
      console.error(`No session ${sessionId}. Known: ${sessions.map((s) => s.id).join(', ') || 'none'}`);
      process.exit(1);
    }
    return found;
  }
  const cwd = process.cwd();
  return (
    sessions.find((s) => samePath(s.worktree, cwd)) ??
    sessions.find((s) => s.status === 'running') ??
    sessions[0] ??
    null
  );
}

// Flags that take a VALUE. Without this the positional scan treats the value as the route, so
// `probe --port 3005 /home` probes `/3005` — a fast 404 that used to report `ok`. Same class of
// wrong-confident answer the Git Bash de-mangling exists to prevent, arriving from the caller.
const VALUE_FLAGS = new Set(['--port', '--session', '--timeout', '--route']);

// A flag nobody reads is a flag silently ignored, and `unwedge` is the destructive command — so it
// gets the check too, not just `probe`.
function rejectUnknownFlags(args, allowed, usage) {
  const unknown = args.filter((a) => a.startsWith('--') && !allowed.includes(a.split('=')[0]));
  if (!unknown.length) return;
  console.error(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  console.error(`Usage: ${usage}`);
  process.exit(1);
}

export function positionalArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

// Both spellings. `--session=abc` used to be skipped by the positional scan and ignored by the
// lookup, so it read as accepted and silently probed a different session.
export function stringFlag(args, name) {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || undefined;
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : undefined;
}

// `min` is per-flag: a timeout under a second is a mistake, but `--port 80` is not.
function numericFlag(args, name, fallback, min = 1) {
  const raw = stringFlag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  // `??` does not catch NaN, and `AbortSignal.timeout(NaN)` is not a timeout.
  if (!Number.isFinite(value) || value < min) {
    console.error(`${name} needs a number of at least ${min}, got "${raw}"`);
    process.exit(1);
  }
  return value;
}

async function cmdProbe(rest) {
  await ensureDaemon();
  const { probe, formatProbe, normalizeRoute } = await import('./scripts/probe.mjs');

  rejectUnknownFlags(rest, ['--route', '--session', '--port', '--timeout', '--json'],
    'probe [route] [--route /x] [--session id] [--port n] [--timeout ms] [--json]');
  // Two routes given, one silently discarded, is the same class of quiet wrong answer as the rest
  // of this function.
  if (stringFlag(rest, '--route') && positionalArgs(rest)[0]) {
    console.error('Give the route once: either positionally or with --route, not both.');
    process.exit(1);
  }
  // `--route` is what the sibling `unwedge` documents, so it gets typed here. Accepting it silently
  // probed `/` and reported a confident verdict about a route nobody asked for.
  const { route, mangled } = normalizeRoute(
    stringFlag(rest, '--route') ?? positionalArgs(rest)[0] ?? '/'
  );
  if (mangled) console.log(`(Git Bash rewrote the route; probing ${route})`);
  const sessionId = stringFlag(rest, '--session');
  const session = await resolveSession(sessionId);
  const port = numericFlag(rest, '--port', session?.port);

  if (!port) {
    console.error('No dev session and no --port. Start one: cli.mjs start');
    process.exit(1);
  }

  const result = await probe({
    route,
    port,
    sessionId: session?.id ?? null,
    worktree: session?.worktree,
    daemonRequest,
    timeoutMs: numericFlag(rest, '--timeout', undefined, 1000),
  });

  console.log(formatProbe(result));
  if (rest.includes('--json')) console.log(JSON.stringify(result, null, 2));
  // A wedged or unreachable server is a failure for whoever asked, not a report.
  process.exit(['ok', 'cold'].includes(result.verdict) ? 0 : 1);
}

// Explicit session id, always: this stops a running server and deletes several GB, and the session
// it would otherwise guess at is usually the one someone is looking at.
async function cmdUnwedge(rest) {
  await ensureDaemon();
  const { probe, formatProbe, purgeDistDir, normalizeRoute } = await import('./scripts/probe.mjs');

  rejectUnknownFlags(rest, ['--route'], 'unwedge <session-id> [--route /x]');
  const sessionId = positionalArgs(rest)[0];
  if (!sessionId) {
    console.error('Usage: unwedge <session-id> [--route /home]');
    console.error('Takes the server down for ~45s. Name the session deliberately.');
    process.exit(1);
  }
  const session = await resolveSession(sessionId);
  const { route } = normalizeRoute(stringFlag(rest, '--route') ?? '/');

  // Restart on the modes it is already running, so unwedging never silently relocates a session.
  // Both halves, explicitly. Sending only the prod list lets DEVSERVER_PROD_GROUPS re-decide every
  // group that was not named — so a session deliberately started `--dev db` could come back up on
  // the PRODUCTION database, with nothing but a mode summary scrolling past to say so.
  const groups = Object.entries(session.envModes || {});
  const prod = groups.filter(([, m]) => m === 'prod').map(([g]) => g).join(',');
  // `m === 'dev'`, NOT `m !== 'prod'`. getStatus() also reports `base` — a group with no section
  // for the chosen mode, which the resolver deliberately tolerates. Naming one on a flag turns that
  // tolerated case into a throw, and this runs AFTER the purge, so the session is already down.
  const dev = groups.filter(([, m]) => m === 'dev').map(([g]) => g).join(',');

  console.log(`Stopping ${session.id} (${session.branch}) on port ${session.port}...`);
  const stopped = await daemonRequest(`/sessions/${session.id}`, { method: 'DELETE' });
  if (!stopped.ok) {
    console.error('Error stopping session:', stopped.error || stopped.data?.error);
    process.exit(1);
  }

  const purgeStart = Date.now();
  let purged;
  try {
    purged = purgeDistDir(session.worktree, session.distDir);
  } catch (err) {
    console.error(`${err.message}\nThe session is stopped; start it again with: cli.mjs start ${session.worktree}`);
    process.exit(1);
  }
  console.log(
    purged.removed
      ? `Purged ${purged.path} in ${((Date.now() - purgeStart) / 1000).toFixed(1)}s`
      : `Nothing to purge at ${purged.path}`
  );

  const started = await daemonRequest('/sessions', {
    method: 'POST',
    body: JSON.stringify({ worktree: session.worktree, prod, dev }),
  });
  if (!started.ok) {
    console.error('Error restarting session:', started.error || started.data?.error);
    // The build dir is already gone at this point; say how to get a server back.
    console.error(`The session is stopped and its build dir was purged. Start it again with:`);
    console.error(`  node .claude/skills/dev-server/cli.mjs start ${session.worktree}`);
    process.exit(1);
  }
  const fresh = started.data?.session ?? started.data;
  const newId = fresh?.id ?? session.id;
  console.log(`Restarted as ${newId} on port ${fresh?.port ?? session.port}.`);

  const readyStart = Date.now();
  const READY_TIMEOUT_MS = 180_000;
  for (;;) {
    const check = await daemonRequest(`/sessions/${newId}`);
    const state = check.data?.session ?? check.data;
    if (state?.ready) {
      console.log(`Ready in ${((Date.now() - readyStart) / 1000).toFixed(1)}s.`);
      break;
    }
    if (state?.status === 'crashed' || state?.status === 'error') {
      console.error(`Session ${state.status}. Read: cli.mjs logs ${newId}`);
      process.exit(1);
    }
    if (Date.now() - readyStart > READY_TIMEOUT_MS) {
      console.error(`Not ready after ${READY_TIMEOUT_MS / 1000}s. Read: cli.mjs logs ${newId}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('');
  const result = await probe({
    route,
    port: fresh?.port ?? session.port,
    sessionId: newId,
    worktree: session.worktree,
    daemonRequest,
  });
  console.log(formatProbe(result));
  process.exit(['ok', 'cold'].includes(result.verdict) ? 0 : 1);
}

async function cmdWorktree(rest) {
  const [action, ...tail] = rest;
  const { cmdStale, cmdRemove } = await import('./scripts/worktree.mjs');

  if (action === 'stale') {
    await cmdStale(projectRoot, daemonRequest);
    return;
  }
  if (action === 'rm') {
    const target = tail.find((a) => !a.startsWith('--'));
    if (!target) {
      console.error('Usage: wt rm <worktree-path> [--stop-server] [--force]');
      process.exit(1);
    }
    await cmdRemove(
      projectRoot,
      target,
      { stopServer: tail.includes('--stop-server'), force: tail.includes('--force') },
      daemonRequest
    );
    return;
  }
  console.error('Usage: wt <stale|rm>');
  process.exit(1);
}

// Parse arguments
const args = process.argv.slice(2);
const command = args[0];
// One gesture for the whole lifecycle: `start --app x` then `logs --app x`, `stop --app x`. Without
// this only `start` took --app and everything after it needed the second `app <name> …` vocabulary.
//
// Only for the verbs that dispatch on it below. Parsing it for EVERY command would let a future
// `--app` on `test`, `wt` or `probe` be intercepted into the app vocabulary before that verb's own
// parser ever saw it.
const APP_FLAG_VERBS = new Set(['start', 'logs', 'tail', 'stop', 'restart']);
const appFlag = APP_FLAG_VERBS.has(command) ? appFromFlags(args.slice(1)) : null;
// `stop <worktree> --app moderator` must mean the same tree as `start <worktree> --app moderator`.
//
// Skipped by POSITION, not by value. Excluding the flag's value by equality dropped the worktree
// whenever its path happened to equal the app name — `stop moderator --app moderator`, naming a
// worktree directory after the app in it, which is the obvious way to name one — and silently
// targeted the cwd instead.
const positional = (() => {
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (SESSION_VALUE_FLAGS.has(rest[i])) {
      i++;
      continue;
    }
    if (rest[i].startsWith('--')) continue;
    return rest[i];
  }
  return undefined;
})();
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
    if (arg1 && arg1.startsWith('--')) cmdStart(undefined, args.slice(1));
    else cmdStart(arg1, args.slice(2));
    break;
  case 'logs':
    if (appFlag) cmdApp(appFlag, 'logs', positional);
    else cmdLogs(arg1, arg2);
    break;
  case 'tail':
    if (appFlag) cmdAppTail(appFlag, positional);
    else cmdTail(arg1);
    break;
  case 'stop':
    if (appFlag) cmdApp(appFlag, 'stop', positional);
    else cmdStop(arg1);
    break;
  case 'restart':
    if (appFlag) cmdApp(appFlag, 'restart', positional);
    else cmdRestart(arg1);
    break;
  case 'rgb':
    cmdRgb(arg1);
    break;
  case 'auth':
    cmdAuth(arg1);
    break;
  case 'app':
    cmdApp(arg1, args[2], args[3]);
    break;
  case 'shutdown':
    cmdShutdown();
    break;
  case 'test':
    cmdTest(arg1, args.slice(2));
    break;
  case 'probe':
    cmdProbe(args.slice(1));
    break;
  case 'unwedge':
    cmdUnwedge(args.slice(1));
    break;
  case 'wt':
    cmdWorktree(args.slice(1));
    break;
  default:
    console.log(`Dev Server CLI

Commands:
  status              Check daemon status and list sessions
  list                List all sessions
  start [worktree] [--app name] [--prod a,b] [--dev a,b]
                      Start a dev server (default: the main app, current directory).
                      --app moderator|creator-studio starts that app from the same
                      worktree instead, on its preferred port or the next free one.
                      Every env group defaults to dev; --prod moves named groups
                      (or "all") to production for this start only. See SKILL.md.
  probe [route]       Request a route with a hard timeout and say WHY it was slow.
                      Never hangs. Use this instead of curl against a dev port.
                      [--session id] [--port n] [--timeout ms] [--json]
  unwedge <session>   Stop, delete the build dir, restart, wait for ready, re-probe.
                      ~45s of downtime — only after probe says WEDGED.
  logs [session-id] [--app name]
                      Get logs for a session, or for an app in this worktree
  tail [session-id] [--app name]
                      Tail logs continuously
  stop <session-id> | stop --app name
                      Stop a session or an app
  restart <session-id> | restart --app name
                      Restart a session or an app
  rgb [subcmd]        RGB proxy control (status|start|stop|restart|logs)
  auth [subcmd]       Auth hub control (status|start|stop|restart|logs)
  app                 List running apps and what is available (moderator, creator-studio)
  app <name> [subcmd] [worktree]
                      App control (status|start|stop|restart|logs).
                      Defaults to the current directory's worktree, not the
                      checkout the daemon happens to have been started from.
  shutdown            Shutdown the daemon
  test run [wt]       Queue a unit-test run; returns position + the command to wait on it
  test wait <run-id>  Block until that run finishes; exits with the run's exit code
  test list           List runs and queue state
  test cancel <id>    Cancel a queued or running run
  test config [n]     Show or set the concurrency limit (0 pauses the queue)
  wt stale            List worktrees whose PR merged (read-only)
  wt rm <path>        Remove a worktree safely (unlinks junctions first)
                      [--stop-server] [--force]
`);
    if (command) {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
