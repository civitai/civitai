#!/usr/bin/env node
/**
 * TypeCheck CLI
 *
 * Communicates with the typecheck daemon to run and query type checks.
 * Can also run one-off checks without the daemon.
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

const DAEMON_PORT = 9445;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

// Parse tsgo diagnostic line
function parseDiagnosticLine(line) {
  const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/);
  if (match) {
    return {
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      category: match[4],
      code: parseInt(match[5], 10),
      message: match[6],
    };
  }
  return null;
}

// Find tsconfig
function findTsConfig() {
  const tsgoConfig = resolve(projectRoot, 'tsconfig.tsgo.json');
  if (existsSync(tsgoConfig)) return tsgoConfig;
  const regularConfig = resolve(projectRoot, 'tsconfig.json');
  if (existsSync(regularConfig)) return regularConfig;
  return null;
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

  const command = `"${process.execPath}" "${serverScript}"`;
  const child = spawn(command, [], spawnOptions);
  child.unref();

  writeFileSync(pidFile, String(child.pid));

  // Wait for daemon to be ready
  for (let i = 0; i < 100; i++) {
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
  console.error('Starting daemon...');
  const started = await startDaemon();
  if (!started) {
    console.error('Failed to start daemon');
    process.exit(1);
  }
  console.error('Daemon started');
  return true;
}

// Format result like tsc output
function formatPretty(data) {
  const lines = [];

  for (const err of data.errors) {
    // Format: src/file.tsx(42,18): error TS2322: Message
    lines.push(`${err.file}(${err.line},${err.column}): ${err.category} TS${err.code}: ${err.message}`);
  }

  if (data.errorCount > 0 || data.warningCount > 0) {
    lines.push('');
    const parts = [];
    if (data.errorCount > 0) parts.push(`${data.errorCount} error(s)`);
    if (data.warningCount > 0) parts.push(`${data.warningCount} warning(s)`);
    lines.push(`Found ${parts.join(' and ')}. (${data.duration}s)`);
  } else {
    lines.push(`No errors found. (${data.duration}s)`);
  }

  return lines.join('\n');
}

// Commands

async function cmdStatus() {
  await ensureDaemon();
  const result = await daemonRequest('/status');
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdResult(pretty = false) {
  await ensureDaemon();
  const result = await daemonRequest('/result');
  if (!result.ok) {
    if (result.status === 404) {
      console.error('No check results yet. Daemon is starting initial check...');
      process.exit(1);
    }
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }

  if (pretty) {
    console.log(formatPretty(result.data));
  } else {
    console.log(JSON.stringify(result.data, null, 2));
  }

  if (result.data.errorCount > 0) {
    process.exit(1);
  }
}

async function cmdCheck() {
  await ensureDaemon();
  const result = await daemonRequest('/run', { method: 'POST' });
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));

  // Exit with error code if there are errors
  if (result.data.errorCount > 0) {
    process.exit(1);
  }
}

async function cmdHistory(limit = '10') {
  await ensureDaemon();
  const result = await daemonRequest(`/history?limit=${limit}`);
  if (!result.ok) {
    console.error('Error:', result.error || result.data?.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.data, null, 2));
}

async function cmdWatch() {
  await ensureDaemon();
  console.error('Watching for type check results... (Ctrl+C to stop)\n');

  let lastRunId = 0;

  const poll = async () => {
    const result = await daemonRequest('/result');
    if (result.ok && result.data.runId !== lastRunId) {
      lastRunId = result.data.runId;
      const { success, errorCount, warningCount, duration, trigger, timestamp } = result.data;
      const time = new Date(timestamp).toLocaleTimeString();

      if (success) {
        console.log(`[${time}] No errors (${duration}s) - ${trigger}`);
      } else {
        console.log(`[${time}] ${errorCount} error(s), ${warningCount} warning(s) (${duration}s) - ${trigger}`);
        for (const err of result.data.errors.slice(0, 5)) {
          console.log(`  ${err.file}:${err.line}:${err.column}`);
          console.log(`    TS${err.code}: ${err.message}`);
        }
        if (result.data.errors.length > 5) {
          console.log(`  ... and ${result.data.errors.length - 5} more`);
        }
      }
    }
  };

  await poll();
  setInterval(poll, 1000);
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

// One-off run without daemon (for simple use cases)
async function cmdRun() {
  const tsConfigPath = findTsConfig();

  if (!tsConfigPath) {
    console.log(JSON.stringify({ error: 'No tsconfig found' }));
    process.exit(1);
  }

  const startTime = Date.now();

  try {
    const result = execSync(
      `npx @typescript/native-preview --noEmit --project "${tsConfigPath}" --pretty false`,
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(JSON.stringify({
      success: true,
      errorCount: 0,
      warningCount: 0,
      errors: [],
      duration: parseFloat(duration),
      tsconfig: tsConfigPath,
    }, null, 2));

  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const output = (err.stdout || '') + (err.stderr || '');
    const lines = output.split('\n');

    const errors = [];
    for (const line of lines) {
      const diag = parseDiagnosticLine(line.trim());
      if (diag) {
        errors.push(diag);
      }
    }

    const errorCount = errors.filter(e => e.category === 'error').length;
    const warningCount = errors.filter(e => e.category === 'warning').length;

    console.log(JSON.stringify({
      success: errorCount === 0,
      errorCount,
      warningCount,
      errors,
      duration: parseFloat(duration),
      tsconfig: tsConfigPath,
    }, null, 2));

    if (errorCount > 0) {
      process.exit(1);
    }
  }
}

// Parse arguments
const args = process.argv.slice(2);
const command = args[0];
const arg1 = args[1];
const hasFlag = (flag) => args.includes(flag);

switch (command) {
  case 'status':
    cmdStatus();
    break;
  case 'result':
    cmdResult(hasFlag('--pretty'));
    break;
  case 'check':
    cmdCheck();
    break;
  case 'history':
    cmdHistory(arg1);
    break;
  case 'watch':
    cmdWatch();
    break;
  case 'shutdown':
    cmdShutdown();
    break;
  case 'run':
    // One-off run without daemon
    cmdRun();
    break;
  default:
    console.log(`TypeCheck CLI (tsgo)

Commands:
  status              Check daemon status and latest result
  result [--pretty]   Get cached type check result (instant)
  check               Force a fresh type check
  history [limit]     Get check history (default: 10)
  watch               Watch for type check results (interactive)
  shutdown            Shutdown the daemon
  run                 One-off check (no daemon, for simple use)

Options:
  --pretty            Output in tsc-like format (for result command)

The daemon auto-starts when needed. It watches for file changes
and runs tsgo automatically, caching results for instant access.
`);
    if (command) {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
