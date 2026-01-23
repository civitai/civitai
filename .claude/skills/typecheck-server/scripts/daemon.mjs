#!/usr/bin/env node
/**
 * TypeCheck Daemon
 *
 * HTTP server that runs tsgo type checking with file watching.
 * Provides centralized type check results for agents and devs.
 *
 * Usage:
 *   node daemon.mjs [--port <port>]
 *
 * Security: Binds to 127.0.0.1 only (localhost)
 */

import http from 'http';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

// Dynamic import for chokidar
let chokidar;
try {
  chokidar = await import('chokidar');
} catch {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  chokidar = require('chokidar');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(__dirname, '..');
const projectRoot = resolve(skillDir, '../../..');
const pidFile = resolve(skillDir, 'daemon.pid');

// Configuration
const DEFAULT_DAEMON_PORT = 9445;
const MAX_HISTORY = 50;
const DEBOUNCE_MS = 150;
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.next/**',
];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: DEFAULT_DAEMON_PORT,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        config.port = parseInt(args[++i], 10);
        break;
    }
  }

  return config;
}

// Find tsconfig
function findTsConfig() {
  const tsgoConfig = resolve(projectRoot, 'tsconfig.tsgo.json');
  if (existsSync(tsgoConfig)) return tsgoConfig;
  const regularConfig = resolve(projectRoot, 'tsconfig.json');
  if (existsSync(regularConfig)) return regularConfig;
  return null;
}

// Find tsgo binary (avoid npx overhead)
function findTsgoBinary() {
  // Platform-specific package name
  const platform = process.platform;
  const arch = process.arch;
  const packageName = `native-preview-${platform}-${arch}`;

  // Try to find the native binary directly
  const nativePath = resolve(projectRoot, 'node_modules', '@typescript', packageName, 'lib', platform === 'win32' ? 'tsgo.exe' : 'tsgo');
  if (existsSync(nativePath)) {
    return nativePath;
  }

  // Fallback to npx
  return null;
}

// Parse diagnostic line
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

// State
let isRunning = false;
let pendingRun = false;
let lastResult = null;
let history = [];
let runCount = 0;
let watcher = null;
let watcherReady = false;
let tsConfigPath = null;
let tsgoBinary = null;

// Run tsgo
async function runTsgo(trigger = 'manual') {
  if (isRunning) {
    pendingRun = true;
    return null;
  }

  isRunning = true;
  runCount++;
  const runId = runCount;
  const startTime = Date.now();

  console.error(`[${new Date().toLocaleTimeString()}] Running tsgo (#${runId}, trigger: ${trigger})...`);

  const tsBuildInfoPath = resolve(projectRoot, '.tsbuildinfo', 'typecheck-daemon.tsbuildinfo');

  return new Promise((promiseResolve) => {
    let proc;

    if (tsgoBinary) {
      // Use native binary directly (fast) with incremental mode
      proc = spawn(tsgoBinary, [
        '--noEmit',
        '--incremental',
        '--tsBuildInfoFile', tsBuildInfoPath,
        '--project', tsConfigPath,
        '--pretty', 'false',
      ], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Fallback to npx (slow)
      proc = spawn('npx', [
        '@typescript/native-preview',
        '--noEmit',
        '--incremental',
        '--tsBuildInfoFile', tsBuildInfoPath,
        '--project', tsConfigPath,
        '--pretty', 'false',
      ], {
        cwd: projectRoot,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      const output = stdout + stderr;
      const lines = output.split('\n');

      const errors = [];
      for (const line of lines) {
        const diag = parseDiagnosticLine(line.trim());
        if (diag) errors.push(diag);
      }

      const errorCount = errors.filter(e => e.category === 'error').length;
      const warningCount = errors.filter(e => e.category === 'warning').length;

      lastResult = {
        success: errorCount === 0,
        errorCount,
        warningCount,
        errors,
        duration: parseFloat(duration),
        runId,
        trigger,
        timestamp: new Date().toISOString(),
      };

      // Add to history
      history.push(lastResult);
      if (history.length > MAX_HISTORY) {
        history = history.slice(-MAX_HISTORY);
      }

      // Log results
      if (errorCount === 0) {
        console.error(`[${new Date().toLocaleTimeString()}] No errors (${duration}s)`);
      } else {
        console.error(`[${new Date().toLocaleTimeString()}] ${errorCount} error(s), ${warningCount} warning(s) (${duration}s)`);
      }

      isRunning = false;
      promiseResolve(lastResult);

      // Run again if changes happened during this run
      if (pendingRun) {
        pendingRun = false;
        setTimeout(() => runTsgo('queued'), 100);
      }
    });
  });
}

// Setup file watcher
function setupWatcher(srcDir) {
  let debounceTimer = null;

  watcher = chokidar.watch(srcDir, {
    ignored: IGNORE_PATTERNS,
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 100,
    binaryInterval: 100,
  });

  function isTypeScriptFile(filePath) {
    return TS_EXTENSIONS.includes(extname(filePath));
  }

  function handleFileEvent(event, filePath) {
    if (!isTypeScriptFile(filePath)) return;

    console.error(`[chokidar] ${event}: ${filePath}`);

    // Debounce rapid changes
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runTsgo(`${event}: ${filePath}`);
    }, DEBOUNCE_MS);
  }

  watcher.on('change', (path) => handleFileEvent('change', path));
  watcher.on('add', (path) => handleFileEvent('add', path));
  watcher.on('unlink', (path) => handleFileEvent('unlink', path));

  watcher.on('ready', () => {
    watcherReady = true;
    console.error('File watcher ready');
  });

  watcher.on('error', (err) => {
    console.error('Watcher error:', err);
  });
}

// HTTP request body reader
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Main server
async function main() {
  const config = parseArgs();

  // Find tsconfig
  tsConfigPath = findTsConfig();
  if (!tsConfigPath) {
    console.error('No tsconfig found');
    process.exit(1);
  }

  // Find tsgo binary
  tsgoBinary = findTsgoBinary();

  // Write PID file
  writeFileSync(pidFile, String(process.pid));

  console.error(`Starting typecheck daemon...`);
  console.error(`  Port: ${config.port}`);
  console.error(`  Project: ${projectRoot}`);
  console.error(`  Config: ${tsConfigPath}`);
  console.error(`  Binary: ${tsgoBinary || 'npx (fallback)'}`);

  // Setup watcher
  const srcDir = resolve(projectRoot, 'src');
  setupWatcher(srcDir);

  // Run initial check
  await runTsgo('initial');

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const path = url.pathname;

    // CORS headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // GET / - Root endpoint
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          name: 'typecheck-daemon',
          version: '1.0.0',
          status: 'running',
          pid: process.pid,
          uptime: process.uptime(),
          watcherReady,
          isChecking: isRunning,
          lastResult: lastResult ? {
            success: lastResult.success,
            errorCount: lastResult.errorCount,
            timestamp: lastResult.timestamp,
          } : null,
        }));
        return;
      }

      // GET /status - Full status with latest result
      if (path === '/status' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'running',
          pid: process.pid,
          uptime: process.uptime(),
          projectRoot,
          tsconfig: tsConfigPath,
          watcherReady,
          isChecking: isRunning,
          runCount,
          lastResult,
        }));
        return;
      }

      // GET /result - Get latest result only
      if (path === '/result' && req.method === 'GET') {
        if (!lastResult) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No check results yet' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(lastResult));
        return;
      }

      // GET /history - Get check history
      if (path === '/history' && req.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '10', 10);
        const results = history.slice(-limit);
        res.writeHead(200);
        res.end(JSON.stringify({
          count: results.length,
          total: history.length,
          results,
        }));
        return;
      }

      // POST /run - Trigger a check immediately
      if (path === '/run' && req.method === 'POST') {
        if (isRunning) {
          res.writeHead(200);
          res.end(JSON.stringify({
            queued: true,
            message: 'Check already in progress, request queued',
          }));
          pendingRun = true;
          return;
        }

        // Run check and wait for result
        const result = await runTsgo('api');
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      // POST /shutdown - Shutdown daemon
      if (path === '/shutdown' && req.method === 'POST') {
        console.error('Shutdown requested...');

        if (watcher) {
          await watcher.close();
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));

        setTimeout(() => {
          try { unlinkSync(pidFile); } catch (e) {}
          process.exit(0);
        }, 100);
        return;
      }

      // 404
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found', path }));

    } catch (err) {
      console.error('Request error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  };

  // Start server
  const server = http.createServer(handler);
  server.listen(config.port, '127.0.0.1', () => {
    console.error(`\nDaemon running on http://127.0.0.1:${config.port}`);
    console.error(`\nReady.`);

    // Output ready signal to stdout for parsing
    console.log(JSON.stringify({
      type: 'daemon_ready',
      port: config.port,
      pid: process.pid,
      projectRoot,
    }));
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
  });

  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.error('\nShutting down...');
    if (watcher) await watcher.close();
    try { unlinkSync(pidFile); } catch (e) {}
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('\nShutting down (SIGTERM)...');
    if (watcher) await watcher.close();
    try { unlinkSync(pidFile); } catch (e) {}
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
