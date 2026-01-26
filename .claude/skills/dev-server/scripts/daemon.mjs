#!/usr/bin/env node
/**
 * Dev Environment Daemon
 *
 * HTTP server that manages multiple Next.js dev server instances across worktrees.
 * Provides centralized log access, port management, and environment injection.
 *
 * Usage:
 *   node daemon.mjs [--port <port>] [--base-dev-port <port>]
 *
 * Security: Binds to 127.0.0.1 only (localhost)
 */

import http from 'http';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(__dirname, '..');
const projectRoot = resolve(skillDir, '../../..');
const pidFile = resolve(skillDir, 'daemon.pid');

// Configuration
const DEFAULT_DAEMON_PORT = 9444;
const DEFAULT_BASE_DEV_PORT = 3000;
const MAX_LOG_LINES = 2000;

// Load health check config from .env
function loadHealthCheckConfig() {
  const envPath = resolve(skillDir, '.env');
  const config = {
    healthCheckUrl: null,
    healthCheckStatus: 200,
    healthCheckInterval: 1000,
    healthCheckTimeout: 120000,
  };

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      switch (key.trim()) {
        case 'HEALTH_CHECK_URL':
          config.healthCheckUrl = value;
          break;
        case 'HEALTH_CHECK_STATUS':
          config.healthCheckStatus = parseInt(value, 10);
          break;
        case 'HEALTH_CHECK_INTERVAL':
          config.healthCheckInterval = parseInt(value, 10);
          break;
        case 'HEALTH_CHECK_TIMEOUT':
          config.healthCheckTimeout = parseInt(value, 10);
          break;
      }
    }
  }
  return config;
}

const healthCheckConfig = loadHealthCheckConfig();

// Ready detection patterns for log-based detection
const readyPatterns = [
  /ready on/i,
  /ready in/i,
  /started server on/i,
  /listening on/i,
];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: DEFAULT_DAEMON_PORT,
    baseDevPort: DEFAULT_BASE_DEV_PORT,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        config.port = parseInt(args[++i], 10);
        break;
      case '--base-dev-port':
        config.baseDevPort = parseInt(args[++i], 10);
        break;
    }
  }

  return config;
}

// Generate session ID
function generateSessionId() {
  return randomBytes(4).toString('hex');
}

// Update URL-related env vars to use the correct port
function updateEnvUrlsForPort(envVars, port) {
  const defaultPort = 3000;
  if (port === defaultPort) return envVars;

  // List of env vars that contain localhost URLs that need port updates
  const urlVars = [
    'NEXTAUTH_URL',
    'NEXTAUTH_URL_INTERNAL',
    'NEXT_PUBLIC_BASE_URL',
    'NEXT_PUBLIC_SERVER_DOMAIN_BLUE', // This one uses domain:port format
  ];

  for (const varName of urlVars) {
    if (envVars[varName]) {
      // Replace localhost:3000 with localhost:<port>
      envVars[varName] = envVars[varName].replace(
        /localhost:3000/g,
        `localhost:${port}`
      );
    }
  }

  // Also ensure NEXT_PUBLIC_BASE_URL is set if NEXTAUTH_URL is set
  if (!envVars.NEXT_PUBLIC_BASE_URL && envVars.NEXTAUTH_URL) {
    envVars.NEXT_PUBLIC_BASE_URL = envVars.NEXTAUTH_URL;
  }

  return envVars;
}

// Load environment variables from .env file
function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return {};

  const content = readFileSync(envPath, 'utf-8');
  const env = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      let value = match[2].trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[match[1].trim()] = value;
    }
  }

  return env;
}

// Get git branch for a directory
function getGitBranch(dir) {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (e) {
    return null;
  }
}

// Check if a port is available
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

// Find next available port starting from base
async function findAvailablePort(basePort, usedPorts = new Set()) {
  let port = basePort;
  while (usedPorts.has(port) || !(await isPortAvailable(port))) {
    port++;
    if (port > basePort + 100) {
      throw new Error('No available ports found within range');
    }
  }
  return port;
}

// Session class
class DevSession {
  constructor(id, worktree, port, envPath) {
    this.id = id;
    this.worktree = worktree;
    this.port = port;
    this.envPath = envPath;
    this.status = 'starting';
    this.process = null;
    this.logs = [];
    this.startedAt = null;
    this.stoppedAt = null;
    this.branch = null;
    this.exitCode = null;
    this.restartCount = 0;
    this.logIndex = 0;
    this.ready = false;
    this.readyAt = null;
    this.healthCheckTimer = null;
    this.healthCheckAbortController = null;
    this.healthCheckRunning = false;
  }

  addLog(level, message) {
    this.logIndex++;
    const entry = {
      index: this.logIndex,
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    this.logs.push(entry);

    // Trim old logs
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(-MAX_LOG_LINES);
    }
  }

  getLogs(since = 0, limit = 500, level = null) {
    let logs = this.logs.filter(l => l.index > since);
    if (level) {
      logs = logs.filter(l => l.level === level);
    }
    if (limit && logs.length > limit) {
      logs = logs.slice(-limit);
    }
    return logs;
  }

  async start() {
    // Get git branch
    this.branch = getGitBranch(this.worktree) || 'unknown';

    // Load environment variables
    let envVars = loadEnvFile(this.envPath);

    // Update URL-related env vars if using non-default port
    envVars = updateEnvUrlsForPort(envVars, this.port);

    // Set PORT in environment
    envVars.PORT = String(this.port);

    // Merge with current process env (for PATH, etc.)
    const env = { ...process.env, ...envVars };

    this.addLog('info', `Starting dev server on port ${this.port}`);
    this.addLog('info', `Worktree: ${this.worktree}`);
    this.addLog('info', `Branch: ${this.branch}`);

    // Spawn npm run dev
    const isWindows = process.platform === 'win32';
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';

    const spawnOptions = {
      cwd: this.worktree,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
    };

    // Use process groups on Unix for proper cleanup
    if (!isWindows) {
      spawnOptions.detached = true;
    }

    this.process = spawn(npmCmd, ['run', 'dev'], spawnOptions);

    this.startedAt = new Date().toISOString();
    this.status = 'running';

    // Handle stdout
    this.process.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        this.addLog('stdout', line);

        // Log-based ready detection (only if no health check configured)
        if (!this.ready && !healthCheckConfig.healthCheckUrl) {
          for (const pattern of readyPatterns) {
            if (pattern.test(line)) {
              this.ready = true;
              this.readyAt = new Date().toISOString();
              this.addLog('info', 'Server ready (detected from logs)');
              break;
            }
          }
        }
      }
    });

    // Handle stderr
    this.process.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Classify error levels
        const lower = line.toLowerCase();
        if (lower.includes('error') || lower.includes('failed')) {
          this.addLog('error', line);
        } else if (lower.includes('warn')) {
          this.addLog('warn', line);
        } else {
          this.addLog('stderr', line);
        }
      }
    });

    // Handle exit
    this.process.on('exit', (code, signal) => {
      this.exitCode = code;
      this.status = code === 0 ? 'stopped' : 'crashed';
      this.stoppedAt = new Date().toISOString();
      this.addLog('info', `Process exited with code ${code}, signal ${signal}`);
      this.stopHealthCheck();
    });

    this.process.on('error', (err) => {
      this.status = 'error';
      this.addLog('error', `Process error: ${err.message}`);
    });

    // Start health check polling if configured
    if (healthCheckConfig.healthCheckUrl) {
      this.startHealthCheck();
    }

    return {
      id: this.id,
      port: this.port,
      worktree: this.worktree,
      branch: this.branch,
      status: this.status,
      ready: this.ready,
    };
  }

  startHealthCheck() {
    const url = healthCheckConfig.healthCheckUrl.replace('{port}', String(this.port));
    const startTime = Date.now();
    this.healthCheckRunning = true;

    this.addLog('info', `Starting health check polling: ${url}`);

    const scheduleNextCheck = () => {
      // Don't schedule if health check has been stopped
      if (!this.healthCheckRunning) {
        return;
      }
      this.healthCheckTimer = setTimeout(check, healthCheckConfig.healthCheckInterval);
    };

    const check = async () => {
      // Early exit if health check was stopped
      if (!this.healthCheckRunning) {
        this.addLog('info', 'Health check cancelled before request');
        return;
      }

      if (this.ready || this.status !== 'running') {
        this.addLog('info', `Health check stopping: ready=${this.ready}, status=${this.status}`);
        this.stopHealthCheck();
        return;
      }

      if (Date.now() - startTime > healthCheckConfig.healthCheckTimeout) {
        this.addLog('warn', 'Health check timeout reached');
        this.stopHealthCheck();
        return;
      }

      // Create AbortController for this request
      this.healthCheckAbortController = new AbortController();

      // Per-request timeout (5 seconds) to prevent hanging on zombie servers
      // This is separate from the overall health check timeout (healthCheckTimeout)
      const REQUEST_TIMEOUT = 5000;
      const requestTimeoutId = setTimeout(() => {
        this.healthCheckAbortController?.abort();
      }, REQUEST_TIMEOUT);

      try {
        const response = await fetch(url, {
          signal: this.healthCheckAbortController.signal,
        });

        // Clear timeouts and controller after successful fetch
        clearTimeout(requestTimeoutId);
        this.healthCheckAbortController = null;

        if (response.status === healthCheckConfig.healthCheckStatus) {
          this.ready = true;
          this.readyAt = new Date().toISOString();
          this.addLog('info', 'Server ready (health check passed)');
          this.stopHealthCheck();
        } else {
          // Non-matching status, schedule next check
          scheduleNextCheck();
        }
      } catch (err) {
        clearTimeout(requestTimeoutId);
        this.healthCheckAbortController = null;

        if (err.name === 'AbortError') {
          // Check if health check was manually stopped (stopHealthCheck sets healthCheckRunning to false)
          if (!this.healthCheckRunning) {
            this.addLog('info', 'Health check request cancelled (manual stop)');
            // Don't reschedule - health check was intentionally stopped
            return;
          }
          // Per-request timeout (5s) hit - server might be slow, retry
          scheduleNextCheck();
          return;
        }

        // Server not ready yet (connection refused, etc.), schedule next check
        scheduleNextCheck();
      }
    };

    // Start with first check immediately
    check();
  }

  stopHealthCheck() {
    if (!this.healthCheckRunning) {
      return;
    }

    this.addLog('info', 'Stopping health check polling');
    this.healthCheckRunning = false;

    // Clear any pending timeout
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Abort any in-flight request
    if (this.healthCheckAbortController) {
      this.healthCheckAbortController.abort();
      this.healthCheckAbortController = null;
    }
  }

  async stop() {
    this.stopHealthCheck();
    if (!this.process) return;

    this.addLog('info', 'Stopping dev server...');

    return new Promise((resolve) => {
      this.process.once('exit', resolve);

      // Hard kill immediately
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(this.process.pid), '/f', '/t'], { shell: true });
        } else {
          process.kill(-this.process.pid, 'SIGKILL');
        }
      } catch (e) {}

      // Resolve after a short delay if process doesn't exit
      setTimeout(resolve, 500);
    });
  }

  async restart() {
    await this.stop();
    this.restartCount++;
    this.logs = [];
    this.logIndex = 0;
    this.ready = false;
    this.readyAt = null;
    return this.start();
  }

  getStatus() {
    return {
      id: this.id,
      worktree: this.worktree,
      branch: this.branch,
      port: this.port,
      status: this.status,
      ready: this.ready,
      readyAt: this.readyAt,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      exitCode: this.exitCode,
      restartCount: this.restartCount,
      logCount: this.logs.length,
      currentLogIndex: this.logIndex,
      url: `http://localhost:${this.port}`,
    };
  }

  toJSON() {
    return this.getStatus();
  }
}

// Session manager
const sessions = new Map();

function getUsedPorts() {
  const ports = new Set();
  for (const session of sessions.values()) {
    if (session.status === 'running' || session.status === 'starting') {
      ports.add(session.port);
    }
  }
  return ports;
}

function findSessionByWorktree(worktree) {
  const normalizedWorktree = resolve(worktree);
  for (const session of sessions.values()) {
    if (resolve(session.worktree) === normalizedWorktree) {
      return session;
    }
  }
  return null;
}

function listSessions() {
  return Array.from(sessions.values()).map(s => s.getStatus());
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

  // Write PID file
  writeFileSync(pidFile, String(process.pid));

  console.error(`Starting dev-server daemon...`);
  console.error(`  Daemon port: ${config.port}`);
  console.error(`  Base dev port: ${config.baseDevPort}`);
  console.error(`  Project root: ${projectRoot}`);

  // Find the main .env file
  const mainEnvPath = resolve(projectRoot, '.env');

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const path = url.pathname;

    // CORS headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
          name: 'dev-server-daemon',
          version: '1.0.0',
          status: 'running',
          pid: process.pid,
          uptime: process.uptime(),
          sessions: listSessions(),
        }));
        return;
      }

      // GET /status - Check daemon status
      if (path === '/status' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'running',
          pid: process.pid,
          uptime: process.uptime(),
          sessions: listSessions(),
          projectRoot,
          daemonPort: config.port,
          baseDevPort: config.baseDevPort,
        }));
        return;
      }

      // GET /sessions - List all sessions
      if (path === '/sessions' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          sessions: listSessions(),
        }));
        return;
      }

      // POST /sessions - Start a new dev server
      if (path === '/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(body || '{}');
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        const { worktree, port: requestedPort, envPath } = parsed;

        if (!worktree) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: 'worktree path required',
            usage: '{ "worktree": "/path/to/worktree", "port": 3001, "envPath": "/path/to/.env" }',
          }));
          return;
        }

        const resolvedWorktree = resolve(worktree);

        // Check if worktree exists
        if (!existsSync(resolvedWorktree)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Worktree not found: ${resolvedWorktree}` }));
          return;
        }

        // Check if already running for this worktree
        const existing = findSessionByWorktree(resolvedWorktree);
        if (existing && (existing.status === 'running' || existing.status === 'starting')) {
          res.writeHead(200);
          res.end(JSON.stringify({
            existing: true,
            session: existing.getStatus(),
          }));
          return;
        }

        // Determine port
        const usedPorts = getUsedPorts();
        let port;
        if (requestedPort) {
          if (usedPorts.has(requestedPort)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `Port ${requestedPort} is already in use by another session` }));
            return;
          }
          if (!(await isPortAvailable(requestedPort))) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `Port ${requestedPort} is not available` }));
            return;
          }
          port = requestedPort;
        } else {
          port = await findAvailablePort(config.baseDevPort, usedPorts);
        }

        // Determine env path
        const resolvedEnvPath = envPath ? resolve(envPath) : mainEnvPath;

        // Create and start session
        const sessionId = generateSessionId();
        const session = new DevSession(sessionId, resolvedWorktree, port, resolvedEnvPath);
        sessions.set(sessionId, session);

        const result = await session.start();

        res.writeHead(201);
        res.end(JSON.stringify({
          existing: false,
          session: session.getStatus(),
        }));
        return;
      }

      // Session-specific endpoints
      const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
      if (sessionMatch) {
        const sessionId = sessionMatch[1];
        const subPath = sessionMatch[2] || '';
        const session = sessions.get(sessionId);

        if (!session) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
          return;
        }

        // GET /sessions/:id - Get session details
        if (subPath === '' && req.method === 'GET') {
          res.writeHead(200);
          res.end(JSON.stringify({
            session: session.getStatus(),
          }));
          return;
        }

        // GET /sessions/:id/logs - Get logs
        if (subPath === '/logs' && req.method === 'GET') {
          const since = parseInt(url.searchParams.get('since') || '0', 10);
          const limit = parseInt(url.searchParams.get('limit') || '500', 10);
          const level = url.searchParams.get('level');

          const logs = session.getLogs(since, limit, level);

          res.writeHead(200);
          res.end(JSON.stringify({
            sessionId: session.id,
            currentIndex: session.logIndex,
            count: logs.length,
            logs,
          }));
          return;
        }

        // POST /sessions/:id/restart - Restart session
        if (subPath === '/restart' && req.method === 'POST') {
          const result = await session.restart();

          res.writeHead(200);
          res.end(JSON.stringify({
            session: session.getStatus(),
          }));
          return;
        }

        // DELETE /sessions/:id - Stop session
        if (subPath === '' && req.method === 'DELETE') {
          await session.stop();
          sessions.delete(sessionId);

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            id: sessionId,
          }));
          return;
        }
      }

      // POST /shutdown - Shutdown daemon
      if (path === '/shutdown' && req.method === 'POST') {
        console.error('Shutdown requested...');

        // Force stop all sessions (hard kill)
        for (const session of sessions.values()) {
          await session.stop();
        }
        sessions.clear();

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

  // Start server - bind to localhost only for security
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
    for (const session of sessions.values()) {
      await session.stop();
    }
    try { unlinkSync(pidFile); } catch (e) {}
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('\nShutting down (SIGTERM)...');
    for (const session of sessions.values()) {
      await session.stop();
    }
    try { unlinkSync(pidFile); } catch (e) {}
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
