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
 * --port beats DEV_DAEMON_PORT, which beats the default in scripts/daemon-port.mjs. A daemon a
 * client spawns inherits that client's environment and resolves the port through the same
 * module, so the two cannot end up on different ports.
 *
 * Security: Binds to 127.0.0.1 only (localhost)
 */

import http from 'http';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync, rmSync, realpathSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';
import { access } from 'fs/promises';
import { isPortFree } from './port-probe.mjs';
import { resolveDaemonPort } from './daemon-port.mjs';
import { TestQueue } from './test-queue.mjs';
import {
  loadModeDefinitions,
  resolveSessionModes,
  applyModes,
  formatModeSummary,
  parseGroupList,
  sameResolvedModes,
} from './env-modes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(__dirname, '..');
const projectRoot = resolve(skillDir, '../../..');
const pidFile = resolve(skillDir, 'daemon.pid');

// Configuration
// Read at module load so a hand-started daemon honours DEV_DAEMON_PORT; `--port` still wins.
const DEFAULT_DAEMON_PORT = resolveDaemonPort();
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
    // NOT empty by default. `_app` SSR-fetches /api/user/settings on every page render and gives
    // up after APP_SETTINGS_FETCH_TIMEOUT_MS (8s). On a cold build dir that fetch is what triggers
    // the on-demand COMPILE of that route, and the compile does not fit in the budget — measured
    // on this repo at 15.4s and 28.6s — so every render in flight degrades to a signed-out page
    // and the server looks broken while being perfectly healthy.
    //
    // Compiling it once, up front, on prewarm's 300s budget removes the whole failure. Measured,
    // same worktree, same cold `.next`, four concurrent /home requests: without this, four
    // `[_app] settings bootstrap fetch failed` and the settings route taking 15.4s per render;
    // with it, zero failures and 162-200ms per render.
    //
    // It stays FIRST in the list: any page route ahead of it would trigger the same compile from
    // inside a render, which is the thing being avoided.
    prewarmRoutes: ['/api/user/settings'],
    prewarmTimeout: 300000,
    testConcurrency: 1,
    prodGroups: [],
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
        case 'TEST_CONCURRENCY': {
          // Every other setting here degrades to its default on a bad value. This one feeds a
          // constructor that throws, and the queue is built at module scope — so a typo in an
          // optional test setting would stop the daemon binding at all, taking every agent's dev
          // server with it.
          const parsed = parseInt(value, 10);
          if (Number.isInteger(parsed) && parsed >= 0) config.testConcurrency = parsed;
          else if (value) console.error(`Ignoring TEST_CONCURRENCY=${value} (want an integer >= 0)`);
          break;
        }
        case 'DEVSERVER_PROD_GROUPS':
          config.prodGroups = parseGroupList(value);
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

// Where the port scan starts. Set once from the parsed args so the session-side code paths — a
// branch switch restarting itself, a session moved off a stolen port — can reach it too.
let baseDevPort = DEFAULT_BASE_DEV_PORT;

// Windows hands back whatever drive-letter and casing the caller typed.
function samePath(a, b) {
  return process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
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

// The debounce exists so a rebase — HEAD moving several times in a second — settles before the
// session reacts. It must therefore be re-armed when HEAD moves AGAIN, and only then.
//
// Re-arming on every poll instead is a livelock, because the poll keeps seeing the same unchanged
// HEAD: `session.branch` is not updated until the switch actually runs, so with the shipped
// defaults (poll 1000ms, debounce 3000ms) the timer was cleared and re-set three times per debounce
// window and could never expire. Every consequence of a switch — `pnpm install` on a lockfile
// change, `db:generate` on a schema change, re-prewarm, even the reported branch name — was
// therefore unreachable whenever the poll interval was shorter than the debounce, which is what the
// defaults specify. `pendingHead` is what makes "moved again" distinguishable from "still moved".
export function shouldScheduleSwitch(head, branch, pendingHead) {
  if (!head) return false;
  if (head === branch) return false;
  return head !== pendingHead;
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

// Find next available port starting from base
async function findAvailablePort(basePort, usedPorts = new Set()) {
  let port = basePort;
  while (usedPorts.has(port) || !(await isPortFree(port))) {
    port++;
    if (port > basePort + 100) {
      // Reserved ports come back only when their session is stopped, so an agent reading this
      // needs to be told that is the lever, not left to conclude the machine is out of ports.
      const cli = 'node .claude/skills/dev-server/cli.mjs';
      throw new Error(
        `No available ports in ${basePort}-${basePort + 100}. ${usedPorts.size} are reserved by ` +
          `tracked sessions — \`${cli} list\` shows them, \`${cli} stop <session-id>\` releases one.`
      );
    }
  }
  return port;
}

// The reason a start failed, for the HTTP response — the session's own last error line, so the
// caller reads what the log says rather than a generic failure.
function lastErrorLog(session) {
  for (let i = session.logs.length - 1; i >= 0; i--) {
    if (session.logs[i].level === 'error') return session.logs[i].message;
  }
  return null;
}

// Session class
class DevSession {
  constructor(id, worktree, port, envPath, modeOverrides = { prod: [], dev: [] }) {
    this.id = id;
    this.worktree = worktree;
    this.port = port;
    this.envPath = envPath;
    this.modeOverrides = modeOverrides;
    // Pinned at creation. start() re-reads the skill .env for everything else, so without this an
    // edit to DEVSERVER_PROD_GROUPS would move a LIVE session onto production at its next
    // unattended restart — a branch switch or a crash — with nobody having asked for it.
    this.defaultProdGroups = [...skillConfig.prodGroups];
    this.modes = {};
    this.modeSummary = null;
    this.pendingModes = null;
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
    this.pendingHead = null;
    this.switching = false;
    this.removed = false;
    this.busyDepth = 0;
    this.lifecycleLock = Promise.resolve();
    this.prewarming = false;
    this.lockHash = null;
    this.schemaHash = null;
    this.depsBaselined = false;
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
    // A session removed while a branch switch was mid-install would otherwise reach its start and
    // spawn a dev server nothing tracks, on a port nothing reserves — the one state the whole
    // reservation model cannot see.
    if (this.removed) {
      this.addLog('info', 'Start abandoned — this session has been removed');
      return this.getStatus();
    }

    // Re-read the skill .env each start so edits to PREWARM_ROUTES et al. take effect
    // on the next branch switch instead of needing a daemon restart. Mutated in place
    // because healthCheckConfig aliases this object.
    Object.assign(skillConfig, loadSkillConfig());

    // Must match what the watcher reads, or a detached HEAD (where `git` reports the
    // literal "HEAD" and the HEAD file holds a sha) looks like a switch on every tick.
    this.branch =
      (this.headPath && readHeadRef(this.headPath)) || getGitBranch(this.worktree) || 'unknown';
    this.distDir = skillConfig.perBranchDistDir ? distDirForBranch(this.branch) : '.next';

    // Baseline the dependency hashes ONCE, on the session's first start.
    //
    // Re-baselining on every start is how a checkout gets swallowed for good. `stop()` kills the
    // poller and drops any pending switch, so a restart landing inside the debounce window — or a
    // second checkout during the `pnpm install` of the first, which also runs with the poller off
    // — arrives here with HEAD already on the new branch. Re-reading the hashes then adopts that
    // branch's lockfile as the baseline WITHOUT having installed it, and every later poll sees
    // `head === this.branch` and returns. The result is a stale `node_modules` that nothing will
    // ever reconcile: `Module not found` 500s until someone installs by hand.
    //
    // Keeping the earlier hashes instead means the mismatch survives the restart, and
    // reconcileDeps() below acts on it.
    //
    // Scope, honestly: the baseline is "what was on disk when this session first started", which is
    // only the same thing as "what was installed" if nobody checked out a branch while the daemon
    // was down. Restart the daemon after a checkout and the new session baselines the new lockfile
    // against a node_modules that was never installed for it, and nothing here notices.
    // An explicit flag, not `lockHash === null`. `fileHash` returns null on ANY read error, and
    // pnpm-lock.yaml is exactly the file another process briefly locks on Windows — one unlucky
    // read at first start would leave the baseline unset, so the next start re-baselines and
    // silently restores the swallow this is here to remove.
    if (!this.depsBaselined) {
      const lockHash = fileHash(this.lockfilePath());
      // Only claim a baseline we actually read. `fileHash` returns null on any read error, and
      // pnpm-lock.yaml is the file another process briefly locks on Windows — baselining a null
      // would make reconcileDeps() see a mismatch on the next start and run one install for
      // nothing. Leaving it unbaselined just tries again.
      if (lockHash !== null) {
        this.lockHash = lockHash;
        this.schemaHash = fileHash(this.schemaPath());
        this.depsBaselined = true;
      }
    }

    // Load environment variables
    let envVars = loadEnvFile(this.envPath);

    // The overlay goes on before the port remap, so a mode that supplies its own auth URLs still
    // gets rewritten to this session's port like any other .env value would be.
    // Cleared before anything can fail: a session that errors out must not keep reporting the
    // modes of the run before it, in `status`, `list` or the dashboard.
    this.modes = {};
    this.modeSummary = null;
    this.pendingModes = null;

    const modeDefinitions = loadModeDefinitions(skillDir);
    if (modeDefinitions.errors.length) {
      // Starting anyway on a half-parsed definitions file is how a typo becomes a session on the
      // production database that reports itself as dev. A warning in a log buffer is not a guard.
      this.status = 'error';
      for (const error of modeDefinitions.errors) {
        this.addLog('error', `env-modes.local: ${error}`);
      }
      this.addLog('error', `Refusing to start: ${modeDefinitions.path} did not parse cleanly`);
      return this.getStatus();
    }
    // The start endpoint resolves these first and rejects a bad group there. Reaching a throw here
    // means the definitions file changed under a restart, and starting on the base .env anyway
    // would be starting on an env nobody asked for — so fail visibly instead.
    let resolved;
    try {
      resolved = resolveSessionModes({
        definitions: modeDefinitions,
        prod: this.modeOverrides.prod,
        dev: this.modeOverrides.dev,
        defaultProdGroups: this.defaultProdGroups,
      });
    } catch (err) {
      this.status = 'error';
      this.addLog('error', `Env mode: ${err.message}`);
      return this.getStatus();
    }
    this.modes = resolved.modes;
    this.pendingModes = null;
    const { applied } = applyModes(envVars, modeDefinitions, this.modes);
    this.modeSummary = formatModeSummary(this.modes);
    for (const note of resolved.notes) {
      this.addLog('warn', `Env mode: ${note}`);
    }
    for (const change of applied) {
      this.addLog('info', `Env mode: ${change.group}=${change.mode} (${change.keys.join(', ')})`);
    }

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
    this.addLog('info', `Env: ${this.envPath}`);
    this.addLog('info', `Env modes: ${this.modeSummary}`);
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

    this.detachRunningProcess();

    const proc = spawn(npmCmd, ['run', 'dev'], spawnOptions);
    this.process = proc;

    this.startedAt = new Date().toISOString();
    this.stoppedAt = null;
    this.exitCode = null;
    this.status = 'running';

    this.attachProcessHandlers(proc);

    // Start health check polling if configured
    if (healthCheckConfig.healthCheckUrl) {
      this.startHealthCheck();
    }

    this.startBranchWatch();
    this.reconcileDeps();

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

  // Everything that stops or starts this session runs through here, one at a time. Two restarts
  // overlapping would have the second probe the port the first had just bound, read it as taken,
  // and move the session off a port it had only just been given.
  // `fn` must not re-enter lifecycle() on this session: it would wait on a lock it is itself
  // holding, and the session would then report busy forever with DELETE the only way out.
  lifecycle(fn) {
    // Counted, not a boolean: each queued op chains its own clear onto the lock, so with a plain
    // flag the first op's clear runs before the second op's body and the session reads idle while
    // a restart is still going. That fails in the pile-up case the flag exists for.
    this.busyDepth++;
    const done = () => {
      this.busyDepth--;
    };
    const run = this.lifecycleLock.then(fn, fn);
    this.lifecycleLock = run.then(done, done);
    return run;
  }

  get busy() {
    return this.busyDepth > 0;
  }

  // Anything still attached when a new process is about to take its place is a process this
  // session is about to stop referring to, and the exit guard would then discard even its exit.
  // Two starts can interleave — a branch switch restarting while a request takes the session over
  // — and the loser would otherwise keep running, unreachable and holding the port, for the
  // daemon's lifetime.
  detachRunningProcess() {
    if (!this.process) return;
    this.addLog('warn', 'A process was still attached at start — killing it before replacing it');
    this.killProcessTree(this.process);
    this.process = null;
  }

  attachProcessHandlers(proc) {
    proc.stdout.on('data', (data) => {
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
              // Prewarming used to happen only on the health-check path, so a checkout with no
              // skill `.env` — which is every fresh one, the file is gitignored — reached ready
              // and warmed nothing. That is exactly the configuration the settings compile
              // deadlock needs (see PREWARM_ROUTES below).
              this.prewarm();
              break;
            }
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
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

    proc.on('exit', (code, signal) => {
      this.addLog('info', `Process exited with code ${code}, signal ${signal}`);
      // Only the process this session is currently running may move its state. stop() and
      // start() both detach eagerly, so a kill that lands after either one belongs to a
      // process the session has already let go of — reporting it would mark a live session
      // crashed and leave a stale pid that Windows is free to hand to something else.
      if (this.process !== proc) return;
      this.process = null;
      this.exitCode = code;
      this.status = code === 0 ? 'stopped' : 'crashed';
      this.stoppedAt = new Date().toISOString();
      this.stopHealthCheck();
    });

    proc.on('error', (err) => {
      if (this.process !== proc) return;
      this.status = 'error';
      this.addLog('error', `Process error: ${err.message}`);
    });
  }

  killProcessTree(proc) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { shell: true });
      } else {
        process.kill(-proc.pid, 'SIGKILL');
      }
    } catch (e) {
      // A kill that fails leaves a server running while the session reports stopped, and that
      // is only diagnosable if it is written down somewhere.
      this.addLog('error', `Could not kill pid ${proc.pid}: ${e.message}`);
    }
  }

  // What the poller cannot see, because it was not running. Any restart can land on a tree whose
  // lockfile or schema no longer matches what was last installed — a stop/start inside the debounce
  // window, a second checkout during an install, a crash restart after someone switched branches.
  // Comparing the files on disk against the last INSTALLED hashes catches all of those without
  // needing to have observed the checkout that caused them.
  reconcileDeps() {
    if (this.removed || this.switching) return;
    const lockChanged = fileHash(this.lockfilePath()) !== this.lockHash;
    const schemaChanged = fileHash(this.schemaPath()) !== this.schemaHash;
    if (!lockChanged && !schemaChanged) return;
    this.addLog(
      'info',
      `${lockChanged ? 'pnpm-lock.yaml' : 'schema.full.prisma'} does not match what was last ` +
        `installed — reconciling`
    );
    // Through the ordinary switch path so it installs, regenerates and restarts exactly as a
    // watched checkout would; it is the same work, just triggered by state instead of by an event.
    this.pendingHead = null;
    clearTimeout(this.branchSwitchTimer);
    this.branchSwitchTimer = setTimeout(() => this.finishBranchSwitch(), 0);
  }

  startBranchWatch() {
    if (!skillConfig.branchWatchEnabled || !this.headPath || this.branchWatchTimer) return;

    this.branchWatchTimer = setInterval(() => {
      if (this.switching) return;
      const head = readHeadRef(this.headPath);
      if (!shouldScheduleSwitch(head, this.branch, this.pendingHead)) return;
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
    this.pendingHead = null;
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

    this.pendingHead = head;
    clearTimeout(this.branchSwitchTimer);
    this.branchSwitchTimer = setTimeout(
      () => this.finishBranchSwitch(),
      skillConfig.branchSwitchDebounce
    );
  }

  async finishBranchSwitch() {
    return this.lifecycle(() => this.runBranchSwitch());
  }

  async runBranchSwitch() {
    // A DELETE that lands after this was queued would otherwise spend minutes on an install for a
    // session nobody tracks — against a worktree `wt rm` may have just deleted — before start()
    // refuses at the end of it.
    if (this.removed) {
      // Cleared here too: this is the one exit that runs before the clear below, and leaving it set
      // would make a later switch to this same ref look like one already scheduled. Safe today only
      // because the DELETE handler stops the session first — which is a long way from this line.
      this.pendingHead = null;
      return;
    }

    clearTimeout(this.branchSwitchTimer);
    this.branchSwitchTimer = null;
    this.switching = true;
    const head = readHeadRef(this.headPath);
    // Cleared as the switch begins, not when it ends: `switching` suppresses the poll for the
    // duration, and leaving it set would make a later switch BACK to this same ref look like one
    // already scheduled.
    this.pendingHead = null;
    if (!head) {
      this.switching = false;
      return;
    }

    try {
      const from = this.branch;
      this.branch = head;
      // A rebase that lands back where it started, and reconcileDeps(), both arrive here with HEAD
      // unmoved. Saying "switch: main -> main" reads as a bug in the watcher; the work below is
      // still correct and still worth doing.
      this.addLog(
        'info',
        from === head ? `Re-checking ${head} for dependency changes` : `Branch switch: ${from} -> ${head}`
      );

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
        this.addLog('info', 'schema.full.prisma changed — regenerating client');
        await this.stop();
        await runCommand(pnpmCmd, ['run', 'db:generate'], this.worktree, env, log);
      }

      // Re-read AFTER the install, not the values captured before it. `pnpm install` can rewrite
      // pnpm-lock.yaml (a stale lock against a changed package.json, a workspace bump), and storing
      // the pre-install hash then makes reconcileDeps() see a mismatch on the way back up and run
      // the whole stop/install/restart again.
      this.lockHash = fileHash(this.lockfilePath());
      this.schemaHash = fileHash(this.schemaPath());
      this.depsBaselined = true;

      if (mustRestart) {
        await this.stop();
        this.restartCount++;
        // Same check the request-driven restarts make. This one runs unattended, so a session
        // silently coming back up on a port an orphan of its own still holds is the case nobody
        // would be watching for.
        await claimPortForReuse(this);
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
    const proc = this.process;
    if (!proc) {
      // An `error` session never had a process to stop; overwriting that with `stopped` would
      // report a failed spawn as a clean shutdown.
      if (this.status !== 'error') this.status = 'stopped';
      this.ready = false;
      return;
    }

    this.addLog('info', 'Stopping dev server...');

    // Record the outcome before killing, not from the exit code. A hard kill exits nonzero,
    // so reading the code would file every deliberate stop as a crash.
    this.process = null;
    this.ready = false;
    this.status = 'stopped';
    this.stoppedAt = new Date().toISOString();

    return new Promise((resolve) => {
      proc.once('exit', resolve);
      this.killProcessTree(proc);

      // Resolve after a short delay if process doesn't exit
      setTimeout(resolve, 500);
    });
  }

  // `claimPort` runs between the stop and the start, which is the only moment the session's own
  // process is gone and a probe of its port says something about anyone else.
  async restart(claimPort) {
    return this.lifecycle(async () => {
      await this.stop();
      this.restartCount++;
      this.logs = [];
      this.logIndex = 0;
      this.ready = false;
      this.readyAt = null;
      if (claimPort) await claimPort(this);
      return this.start();
    });
  }

  getStatus() {
    return {
      id: this.id,
      worktree: this.worktree,
      branch: this.branch,
      envPath: this.envPath,
      envModes: Object.fromEntries(
        Object.entries(this.modes).map(([group, choice]) => [group, choice.mode])
      ),
      envModeSummary: this.modeSummary,
      ...(this.pendingModes && {
        pendingEnvModes: Object.fromEntries(
          Object.entries(this.pendingModes).map(([group, choice]) => [group, choice.mode])
        ),
      }),
      distDir: this.distDir,
      switching: this.switching,
      busy: this.busy,
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
      // `::` (dual-stack), not a single literal. Bound to `127.0.0.1` these servers answered on v4 and
      // nothing on [::1]; Windows resolves `localhost` to ::1 first, so a browser typing the same `localhost`
      // URL the auth redirects use got connection-refused while curl — which falls back to v4 — reported the
      // server perfectly healthy. `localhost` is not the fix either: it resolves to ::1 *only*, which just
      // moves the outage onto every caller that hardcodes 127.0.0.1. `::` accepts v4-mapped addresses, so both
      // spellings work, and it matches what `next dev` already binds for the main app on 3000.
      proc = spawn(
        pnpmCmd,
        ['exec', 'vite', 'dev', '--host', '::', '--port', String(this.port), '--strictPort'],
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

// Spokes bind with --strictPort, so one left running past daemon exit makes the next start of
// that app fail with EADDRINUSE against a process nothing is tracking any more.
async function stopSpokeApps() {
  for (const app of spokeApps.values()) {
    if (app.status === 'running') await app.stop();
  }
}

// Session manager
const sessions = new Map();

const testQueue = new TestQueue({ concurrency: skillConfig.testConcurrency });

// A tracked session owns its port whatever its status says. Status is a report the daemon
// writes about a process it cannot see into — it has read `crashed` for a session whose
// process was alive and serving 200s, and it necessarily reads dead for the window inside
// restart() between the kill and the rebind. Handing that port to another worktree in either
// case produces an EADDRINUSE nobody can trace back to here. Membership of this map is the
// reservation, and DELETE /sessions/:id (what `cli stop` sends) is the release.
function getUsedPorts() {
  const ports = new Set();
  for (const session of sessions.values()) {
    ports.add(session.port);
  }
  return ports;
}

// Taking a session over means starting a server on the port that session owns, and its own
// orphaned process may be the thing holding that port. `next dev` does not fail on a taken port —
// it warns and moves to another one — so a session restarted onto an occupied port would report a
// URL nothing of its own is serving, and the health check would go green against whatever is.
//
// A single probe cannot tell that apart from the session's own process still dying, and defaulting
// to "stranger" is the destructive answer: it moves a healthy session off its port, which for the
// primary session on 3000 silently unhooks the rgb-proxy (hardcoded to 3000) and rewrites the auth
// URLs. Measured on this box, a killed listener releases the socket 630-668 ms after taskkill is
// spawned, and stop() waits at most 500 ms — so the naive probe reads "held" on every restart. Wait
// the port out instead, and move only when it stays held long past any plausible teardown.
const PORT_RELEASE_TIMEOUT = 8000;
const PORT_RELEASE_POLL = 250;

// Anything already under way owns this session, and a second request must report that rather than
// start a competing one. `status` alone is not enough: a restart waiting out its port reads
// `stopped` with no process for as long as the wait lasts — and a start that seems to hang is
// exactly what makes an agent run it again.
function sessionIsBusy(session) {
  return (
    session.status === 'running' ||
    session.status === 'starting' ||
    session.switching ||
    session.busy
  );
}

async function claimPortForReuse(session, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PORT_RELEASE_TIMEOUT;
  const intervalMs = opts.intervalMs ?? PORT_RELEASE_POLL;
  const scanFrom = opts.baseDevPort ?? baseDevPort;

  if (await isPortFree(session.port)) return session.port;

  session.addLog(
    'info',
    `Port ${session.port} is still held — waiting up to ${timeoutMs}ms for it to clear`
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (await isPortFree(session.port)) return session.port;
  }

  // Its own port is excluded from the reservations so that a port freeing during the scan can
  // still be handed back to the session it belongs to.
  const used = getUsedPorts();
  used.delete(session.port);
  const moved = await findAvailablePort(scanFrom, used);
  session.addLog(
    'warn',
    `Port ${session.port} is held by something this daemon does not control — moving this session to ${moved}`
  );
  session.port = moved;
  return moved;
}

function findSessionByWorktree(worktree) {
  const normalizedWorktree = resolve(worktree);
  for (const session of sessions.values()) {
    // Case-insensitively on Windows: `cli start c:/dev/...` and a session created as `C:\Dev\...`
    // are the same tree, and treating them as two would put two dev servers on it — each now
    // holding a port for the daemon's lifetime. worktree.mjs already compares this way.
    if (samePath(session.worktree, normalizedWorktree)) {
      return session;
    }
  }
  return null;
}

// A session whose worktree has been deleted still holds its port and cannot be started again, and
// this listing is where someone hunting a reserved port actually looks. The check is async because
// this runs on the daemon's only thread and the TUI polls it twice a second: a synchronous
// existsSync against a path that has gone unreachable — a network share, a dropped VPN, a stale
// reparse point — took 21s in one measurement, and every other agent's request queues behind it.
async function listSessions() {
  return Promise.all(
    Array.from(sessions.values()).map(async (s) => {
      const { exists, timedOut } = await checkPath(s.worktree);
      return {
        ...s.getStatus(),
        worktreeMissing: !exists,
        ...(timedOut && { worktreeCheckTimedOut: true }),
      };
    })
  );
}

// `access` runs on libuv's 4-slot threadpool, and one unreachable path takes 21s there — four of
// them starve every other filesystem call on the process, including the healthy worktrees in the
// same listing. Racing a timeout bounds the caller's wait but NOT the slot: the loser of a race
// keeps running. So a path gets at most one probe in flight at a time, and a settled answer is
// reused briefly — without that, the TUI polling twice a second injects two 21s jobs per second
// into a four-slot pool and it never drains.
//
// A timeout reports the worktree as present: "slow" is not evidence of deletion, and calling a
// live tree missing is the more damaging wrong answer. The caller is told the check timed out so
// it can say "could not tell" rather than "fine".
const WORKTREE_CHECK_TIMEOUT = 250;
const WORKTREE_CHECK_TTL = 2000;
const WORKTREE_CHECK_MAX_ENTRIES = 64;

const worktreeChecks = new Map();

function probePath(path) {
  const cached = worktreeChecks.get(path);
  if (cached && (cached.pending || Date.now() - cached.settledAt < WORKTREE_CHECK_TTL)) {
    return cached;
  }

  if (worktreeChecks.size >= WORKTREE_CHECK_MAX_ENTRIES) {
    for (const [key, entry] of worktreeChecks) {
      if (!entry.pending && Date.now() - entry.settledAt >= WORKTREE_CHECK_TTL) {
        worktreeChecks.delete(key);
      }
    }
  }

  const entry = { pending: true, exists: true, settledAt: 0 };
  entry.probe = access(path).then(
    () => true,
    () => false
  );
  entry.probe.then((exists) => {
    entry.exists = exists;
    entry.pending = false;
    // A miss is never slow — ENOENT comes back in microseconds — so caching one protects nothing
    // and makes a worktree created seconds after a failed start read as still missing, with the
    // error naming the path and sending the reader after the wrong thing.
    entry.settledAt = exists ? Date.now() : 0;
    if (!exists) worktreeChecks.delete(path);
  });
  worktreeChecks.set(path, entry);
  return entry;
}

async function checkPath(path) {
  const entry = probePath(path);
  if (!entry.pending) return { exists: entry.exists, timedOut: false };

  let timer;
  try {
    const timedOut = await Promise.race([
      entry.probe.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), WORKTREE_CHECK_TIMEOUT);
      }),
    ]);
    return timedOut ? { exists: true, timedOut: true } : { exists: entry.exists, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

async function pathExists(path) {
  return (await checkPath(path)).exists;
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

  baseDevPort = config.baseDevPort;

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
          sessions: await listSessions(),
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
          sessions: await listSessions(),
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

      // Test-run queue. Registered above the /sessions/:id regex so these paths are not read as
      // session ids. Deadlines are swept on every request as well as on a timer, so a queue that
      // is being polled cannot sit on a stale slot between ticks.
      if (path.startsWith('/test-runs')) {
        testQueue.sweep();

        if (path === '/test-runs' && req.method === 'GET') {
          res.writeHead(200);
          res.end(JSON.stringify({
            runs: testQueue.list(),
            concurrency: testQueue.concurrency,
            paused: testQueue.paused,
          }));
          return;
        }

        if (path === '/test-runs' && req.method === 'POST') {
          let parsed;
          try {
            parsed = JSON.parse(await readBody(req) || '{}');
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
          if (!parsed.worktree) {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: 'worktree path required',
              usage: '{ "worktree": "/path/to/worktree", "args": ["path/to/one.test.ts"] }',
            }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify(testQueue.request({
            worktree: resolve(parsed.worktree),
            args: Array.isArray(parsed.args) ? parsed.args : [],
          })));
          return;
        }

        if (path === '/test-runs/config') {
          if (req.method === 'POST') {
            let parsed;
            try {
              parsed = JSON.parse(await readBody(req) || '{}');
            } catch (e) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
              return;
            }
            try {
              testQueue.setConcurrency(parsed.concurrency);
            } catch (err) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: err.message }));
              return;
            }
          }
          res.writeHead(200);
          res.end(JSON.stringify({
            concurrency: testQueue.concurrency,
            paused: testQueue.paused,
            queued: testQueue.order.length,
            running: testQueue.running.size,
          }));
          return;
        }

        const runMatch = path.match(/^\/test-runs\/([^/]+)(\/logs)?$/);
        if (runMatch) {
          const [, runId, logsSuffix] = runMatch;

          if (logsSuffix && req.method === 'GET') {
            const since = parseInt(url.searchParams.get('since') || '-1', 10);
            const logs = testQueue.logs(runId, since);
            if (logs === null) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: 'Unknown run', id: runId }));
              return;
            }
            res.writeHead(200);
            // `dropped` rides along so a caller reading logs directly — `test logs`, a pasted
            // excerpt — can tell a fragment from a whole run. The waiters warn; this is the same
            // fact for everyone else.
            res.end(JSON.stringify({ logs, dropped: testQueue.droppedFor(runId) }));
            return;
          }

          const run =
            req.method === 'DELETE' ? testQueue.cancel(runId) :
            req.method === 'GET' ? testQueue.get(runId) : undefined;

          if (run === undefined) {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method not allowed', path }));
            return;
          }
          // The 404 is load-bearing: it is how `test wait` learns the daemon was restarted and its
          // run is gone, instead of polling for a result nobody will produce.
          if (run === null) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Unknown run', id: runId }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify(run));
          return;
        }
      }

      // GET /sessions - List all sessions
      if (path === '/sessions' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          sessions: await listSessions(),
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
        const modeOverrides = {
          prod: parseGroupList(parsed.prod),
          dev: parseGroupList(parsed.dev),
        };

        // Resolve here as well as at start, so a bad group name is a 400 with the list of real
        // ones rather than a session that exists and immediately errors.
        let requestedModes;
        try {
          // Resolve against the same config start() will, or an edited DEVSERVER_PROD_GROUPS makes
          // the two disagree and the mismatch check below compares against the wrong answer.
          Object.assign(skillConfig, loadSkillConfig());
          const definitions = loadModeDefinitions(skillDir);
          if (definitions.errors.length) {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: `${definitions.path} did not parse cleanly`,
              details: definitions.errors,
            }));
            return;
          }
          requestedModes = resolveSessionModes({
            definitions,
            prod: modeOverrides.prod,
            dev: modeOverrides.dev,
            defaultProdGroups: skillConfig.prodGroups,
          }).modes;
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
          return;
        }

        if (!worktree) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: 'worktree path required',
            usage: '{ "worktree": "/path/to/worktree", "port": 3001, "envPath": "/path/to/.env" }',
          }));
          return;
        }

        const resolvedWorktree = resolve(worktree);

        // Async for the same reason listSessions is: a synchronous stat on a path that has gone
        // unreachable blocks the daemon's only thread, and `cli start` is not worth freezing every
        // other agent's requests for.
        if (!(await pathExists(resolvedWorktree))) {
          // A tree deleted out from under its session leaves that session holding a port with no
          // way to reach it through this endpoint, so name the session rather than only the tree.
          const orphaned = findSessionByWorktree(resolvedWorktree);
          res.writeHead(400);
          res.end(JSON.stringify({
            error: `Worktree not found: ${resolvedWorktree}`,
            ...(orphaned && {
              trackedSession: orphaned.id,
              hint: `Session ${orphaned.id} still holds port ${orphaned.port} for this path — release it with \`node .claude/skills/dev-server/cli.mjs stop ${orphaned.id}\`.`,
            }),
          }));
          return;
        }

        // Check if already running for this worktree
        const existing = findSessionByWorktree(resolvedWorktree);
        if (existing && sessionIsBusy(existing)) {
          // Handing back a live session while quietly ignoring the modes just asked for is how an
          // agent ends up believing it is on dev. Refuse instead of answering a different question.
          if (
            !sameResolvedModes(existing.pendingModes ?? existing.modes, requestedModes, [
              ...modeOverrides.prod,
              ...modeOverrides.dev,
            ])
          ) {
            res.writeHead(409);
            res.end(JSON.stringify({
              error:
                `Session ${existing.id} is already running this worktree with different env modes ` +
                `(${existing.modeSummary ?? 'not yet resolved'}). Stop it first: ` +
                `node .claude/skills/dev-server/cli.mjs stop ${existing.id}`,
              session: existing.getStatus(),
            }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({
            existing: true,
            session: existing.getStatus(),
          }));
          return;
        }

        // A dead session still holds its port, so starting this worktree again has to take that
        // session over rather than strand it and pick a fresh port — otherwise every crash costs
        // a port for the life of the daemon. Only when a different port is asked for is a second
        // session created, and the old one keeps its reservation because its process may be alive.
        if (existing && (!requestedPort || requestedPort === existing.port)) {
          // Taking over a dead session takes over this request's modes with it. A bare start
          // therefore lands on dev even where the session it reuses was started with --prod,
          // which is the whole of "prod is never sticky".
          const previousOverrides = existing.modeOverrides;
          const previousDefaults = existing.defaultProdGroups;
          existing.modeOverrides = modeOverrides;
          existing.defaultProdGroups = [...skillConfig.prodGroups];
          // Stamped BEFORE the await: stop() plus the port claim can take seconds, and until
          // start() runs, `modes` would still describe the run being torn down — long enough for a
          // second agent's bare start to match it and be handed a session coming up on production.
          //
          // Kept separate from `modes` because a crashed session's process can still be alive and
          // serving on the OLD env for the length of the port wait. `modes` stays true to what is
          // running; `pendingModes` is what the next run will be, and the mismatch check reads it.
          existing.pendingModes = requestedModes;
          try {
            await existing.restart((s) => claimPortForReuse(s));
          } catch (err) {
            // A request that errored out must not leave its --prod set pinned to the session: the
            // next unattended restart — a branch switch, a crash — would then bring it up on
            // production off the back of a start that failed.
            existing.modeOverrides = previousOverrides;
            existing.defaultProdGroups = previousDefaults;
            throw err;
          } finally {
            // start() clears this on the way through, but a restart that throws — no port left in
            // the range, a failing stop() — never reaches it, and the session would then advertise
            // pending modes forever and compare the 409 guard against an env that will never exist.
            existing.pendingModes = null;
          }

          const reusedStatus = existing.getStatus();
          if (reusedStatus.status === 'error') {
            // start() reports a mode failure by setting status and RETURNING, so the catch above
            // never sees it. Without this the failed request's --prod set stays pinned, and the
            // dashboard's restart key would bring the session up on production off a start the
            // CLI reported as failed.
            existing.modeOverrides = previousOverrides;
            existing.defaultProdGroups = previousDefaults;
            res.writeHead(500);
            res.end(JSON.stringify({
              error: lastErrorLog(existing) ?? 'Session failed to restart',
              session: reusedStatus,
            }));
            return;
          }

          res.writeHead(200);
          res.end(JSON.stringify({
            existing: true,
            reused: true,
            session: reusedStatus,
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
          if (!(await isPortFree(requestedPort))) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `Port ${requestedPort} is not available` }));
            return;
          }
          port = requestedPort;
        } else {
          port = await findAvailablePort(config.baseDevPort, usedPorts);
        }

        // A worktree's own .env is the one its branch was written against. Falling back to the
        // daemon's project root hands every session whichever tree happened to launch the daemon.
        const worktreeEnvPath = resolve(resolvedWorktree, '.env');
        const resolvedEnvPath = envPath
          ? resolve(envPath)
          : // "Present" is the safe answer for the worktree and the unsafe one here: picking a
            // file that may not exist over a known-good fallback starts the server with no env at
            // all — no DATABASE_URL, no secrets — failing in a way that looks nothing like a slow
            // filesystem. So an unknown answer falls back to the main .env.
            await checkPath(worktreeEnvPath).then((r) => r.exists && !r.timedOut)
            ? worktreeEnvPath
            : mainEnvPath;

        // Create and start session
        const sessionId = generateSessionId();
        const session = new DevSession(
          sessionId,
          resolvedWorktree,
          port,
          resolvedEnvPath,
          modeOverrides
        );
        sessions.set(sessionId, session);

        const result = await session.start();

        // A start refused over its env modes is the one failure this endpoint promises to be
        // fail-closed about. Answering 201 for it makes `cli.mjs start && curl` proceed as though a
        // server came up, and the CLI exits 0.
        if (result.status === 'error') {
          res.writeHead(500);
          res.end(JSON.stringify({
            error: lastErrorLog(session) ?? 'Session failed to start',
            session: result,
          }));
          return;
        }

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
          // Queueing behind an op that never finishes hangs this request forever — the CLI's fetch
          // has no timeout either — so refuse instead. POST /sessions already short-circuits on
          // the same predicate.
          if (session.busy) {
            res.writeHead(409);
            res.end(JSON.stringify({
              error: `Session ${session.id} is busy — a start, restart or branch switch is already running.`,
              session: session.getStatus(),
            }));
            return;
          }

          await session.restart((s) => claimPortForReuse(s));

          res.writeHead(200);
          res.end(JSON.stringify({
            session: session.getStatus(),
          }));
          return;
        }

        // DELETE /sessions/:id - Stop session
        if (subPath === '' && req.method === 'DELETE') {
          // Set before stopping: a branch switch already past its own stop would otherwise start
          // a server for a session this request is in the middle of removing.
          session.removed = true;
          await session.stop();

          // A process winding down still answers, so a single busy read means nothing — only a
          // port still held on a second look is worth reporting. The session is removed either
          // way: keeping it would leave `wt stale` counting the tree as a keeper forever, and the
          // picker's probe is what stands between a leftover listener and reuse.
          let stillListening = !(await isPortFree(session.port));
          if (stillListening) {
            await new Promise((r) => setTimeout(r, 300));
            stillListening = !(await isPortFree(session.port));
          }

          sessions.delete(sessionId);

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            id: sessionId,
            ...(stillListening && {
              warning: `Port ${session.port} still has a listener after stopping this session — a process outlived the kill.`,
            }),
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
        testQueue.shutdown();
        await rgbProxy.stop();
        await authHub.stop();
        await stopSpokeApps();

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

  // Deadlines still have to advance when nobody is polling — an abandoned queue is exactly the
  // case where no requests arrive.
  const testSweeper = setInterval(() => testQueue.sweep(), 5000);
  testSweeper.unref();

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
    testQueue.shutdown();
    await rgbProxy.stop();
    await authHub.stop();
    await stopSpokeApps();
    try { unlinkSync(pidFile); } catch (e) {}
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('\nShutting down (SIGTERM)...');
    for (const session of sessions.values()) {
      await session.stop();
    }
    testQueue.shutdown();
    await rgbProxy.stop();
    await authHub.stop();
    await stopSpokeApps();
    try { unlinkSync(pidFile); } catch (e) {}
    server.close();
    process.exit(0);
  });
}

// Importing this file must not start a daemon — the tests drive DevSession and the port
// reservation directly, and a second daemon would fight the running one for its port.
// `import.meta.url` is realpathed by node and `process.argv[1]` is not, so a launch through a
// junction — which this repo's tooling creates routinely — would otherwise leave the daemon
// exiting 0 having started nothing.
function realPath(path) {
  try {
    return realpathSync(path);
  } catch (e) {
    return path;
  }
}

const invokedDirectly =
  !!process.argv[1] &&
  samePath(realPath(process.argv[1]), realPath(fileURLToPath(import.meta.url)));

if (invokedDirectly) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export {
  checkPath,
  claimPortForReuse,
  DevSession,
  findSessionByWorktree,
  getUsedPorts,
  listSessions,
  sessionIsBusy,
  sessions,
};
