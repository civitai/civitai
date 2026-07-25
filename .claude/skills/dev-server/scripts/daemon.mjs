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
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import { randomBytes, createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(__dirname, '..');
const projectRoot = resolve(skillDir, '../../..');
const pidFile = resolve(skillDir, 'daemon.pid');

// Configuration
const DEFAULT_DAEMON_PORT = 9444;
const DEFAULT_BASE_DEV_PORT = 3000;
const MAX_LOG_LINES = 2000;

// Load health check + RGB proxy config from .env
function loadSkillConfig() {
  const envPath = resolve(skillDir, '.env');
  const config = {
    healthCheckUrl: null,
    healthCheckStatus: 200,
    healthCheckInterval: 1000,
    healthCheckTimeout: 120000,
    rgbProxyEnabled: false,
    rgbProxyPath: '../rgb-proxy',
    authHubEnabled: false,
    authHubPath: 'apps/auth',
    authHubPort: 5173,
    branchWatchEnabled: true,
    branchWatchInterval: 1000,
    branchSwitchDebounce: 3000,
    distCacheKeep: 4,
    distCacheMaxGb: 40,
    perBranchDistDir: false,
    killOnBranchSwitch: false,
    autoInstall: true,
    prewarmRoutes: [],
    prewarmTimeout: 300000,
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
        case 'RGB_PROXY_ENABLED':
          config.rgbProxyEnabled = /^(true|1|yes|on)$/i.test(value);
          break;
        case 'RGB_PROXY_PATH':
          if (value) config.rgbProxyPath = value;
          break;
        case 'AUTH_HUB_ENABLED':
          config.authHubEnabled = /^(true|1|yes|on)$/i.test(value);
          break;
        case 'AUTH_HUB_PATH':
          if (value) config.authHubPath = value;
          break;
        case 'AUTH_HUB_PORT':
          if (value) config.authHubPort = parseInt(value, 10);
          break;
        case 'BRANCH_WATCH_ENABLED':
          config.branchWatchEnabled = /^(true|1|yes|on)$/i.test(value);
          break;
        case 'BRANCH_WATCH_INTERVAL':
          if (value) config.branchWatchInterval = parseInt(value, 10);
          break;
        case 'BRANCH_SWITCH_DEBOUNCE':
          if (value) config.branchSwitchDebounce = parseInt(value, 10);
          break;
        case 'DIST_CACHE_KEEP':
          if (value) config.distCacheKeep = parseInt(value, 10);
          break;
        case 'DIST_CACHE_MAX_GB':
          if (value) config.distCacheMaxGb = parseFloat(value);
          break;
        case 'PER_BRANCH_DIST_DIR':
          config.perBranchDistDir = /^(true|1|yes|on)$/i.test(value);
          break;
        case 'KILL_ON_BRANCH_SWITCH':
          config.killOnBranchSwitch = /^(true|1|yes|on)$/i.test(value);
          break;
        case 'AUTO_INSTALL':
          config.autoInstall = /^(true|1|yes|on)$/i.test(value);
          break;
        case 'PREWARM_ROUTES':
          config.prewarmRoutes = value
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean);
          break;
        case 'PREWARM_TIMEOUT':
          if (value) config.prewarmTimeout = parseInt(value, 10);
          break;
      }
    }
  }
  return config;
}

const skillConfig = loadSkillConfig();
const healthCheckConfig = skillConfig;

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

// Update URL-related env vars to use the correct port.
// Returns { envVars, overrides } where `overrides` lists the remapped vars for logging.
function updateEnvUrlsForPort(envVars, port) {
  const defaultPort = 3000;
  const overrides = [];
  if (port === defaultPort) return { envVars, overrides };

  // localhost:3000 → localhost:<port> (keeps scheme/path intact)
  const portUrlVars = [
    'NEXTAUTH_URL',
    'NEXTAUTH_URL_INTERNAL',
    'NEXT_PUBLIC_BASE_URL',
    'SERVER_DOMAIN_BLUE',
  ];
  for (const varName of portUrlVars) {
    if (envVars[varName] && envVars[varName].includes('localhost:3000')) {
      const before = envVars[varName];
      envVars[varName] = before.replace(/localhost:3000/g, `localhost:${port}`);
      overrides.push(`${varName}: ${before} -> ${envVars[varName]}`);
    }
  }

  // If auth URLs point at a non-localhost host (e.g. civitai-dev.blue via an rgb-proxy
  // that only backs the default port), OAuth cookies won't be scoped to this session's
  // port. Force auth URLs to localhost:<port> so credentials-based logins (e.g. the
  // /testing/testing-login page) work on secondary sessions without the user manually
  // maintaining a per-worktree .env.
  const localhostOverrideVars = ['NEXTAUTH_URL', 'NEXTAUTH_URL_INTERNAL', 'NEXT_PUBLIC_BASE_URL'];
  const localhostUrl = `http://localhost:${port}`;
  for (const varName of localhostOverrideVars) {
    const current = envVars[varName];
    if (current && !current.includes(`localhost:${port}`)) {
      envVars[varName] = localhostUrl;
      overrides.push(`${varName}: ${current} -> ${localhostUrl}`);
    }
  }

  // Also ensure NEXT_PUBLIC_BASE_URL is set if NEXTAUTH_URL is set
  if (!envVars.NEXT_PUBLIC_BASE_URL && envVars.NEXTAUTH_URL) {
    envVars.NEXT_PUBLIC_BASE_URL = envVars.NEXTAUTH_URL;
  }

  return { envVars, overrides };
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

// Locate a worktree's HEAD file. In a linked worktree `.git` is a file pointing at
// the real gitdir, and that gitdir has its own HEAD — the shared one never moves.
function resolveGitHeadPath(dir) {
  const dotGit = resolve(dir, '.git');
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return resolve(dotGit, 'HEAD');
  const match = readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  return resolve(dir, match[1].trim(), 'HEAD');
}

// Branch name (or short sha when detached) straight off HEAD — no git subprocess,
// so it's cheap enough to poll every second.
function readHeadRef(headPath) {
  try {
    const raw = readFileSync(headPath, 'utf-8').trim();
    const match = raw.match(/^ref:\s*refs\/heads\/(.+)$/);
    return match ? match[1] : raw.slice(0, 12);
  } catch (e) {
    return null;
  }
}

function branchSlug(branch) {
  const safe = branch.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const digest = createHash('sha1').update(branch).digest('hex').slice(0, 6);
  return `${safe.slice(0, 48) || 'detached'}-${digest}`;
}

const distRoot = 'branches';

function distDirForBranch(branch) {
  return `.next/${distRoot}/${branchSlug(branch)}`;
}

function fileHash(path) {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch (e) {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    let entries;
    try {
      entries = readdirSync(stack.pop(), { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += statSync(full).size;
        } catch (e) {}
      }
    }
  }
  return total;
}

// Evict least-recently-used per-branch build dirs until both budgets hold: at most
// `keep` dirs, and at most `maxBytes` total. The size cap is the one that matters —
// Turbopack's store grows ~1GB per route compiled and re-grows on every restart, so
// a count-only cap bounds nothing. The live dir is never evicted.
function pruneDistDirs(worktree, keepDir, keep, maxBytes, log) {
  const root = resolve(worktree, '.next', distRoot);
  if (!existsSync(root)) return;
  const active = resolve(worktree, keepDir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return;
  }

  const dirs = entries
    .map((e) => resolve(root, e.name))
    .map((p) => ({ path: p, mtime: statSync(p).mtimeMs, size: dirSize(p) }))
    .sort((a, b) => b.mtime - a.mtime);

  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  let total = dirs.reduce((sum, d) => sum + d.size, 0);
  log?.('info', `Build cache: ${dirs.length} branch dirs, ${gb(total)} GB total`);

  const evict = (d, why) => {
    try {
      rmSync(d.path, { recursive: true, force: true });
      total -= d.size;
      log?.('info', `Evicted ${d.path.replace(worktree, '.')} (${gb(d.size)} GB, ${why})`);
    } catch (e) {
      log?.('warn', `Could not evict ${d.path}: ${e.message}`);
    }
  };

  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (d.path === active) continue;
    if (keep > 0 && i >= keep) evict(d, 'over count');
    else if (maxBytes > 0 && total > maxBytes) evict(d, 'over size budget');
  }

  if (maxBytes > 0 && total > maxBytes) {
    log?.(
      'warn',
      `Active branch cache alone is ${gb(total)} GB, over the ${gb(maxBytes)} GB budget — ` +
        `delete .next/${distRoot} if disk is tight`
    );
  }
}

// Run a package-manager command to completion, streaming into the session log.
function runCommand(cmd, args, cwd, env, log) {
  return new Promise((done) => {
    log('info', `> ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const pipe = (stream, level) =>
      stream.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          if (line.trim()) log(level, line.trim());
        }
      });
    pipe(child.stdout, 'stdout');
    pipe(child.stderr, 'stderr');
    child.on('exit', (code) => {
      log(code === 0 ? 'info' : 'error', `${cmd} exited with code ${code}`);
      done(code);
    });
    child.on('error', (err) => {
      log('error', `${cmd} failed to start: ${err.message}`);
      done(-1);
    });
  });
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
    this.distDir = null;
    this.headPath = resolveGitHeadPath(worktree);
    this.branchWatchTimer = null;
    this.branchSwitchTimer = null;
    this.switching = false;
    this.prewarming = false;
    this.lockHash = null;
    this.schemaHash = null;
  }

  lockfilePath() {
    return resolve(this.worktree, 'pnpm-lock.yaml');
  }

  // The authored schema, not `prisma/schema.prisma` — that one is a generated artifact
  // (scripts/generate-slim-schema.js strips @no-type models out of schema.full.prisma),
  // so watching it misses schema changes that arrive with a checkout and leaves the
  // Prisma client stale.
  schemaPath() {
    return resolve(
      this.worktree,
      'packages',
      'civitai-db-schema',
      'prisma',
      'schema.full.prisma'
    );
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
    // Re-read the skill .env each start so edits to PREWARM_ROUTES et al. take effect
    // on the next branch switch instead of needing a daemon restart. Mutated in place
    // because healthCheckConfig aliases this object.
    Object.assign(skillConfig, loadSkillConfig());

    // Must match what the watcher reads, or a detached HEAD (where `git` reports the
    // literal "HEAD" and the HEAD file holds a sha) looks like a switch on every tick.
    this.branch =
      (this.headPath && readHeadRef(this.headPath)) || getGitBranch(this.worktree) || 'unknown';
    this.distDir = skillConfig.perBranchDistDir ? distDirForBranch(this.branch) : '.next';
    this.lockHash = fileHash(this.lockfilePath());
    this.schemaHash = fileHash(this.schemaPath());

    // Load environment variables
    let envVars = loadEnvFile(this.envPath);

    // Update URL-related env vars if using non-default port
    const { envVars: remapped, overrides } = updateEnvUrlsForPort(envVars, this.port);
    envVars = remapped;
    for (const override of overrides) {
      this.addLog('info', `Env remap: ${override}`);
    }

    // Set PORT in environment
    envVars.PORT = String(this.port);
    envVars.NEXT_DIST_DIR = this.distDir;

    // Merge with current process env (for PATH, etc.)
    const env = { ...process.env, ...envVars };

    this.addLog('info', `Starting dev server on port ${this.port}`);
    this.addLog('info', `Worktree: ${this.worktree}`);
    this.addLog('info', `Branch: ${this.branch}`);
    this.addLog('info', `Build dir: ${this.distDir}`);

    if (skillConfig.perBranchDistDir) {
      pruneDistDirs(
        this.worktree,
        this.distDir,
        skillConfig.distCacheKeep,
        skillConfig.distCacheMaxGb * 1024 ** 3,
        (l, m) => this.addLog(l, m)
      );
    }

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

    this.startBranchWatch();

    return {
      id: this.id,
      port: this.port,
      worktree: this.worktree,
      branch: this.branch,
      distDir: this.distDir,
      status: this.status,
      ready: this.ready,
    };
  }

  startBranchWatch() {
    if (!skillConfig.branchWatchEnabled || !this.headPath || this.branchWatchTimer) return;

    this.branchWatchTimer = setInterval(() => {
      if (this.switching) return;
      const head = readHeadRef(this.headPath);
      if (!head || head === this.branch) return;
      this.onHeadChanged(head);
    }, skillConfig.branchWatchInterval);
    this.branchWatchTimer.unref?.();
  }

  stopBranchWatch() {
    if (this.branchWatchTimer) {
      clearInterval(this.branchWatchTimer);
      this.branchWatchTimer = null;
    }
    if (this.branchSwitchTimer) {
      clearTimeout(this.branchSwitchTimer);
      this.branchSwitchTimer = null;
    }
  }

  // HEAD moved. Measured: leaving the server up through a checkout beats killing it —
  // its in-memory graph survives, so only what actually changed recompiles (~8s vs a
  // ~43s cold start), and routes it isn't asked for stay warm. So do nothing here but
  // wait for the tree to settle. A restart is only forced when node_modules or the
  // Prisma client must change underneath it (see finishBranchSwitch).
  onHeadChanged(head) {
    if (!this.branchSwitchTimer) {
      this.addLog('info', `HEAD moved to ${head} — waiting for checkout to settle`);
      if (skillConfig.killOnBranchSwitch) {
        this.addLog('info', 'KILL_ON_BRANCH_SWITCH set — stopping dev server');
        this.stopHealthCheck();
        this.ready = false;
        this.readyAt = null;
        this.stop().catch(() => {});
      }
    }

    clearTimeout(this.branchSwitchTimer);
    this.branchSwitchTimer = setTimeout(
      () => this.finishBranchSwitch(),
      skillConfig.branchSwitchDebounce
    );
  }

  async finishBranchSwitch() {
    this.branchSwitchTimer = null;
    this.switching = true;
    const head = readHeadRef(this.headPath);
    if (!head) {
      this.switching = false;
      return;
    }

    try {
      const from = this.branch;
      this.branch = head;
      this.addLog('info', `Branch switch: ${from} -> ${head}`);

      const env = { ...process.env, ...loadEnvFile(this.envPath) };
      const log = (l, m) => this.addLog(l, m);
      const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

      const lockHash = fileHash(this.lockfilePath());
      const schemaHash = fileHash(this.schemaPath());
      const lockChanged = lockHash !== this.lockHash;
      const schemaChanged = schemaHash !== this.schemaHash;

      // Only these force a restart: the running process has node_modules and the
      // generated Prisma client resolved in memory, and neither can be swapped under
      // it. Everything else the dev server recompiles on its own, faster than a
      // restart would.
      const mustRestart = skillConfig.killOnBranchSwitch || lockChanged || schemaChanged;

      if (skillConfig.autoInstall && lockChanged) {
        this.addLog('info', 'pnpm-lock.yaml changed — installing');
        await this.stop();
        // postinstall runs db:generate, so a schema change needs no separate pass.
        await runCommand(pnpmCmd, ['install', '--prefer-offline'], this.worktree, env, log);
      } else if (skillConfig.autoInstall && schemaChanged) {
        this.addLog('info', 'prisma/schema.prisma changed — regenerating client');
        await this.stop();
        await runCommand(pnpmCmd, ['run', 'db:generate'], this.worktree, env, log);
      }

      this.lockHash = lockHash;
      this.schemaHash = schemaHash;

      if (mustRestart) {
        await this.stop();
        this.restartCount++;
        this.switching = false;
        await this.start();
        return;
      }

      // Server kept running: nothing to restart, just recompile the routes you use
      // so the switch cost lands on the daemon rather than your next click.
      this.switching = false;
      if (skillConfig.perBranchDistDir) {
        this.addLog(
          'warn',
          'PER_BRANCH_DIST_DIR is set but the server was not restarted — it keeps the ' +
            'build dir it started with. Per-branch dirs only apply on restart.'
        );
      }
      await this.prewarm();
    } catch (err) {
      this.switching = false;
      this.addLog('error', `Branch switch failed: ${err.message}`);
    }
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
          this.prewarm();
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

  // Compile the routes you actually open, in the background, right after the server
  // comes up. Cold-compiling this app's graph costs ~50s on the first route; the point
  // is that the daemon eats that while you're still reading the diff, not you when you
  // click. Sequential on purpose — parallel requests just contend for the same
  // compiler and make the first route land later.
  async prewarm() {
    const routes = skillConfig.prewarmRoutes;
    if (!routes.length || this.prewarming) return;

    this.prewarming = true;
    const startedFor = this.branch;
    this.addLog('info', `Prewarming ${routes.length} route(s): ${routes.join(', ')}`);

    for (const route of routes) {
      // A branch switch or shutdown mid-prewarm makes the rest pointless.
      if (!this.prewarming || this.branch !== startedFor || this.status !== 'running') {
        this.addLog('info', 'Prewarm abandoned (session moved on)');
        break;
      }
      const started = Date.now();
      try {
        const res = await fetch(`http://localhost:${this.port}${route}`, {
          signal: AbortSignal.timeout(skillConfig.prewarmTimeout),
        });
        this.addLog('info', `Prewarmed ${route} -> ${res.status} in ${Date.now() - started}ms`);
      } catch (err) {
        this.addLog('warn', `Prewarm ${route} failed after ${Date.now() - started}ms: ${err.message}`);
      }
    }

    this.prewarming = false;
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
    this.stopBranchWatch();
    this.prewarming = false;
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
      distDir: this.distDir,
      switching: this.switching,
      prewarming: this.prewarming,
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

// RGB proxy manager — reverse proxy for civitai-dev.{red,green,blue}
class RgbProxy {
  constructor(proxyPath) {
    this.path = resolve(projectRoot, proxyPath);
    this.process = null;
    this.status = 'stopped'; // stopped | starting | running | crashed | error | disabled
    this.logs = [];
    this.logIndex = 0;
    this.startedAt = null;
    this.stoppedAt = null;
    this.exitCode = null;
    this.lastError = null;
  }

  addLog(level, message) {
    this.logIndex++;
    this.logs.push({ index: this.logIndex, timestamp: new Date().toISOString(), level, message });
    if (this.logs.length > MAX_LOG_LINES) this.logs = this.logs.slice(-MAX_LOG_LINES);
  }

  getLogs(since = 0, limit = 500) {
    let logs = this.logs.filter(l => l.index > since);
    if (limit && logs.length > limit) logs = logs.slice(-limit);
    return logs;
  }

  start() {
    if (this.process) {
      this.addLog('info', 'RGB proxy already running');
      return this.getStatus();
    }

    if (!existsSync(this.path)) {
      this.status = 'error';
      this.lastError = `RGB proxy path not found: ${this.path}`;
      this.addLog('error', this.lastError);
      return this.getStatus();
    }

    if (!existsSync(resolve(this.path, 'node_modules'))) {
      this.status = 'error';
      this.lastError = `RGB proxy dependencies not installed. Run: cd ${this.path} && npm install`;
      this.addLog('error', this.lastError);
      return this.getStatus();
    }

    this.status = 'starting';
    this.lastError = null;
    this.addLog('info', `Starting RGB proxy: ${this.path}`);

    const isWindows = process.platform === 'win32';
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';

    const spawnOptions = {
      cwd: this.path,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
    };
    if (!isWindows) spawnOptions.detached = true;

    try {
      this.process = spawn(npmCmd, ['start'], spawnOptions);
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      this.addLog('error', `Spawn failed: ${err.message}`);
      return this.getStatus();
    }

    this.startedAt = new Date().toISOString();
    this.status = 'running';

    this.process.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) this.addLog('stdout', line);
    });

    this.process.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (lower.includes('eacces') || lower.includes('permission denied')) {
          this.lastError = 'Permission denied binding 80/443. Relaunch daemon as Administrator (Windows) or with sudo (macOS/Linux).';
          this.addLog('error', this.lastError);
        } else if (lower.includes('eaddrinuse')) {
          this.lastError = 'Ports 80/443 already in use. Stop conflicting process first.';
          this.addLog('error', this.lastError);
        } else if (lower.includes('error') || lower.includes('failed')) {
          this.addLog('error', line);
        } else {
          this.addLog('stderr', line);
        }
      }
    });

    this.process.on('exit', (code, signal) => {
      this.exitCode = code;
      this.status = code === 0 ? 'stopped' : 'crashed';
      this.stoppedAt = new Date().toISOString();
      this.addLog('info', `RGB proxy exited (code=${code}, signal=${signal})`);
      this.process = null;
    });

    this.process.on('error', (err) => {
      this.status = 'error';
      this.lastError = err.message;
      this.addLog('error', `Process error: ${err.message}`);
    });

    return this.getStatus();
  }

  async stop() {
    if (!this.process) {
      this.status = 'stopped';
      return this.getStatus();
    }

    this.addLog('info', 'Stopping RGB proxy...');
    const proc = this.process;

    return new Promise((resolve) => {
      proc.once('exit', () => resolve(this.getStatus()));
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { shell: true });
        } else {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch (e) {}
      setTimeout(() => resolve(this.getStatus()), 500);
    });
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  getStatus() {
    return {
      enabled: skillConfig.rgbProxyEnabled,
      status: this.status,
      path: this.path,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      exitCode: this.exitCode,
      lastError: this.lastError,
      logCount: this.logs.length,
      currentLogIndex: this.logIndex,
      domains: [
        'https://civitai-dev.green',
        'https://civitai-dev.blue',
        'https://civitai-dev.red',
      ],
    };
  }
}

const rgbProxy = new RgbProxy(skillConfig.rgbProxyPath);

// Auth hub manager — the centralized login hub (apps/auth, SvelteKit + Vite). The main app is
// verify-only now (docs/main-app-auth-cutover.md), so a fresh login in dev needs the hub running.
// It reads its OWN apps/auth/.env (Vite loads it), so we don't inject env here — just spawn it and
// track logs/status. Ready is detected from Vite's startup line; a JWKS probe confirms it's live.
class AuthHub {
  constructor(hubPath, port) {
    this.path = resolve(projectRoot, hubPath);
    this.port = port;
    this.process = null;
    this.status = 'stopped'; // stopped | starting | running | crashed | error | disabled
    this.ready = false;
    this.readyAt = null;
    this.logs = [];
    this.logIndex = 0;
    this.startedAt = null;
    this.stoppedAt = null;
    this.exitCode = null;
    this.lastError = null;
  }

  addLog(level, message) {
    this.logIndex++;
    this.logs.push({ index: this.logIndex, timestamp: new Date().toISOString(), level, message });
    if (this.logs.length > MAX_LOG_LINES) this.logs = this.logs.slice(-MAX_LOG_LINES);
  }

  getLogs(since = 0, limit = 500) {
    let logs = this.logs.filter(l => l.index > since);
    if (limit && logs.length > limit) logs = logs.slice(-limit);
    return logs;
  }

  start() {
    if (this.process) {
      this.addLog('info', 'Auth hub already running');
      return this.getStatus();
    }

    if (!existsSync(this.path)) {
      this.status = 'error';
      this.lastError = `Auth hub path not found: ${this.path}`;
      this.addLog('error', this.lastError);
      return this.getStatus();
    }

    if (!existsSync(resolve(this.path, '.env'))) {
      this.status = 'error';
      this.lastError = `Auth hub .env missing: ${resolve(this.path, '.env')}. See SKILL.md (Auth Hub setup).`;
      this.addLog('error', this.lastError);
      return this.getStatus();
    }

    if (!existsSync(resolve(this.path, 'node_modules'))) {
      this.status = 'error';
      this.lastError = `Auth hub dependencies not installed. Run: pnpm install`;
      this.addLog('error', this.lastError);
      return this.getStatus();
    }

    this.status = 'starting';
    this.ready = false;
    this.readyAt = null;
    this.lastError = null;
    this.addLog('info', `Starting auth hub on port ${this.port}: ${this.path}`);

    const isWindows = process.platform === 'win32';
    const pnpmCmd = isWindows ? 'pnpm.cmd' : 'pnpm';

    const spawnOptions = {
      cwd: this.path,
      env: process.env, // Vite loads apps/auth/.env itself — no injection
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
    };
    if (!isWindows) spawnOptions.detached = true;

    let proc;
    try {
      proc = spawn(
        pnpmCmd,
        ['exec', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(this.port), '--strictPort'],
        spawnOptions
      );
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      this.addLog('error', `Spawn failed: ${err.message}`);
      return this.getStatus();
    }
    this.process = proc;

    this.startedAt = new Date().toISOString();
    this.stoppedAt = null;
    this.exitCode = null;
    this.status = 'running';

    const markReady = () => {
      if (this.ready) return;
      this.ready = true;
      this.readyAt = new Date().toISOString();
      this.addLog('info', `Auth hub ready on http://localhost:${this.port}`);
    };

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        this.addLog('stdout', line);
        if (!this.ready && (/ready in/i.test(line) || /localhost:\s*\d+/i.test(line))) markReady();
      }
    });

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (lower.includes('eaddrinuse')) {
          this.lastError = `Port ${this.port} already in use. Stop the conflicting process first.`;
          this.addLog('error', this.lastError);
        } else if (lower.includes('error') || lower.includes('failed')) {
          this.addLog('error', line);
        } else {
          this.addLog('stderr', line);
        }
      }
    });

    proc.on('exit', (code, signal) => {
      this.exitCode = code;
      this.addLog('info', `Auth hub exited (code=${code}, signal=${signal})`);
      // Only mutate shared state if this is still the CURRENT process. A restart may have already
      // replaced it (Vite also self-restarts on .env change) — a late exit must not clobber the new one.
      if (this.process === proc) {
        this.status = code === 0 ? 'stopped' : 'crashed';
        this.ready = false;
        this.stoppedAt = new Date().toISOString();
        this.process = null;
      }
    });

    proc.on('error', (err) => {
      if (this.process !== proc) return;
      this.status = 'error';
      this.lastError = err.message;
      this.addLog('error', `Process error: ${err.message}`);
    });

    return this.getStatus();
  }

  async stop() {
    const proc = this.process;
    if (!proc) {
      this.status = 'stopped';
      this.ready = false;
      return this.getStatus();
    }

    this.addLog('info', 'Stopping auth hub...');
    // Detach eagerly so a subsequent start() never sees a stale process (the exit handler is guarded on
    // identity, so the late exit of this proc won't touch the fresh one).
    this.process = null;
    this.ready = false;
    this.status = 'stopped';
    this.stoppedAt = new Date().toISOString();

    return new Promise((resolve) => {
      proc.once('exit', () => resolve(this.getStatus()));
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { shell: true });
        } else {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch (e) {}
      setTimeout(() => resolve(this.getStatus()), 800);
    });
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  getStatus() {
    return {
      enabled: skillConfig.authHubEnabled,
      status: this.status,
      ready: this.ready,
      readyAt: this.readyAt,
      path: this.path,
      port: this.port,
      url: `http://localhost:${this.port}`,
      jwksUrl: `http://localhost:${this.port}/api/auth/jwks`,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      exitCode: this.exitCode,
      lastError: this.lastError,
      logCount: this.logs.length,
      currentLogIndex: this.logIndex,
    };
  }
}

const authHub = new AuthHub(skillConfig.authHubPath, skillConfig.authHubPort);

// Every other SvelteKit app under apps/ runs the same way the auth hub does: `vite dev` in the app
// directory, vite loads that app's own .env. AuthHub already encodes all of that plus the readiness
// parsing, crash handling and log ring buffer, so a spoke is an AuthHub with a different label.
//
// Ports are fixed per app rather than auto-assigned so a redirect between two of them (moderator ->
// auth) always lands on the same place, and so `--strictPort` fails loudly on a collision instead of
// silently drifting to the next free port.
const SPOKE_APPS = {
  moderator: { path: 'apps/moderator', port: 5174 },
  'creator-studio': { path: 'apps/creator-studio', port: 5175 },
  storage: { path: 'apps/storage', port: 5176 },
  notifications: { path: 'apps/notifications', port: 5177 },
};

class SpokeApp extends AuthHub {
  constructor(name, appPath, port) {
    super(appPath, port);
    this.name = name;
  }

  getStatus() {
    return { ...super.getStatus(), name: this.name, enabled: true };
  }
}

const spokeApps = new Map(
  Object.entries(SPOKE_APPS).map(([name, cfg]) => [name, new SpokeApp(name, cfg.path, cfg.port)])
);


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
          rgbProxy: rgbProxy.getStatus(),
          authHub: authHub.getStatus(),
          projectRoot,
          daemonPort: config.port,
          baseDevPort: config.baseDevPort,
        }));
        return;
      }

      // GET /rgb - RGB proxy status
      if (path === '/rgb' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(rgbProxy.getStatus()));
        return;
      }

      // GET /rgb/logs - RGB proxy logs
      if (path === '/rgb/logs' && req.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const limit = parseInt(url.searchParams.get('limit') || '500', 10);
        res.writeHead(200);
        res.end(JSON.stringify({
          currentIndex: rgbProxy.logIndex,
          logs: rgbProxy.getLogs(since, limit),
        }));
        return;
      }

      // POST /rgb/start - Start RGB proxy
      if (path === '/rgb/start' && req.method === 'POST') {
        const status = rgbProxy.start();
        res.writeHead(status.status === 'error' ? 500 : 200);
        res.end(JSON.stringify(status));
        return;
      }

      // POST /rgb/stop - Stop RGB proxy
      if (path === '/rgb/stop' && req.method === 'POST') {
        const status = await rgbProxy.stop();
        res.writeHead(200);
        res.end(JSON.stringify(status));
        return;
      }

      // POST /rgb/restart - Restart RGB proxy
      if (path === '/rgb/restart' && req.method === 'POST') {
        const status = await rgbProxy.restart();
        res.writeHead(200);
        res.end(JSON.stringify(status));
        return;
      }

      // /app/<name>[/logs|/start|/stop|/restart] - spoke app control
      if (path === '/apps' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          apps: [...spokeApps.values()].map((a) => a.getStatus()),
        }));
        return;
      }

      if (path.startsWith('/app/')) {
        const [, , name, action] = path.split('/');
        const app = spokeApps.get(name);
        if (!app) {
          res.writeHead(404);
          res.end(JSON.stringify({
            error: `Unknown app: ${name}`,
            available: [...spokeApps.keys()],
          }));
          return;
        }

        if (!action && req.method === 'GET') {
          res.writeHead(200);
          res.end(JSON.stringify(app.getStatus()));
          return;
        }
        if (action === 'logs' && req.method === 'GET') {
          const since = parseInt(url.searchParams.get('since') || '0', 10);
          const limit = parseInt(url.searchParams.get('limit') || '500', 10);
          res.writeHead(200);
          res.end(JSON.stringify({ currentIndex: app.logIndex, logs: app.getLogs(since, limit) }));
          return;
        }
        if (action === 'start' && req.method === 'POST') {
          const status = app.start();
          res.writeHead(status.status === 'error' ? 500 : 200);
          res.end(JSON.stringify(status));
          return;
        }
        if (action === 'stop' && req.method === 'POST') {
          const status = await app.stop();
          res.writeHead(200);
          res.end(JSON.stringify(status));
          return;
        }
        if (action === 'restart' && req.method === 'POST') {
          const status = await app.restart();
          res.writeHead(status.status === 'error' ? 500 : 200);
          res.end(JSON.stringify(status));
          return;
        }
      }

      // GET /auth - Auth hub status
      if (path === '/auth' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(authHub.getStatus()));
        return;
      }

      // GET /auth/logs - Auth hub logs
      if (path === '/auth/logs' && req.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const limit = parseInt(url.searchParams.get('limit') || '500', 10);
        res.writeHead(200);
        res.end(JSON.stringify({
          currentIndex: authHub.logIndex,
          logs: authHub.getLogs(since, limit),
        }));
        return;
      }

      // POST /auth/start - Start auth hub
      if (path === '/auth/start' && req.method === 'POST') {
        const status = authHub.start();
        res.writeHead(status.status === 'error' ? 500 : 200);
        res.end(JSON.stringify(status));
        return;
      }

      // POST /auth/stop - Stop auth hub
      if (path === '/auth/stop' && req.method === 'POST') {
        const status = await authHub.stop();
        res.writeHead(200);
        res.end(JSON.stringify(status));
        return;
      }

      // POST /auth/restart - Restart auth hub
      if (path === '/auth/restart' && req.method === 'POST') {
        const status = await authHub.restart();
        res.writeHead(status.status === 'error' ? 500 : 200);
        res.end(JSON.stringify(status));
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
        await rgbProxy.stop();
        await authHub.stop();

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

    if (skillConfig.rgbProxyEnabled) {
      console.error('RGB_PROXY_ENABLED=true — starting RGB proxy...');
      rgbProxy.start();
    }

    if (skillConfig.authHubEnabled) {
      console.error('AUTH_HUB_ENABLED=true — starting auth hub...');
      authHub.start();
    }

    // Output ready signal to stdout for parsing
    console.log(JSON.stringify({
      type: 'daemon_ready',
      port: config.port,
      pid: process.pid,
      projectRoot,
      rgbProxy: rgbProxy.getStatus(),
      authHub: authHub.getStatus(),
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
    await rgbProxy.stop();
    await authHub.stop();
    try { unlinkSync(pidFile); } catch (e) {}
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('\nShutting down (SIGTERM)...');
    for (const session of sessions.values()) {
      await session.stop();
    }
    await rgbProxy.stop();
    await authHub.stop();
    try { unlinkSync(pidFile); } catch (e) {}
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
