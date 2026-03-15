#!/usr/bin/env node
/**
 * Dev Server Console — TUI Dashboard
 *
 * Interactive terminal UI for monitoring and managing Next.js dev servers.
 * Features log filtering by level, text search, and keyboard shortcuts.
 * The server continues running after you disconnect (q / Ctrl+C).
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return startDir;
}

const projectRoot = findProjectRoot(__dirname);
const pidFile = resolve(__dirname, 'daemon.pid');
const serverScript = resolve(__dirname, 'scripts/daemon.mjs');

const DAEMON_PORT = 9444;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

// ── ANSI ──────────────────────────────────────────────────────────────────────
const C = {
  r: '\x1b[0m',
  b: '\x1b[1m',
  d: '\x1b[2m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  grn: '\x1b[32m',
  ylw: '\x1b[33m',
  blu: '\x1b[34m',
  mag: '\x1b[35m',
  cyn: '\x1b[36m',
  wht: '\x1b[37m',
  bgBlu: '\x1b[44m',
  bgRed: '\x1b[41m',
};

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CUR_HIDE = '\x1b[?25l';
const CUR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLR_LINE = '\x1b[2K';
const CLR_BELOW = '\x1b[J';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\\\\/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

function log(msg) { console.log(msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Daemon communication ──────────────────────────────────────────────────────
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

async function isDaemonRunning() {
  const result = await daemonRequest('/');
  return result.ok;
}

async function startDaemon() {
  const command = `"${process.execPath}" "${serverScript}"`;
  const child = spawn(command, [], {
    detached: true, stdio: 'ignore', cwd: projectRoot, windowsHide: true, shell: true,
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await isDaemonRunning()) return true;
  }
  return false;
}

async function ensureDaemon() {
  if (await isDaemonRunning()) return true;
  log(`${C.dim}Starting daemon...${C.r}`);
  const started = await startDaemon();
  if (!started) {
    log(`${C.red}Failed to start daemon${C.r}`);
    process.exit(1);
  }
  return true;
}

// ── Non-interactive commands (kept for backwards compat) ──────────────────────
async function listSessionsCli() {
  await ensureDaemon();
  const result = await daemonRequest('/sessions');
  if (!result.ok) { log(`${C.red}Error: ${result.error || result.data?.error}${C.r}`); process.exit(1); }
  const sessions = result.data.sessions;
  if (!sessions.length) { log(`${C.dim}No running sessions${C.r}`); return null; }
  log(`\n${C.b}Running Sessions:${C.r}\n`);
  sessions.forEach((s, i) => {
    const status = s.status === 'running' ? `${C.grn}running${C.r}` : `${C.ylw}${s.status}${C.r}`;
    const ready = s.ready ? `${C.grn}ready${C.r}` : `${C.ylw}starting${C.r}`;
    log(`  ${C.cyn}${i + 1}.${C.r} [${s.id}] ${s.branch}`);
    log(`     ${C.dim}Port:${C.r} ${s.port}  ${C.dim}Status:${C.r} ${status}  ${C.dim}Ready:${C.r} ${ready}`);
    log(`     ${C.dim}URL:${C.r} ${s.url}`);
    log('');
  });
  return sessions;
}

async function stopSessionCli(sessionId) {
  await ensureDaemon();
  if (!sessionId) {
    const sessions = await listSessionsCli();
    if (!sessions?.length) return;
    if (sessions.length === 1) { sessionId = sessions[0].id; }
    else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(r => rl.question(`${C.cyn}Select session: ${C.r}`, r));
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= sessions.length) { log(`${C.red}Invalid${C.r}`); process.exit(1); }
      sessionId = sessions[idx].id;
    }
  }
  const result = await daemonRequest(`/sessions/${sessionId}`, { method: 'DELETE' });
  if (!result.ok) { log(`${C.red}Error: ${result.error || result.data?.error}${C.r}`); process.exit(1); }
  log(`${C.grn}Session ${sessionId} stopped${C.r}`);
}

// ── Dashboard TUI ─────────────────────────────────────────────────────────────

// Preset text filters — number keys toggle these
const PRESETS = [
  { key: '1', label: 'errors', match: (entry) => entry.level === 'error' || entry.level === 'warn' || /error|Error|ERR|WARN/i.test(entry.message) },
  { key: '2', label: 'bitdex', match: (entry) => /bitdex|BitDex|BITDEX/i.test(entry.message) },
  { key: '3', label: 'trpc', match: (entry) => /trpc|tRPC/i.test(entry.message) },
  { key: '4', label: 'api', match: (entry) => /\bapi\b|\/api\//i.test(entry.message) },
  { key: '5', label: 'prisma', match: (entry) => /prisma|Prisma/i.test(entry.message) },
  { key: '6', label: 'stdout', match: (entry) => entry.level === 'stdout' },
  { key: '7', label: 'stderr', match: (entry) => entry.level === 'stderr' || entry.level === 'error' },
  { key: '8', label: 'info', match: (entry) => entry.level === 'info' },
];

async function cmdDashboard(initialWorktree) {
  if (!process.stdout.isTTY) {
    log('Dashboard requires a TTY terminal. Use --tail for non-interactive mode.');
    process.exit(1);
  }

  await ensureDaemon();

  // Ensure a session is running
  const cwd = initialWorktree ? resolve(initialWorktree) : projectRoot;
  const startResult = await daemonRequest('/sessions', {
    method: 'POST',
    body: JSON.stringify({ worktree: cwd }),
  });

  let sessionId;
  if (startResult.ok) {
    sessionId = startResult.data.session.id;
  } else {
    // Try to find an existing session
    const listResult = await daemonRequest('/sessions');
    if (listResult.ok && listResult.data.sessions?.length) {
      const running = listResult.data.sessions.find(s => s.status === 'running');
      sessionId = running ? running.id : listResult.data.sessions[0].id;
    } else {
      log(`${C.red}No session available${C.r}`);
      process.exit(1);
    }
  }

  const write = (s) => process.stdout.write(s);

  // Dashboard state
  let logCursor = -1;
  let logLines = [];        // all log entries (raw from daemon)
  let lastSession = null;
  let running = true;
  let actionMsg = null;
  let actionTimer = null;
  let activeFilter = null;  // null = all, preset index, or 'search'
  let searchText = '';       // active search text
  let searchMode = false;    // true when typing in search bar
  let searchInput = '';      // buffer for search input

  // Terminal size
  let cols = process.stdout.columns || 120;
  let rows = process.stdout.rows || 30;
  process.stdout.on('resize', () => {
    cols = process.stdout.columns || 120;
    rows = process.stdout.rows || 30;
  });

  function flash(msg) {
    actionMsg = msg;
    if (actionTimer) clearTimeout(actionTimer);
    actionTimer = setTimeout(() => { actionMsg = null; }, 3000);
  }

  // Enter alternate screen
  write(ALT_ON + CUR_HIDE);

  // Raw mode
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  function exitDash() {
    if (!running) return;
    running = false;
    write(CUR_SHOW + ALT_OFF);
    try { process.stdin.setRawMode(false); } catch {}
    log(`${C.dim}Disconnected. Dev server still running.${C.r}`);
    log(`${C.dim}Reconnect:  node .claude/skills/dev-server/console.mjs${C.r}`);
    log(`${C.dim}Stop:       node .claude/skills/dev-server/console.mjs --stop${C.r}`);
    process.exit(0);
  }

  process.on('SIGINT', exitDash);
  process.on('SIGTERM', exitDash);

  // ── Keyboard handler ────────────────────────────────────────────────────────
  process.stdin.on('data', async (key) => {
    // Search mode: capture text input
    if (searchMode) {
      if (key === '\r' || key === '\n') {
        // Enter: apply search
        searchMode = false;
        if (searchInput.trim()) {
          searchText = searchInput.trim();
          activeFilter = 'search';
          flash(`Filter: "${searchText}"`);
        } else {
          activeFilter = null;
          searchText = '';
          flash('Filter: all');
        }
        searchInput = '';
        return;
      } else if (key === '\x1b' || key === '\x03') {
        // Escape or Ctrl+C: cancel search
        searchMode = false;
        searchInput = '';
        flash('Search cancelled');
        return;
      } else if (key === '\x7f' || key === '\b') {
        // Backspace
        searchInput = searchInput.slice(0, -1);
        return;
      } else if (key.length === 1 && key.charCodeAt(0) >= 32) {
        searchInput += key;
        return;
      }
      return;
    }

    // Ignore multi-byte escape sequences (arrow keys, etc.)
    if (key.length > 1 && key[0] === '\x1b') return;

    switch (key) {
      case 'q':
      case '\x03': // Ctrl+C
        exitDash();
        break;

      case '/':
      case 'f':
        searchMode = true;
        searchInput = '';
        flash('Type search text, Enter to apply, Esc to cancel');
        break;

      case 'a':
        activeFilter = null;
        searchText = '';
        flash('Filter: all');
        break;

      case 'r':
        flash('Restarting session...');
        try {
          await daemonRequest(`/sessions/${sessionId}/restart`, { method: 'POST' });
          logCursor = -1;
          logLines = [];
          flash('Session restarted');
        } catch (e) { flash(`Restart failed: ${e.message}`); }
        break;

      case 'x':
        flash('Stopping session...');
        try {
          await daemonRequest(`/sessions/${sessionId}`, { method: 'DELETE' });
          flash('Session stopped');
          await sleep(1000);
          exitDash();
        } catch (e) { flash(`Stop failed: ${e.message}`); }
        break;

      case 'c':
        // Clear log buffer
        logLines = [];
        flash('Logs cleared');
        break;

      case 'K':
        flash('Shutting down daemon...');
        try { await daemonRequest('/shutdown', { method: 'POST' }); } catch {}
        exitDash();
        break;

      default: {
        // Check preset keys
        const preset = PRESETS.find(p => p.key === key);
        if (preset) {
          if (activeFilter === key) {
            // Toggle off
            activeFilter = null;
            flash('Filter: all');
          } else {
            activeFilter = key;
            flash(`Filter: ${preset.label}`);
          }
        }
        break;
      }
    }
  });

  // ── Filter logic ────────────────────────────────────────────────────────────
  function filterLogs(entries) {
    if (activeFilter === null) return entries;
    if (activeFilter === 'search') {
      const lower = searchText.toLowerCase();
      return entries.filter(e => e.message?.toLowerCase().includes(lower));
    }
    const preset = PRESETS.find(p => p.key === activeFilter);
    if (preset) return entries.filter(preset.match);
    return entries;
  }

  // ── Formatting ──────────────────────────────────────────────────────────────
  function fmtUptime(sec) {
    if (!sec || sec <= 0) return '';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60 ? ' ' + (sec % 60) + 's' : ''}`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function fmtTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function levelColor(level) {
    switch (level) {
      case 'error': return C.red;
      case 'warn': return C.ylw;
      case 'stderr': return C.red;
      case 'info': return C.cyn;
      default: return '';
    }
  }

  function levelTag(level) {
    switch (level) {
      case 'error': return `${C.red}ERR${C.r}`;
      case 'warn': return `${C.ylw}WRN${C.r}`;
      case 'stderr': return `${C.red}ERR${C.r}`;
      case 'info': return `${C.cyn}INF${C.r}`;
      case 'stdout': return `${C.dim}OUT${C.r}`;
      default: return `${C.dim}---${C.r}`;
    }
  }

  function fmtLogEntry(entry, maxWidth) {
    const ts = fmtTime(entry.timestamp);
    const lvl = levelTag(entry.level);
    const prefix = `${C.dim}${ts}${C.r} ${lvl} `;
    // Visible prefix length: 8 (ts) + 1 + 3 (lvl) + 1 = 13
    const prefixLen = 13;
    const msgMax = maxWidth - prefixLen - 1;
    let msg = stripAnsi(entry.message || '');

    // Highlight search text if active
    if (activeFilter === 'search' && searchText) {
      const idx = msg.toLowerCase().indexOf(searchText.toLowerCase());
      if (idx >= 0) {
        const before = msg.slice(0, idx);
        const match = msg.slice(idx, idx + searchText.length);
        const after = msg.slice(idx + searchText.length);
        const highlighted = before + `${C.bgRed}${C.wht}${C.b}${match}${C.r}` + after;
        if (msg.length > msgMax && msgMax > 0) {
          // Truncate but try to keep the match visible
          const start = Math.max(0, idx - Math.floor(msgMax / 3));
          msg = msg.slice(start, start + msgMax);
          const newIdx = msg.toLowerCase().indexOf(searchText.toLowerCase());
          if (newIdx >= 0) {
            const b = msg.slice(0, newIdx);
            const m = msg.slice(newIdx, newIdx + searchText.length);
            const a = msg.slice(newIdx + searchText.length);
            return prefix + b + `${C.bgRed}${C.wht}${C.b}${m}${C.r}` + a;
          }
        }
        return prefix + highlighted;
      }
    }

    if (msg.length > msgMax && msgMax > 0) msg = msg.slice(0, msgMax);

    // Color error lines
    const lc = levelColor(entry.level);
    return prefix + (lc ? lc + msg + C.r : msg);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function render() {
    const buf = [];
    buf.push(HOME);

    // ── Header bar ──
    const s = lastSession;
    const title = ' Dev Server ';
    let info = 'connecting...';
    if (s) {
      const statusStr = s.status === 'running' ? `${C.grn}running${C.r}` : `${C.ylw}${s.status}${C.r}`;
      const readyStr = s.ready ? `${C.grn}ready${C.r}` : `${C.ylw}starting${C.r}`;
      const uptimeStr = s.startedAt ? fmtUptime(Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000)) : '';
      info = `${s.branch || '?'}  ${C.dim}port${C.r} ${s.port}  ${statusStr}  ${readyStr}  ${C.dim}up${C.r} ${uptimeStr}`;
    }
    const infoClean = stripAnsi(info);
    const pad = Math.max(0, cols - title.length - infoClean.length - 1);
    buf.push(CLR_LINE + C.bgBlu + C.wht + C.b + title + C.r + C.bgBlu + ' '.repeat(pad) + C.r + C.bgBlu + info + ' ' + C.r + '\n');

    // ── Session details line ──
    if (s) {
      const url = s.url || `http://localhost:${s.port}`;
      const logCount = `${s.logCount ?? logLines.length} logs`;
      buf.push(CLR_LINE + `  ${C.dim}URL:${C.r} ${url}  ${C.dim}Session:${C.r} ${s.id}  ${C.dim}${logCount}${C.r}\n`);
    } else {
      buf.push(CLR_LINE + '\n');
    }

    // ── Log separator ──
    const filterLabel = activeFilter === 'search' ? `"${searchText}"` : (activeFilter ? PRESETS.find(p => p.key === activeFilter)?.label || 'all' : 'all');
    const sepText = `\u2500\u2500 logs: ${filterLabel} `;
    buf.push(CLR_LINE + C.dim + sepText + '\u2500'.repeat(Math.max(0, cols - sepText.length)) + C.r + '\n');

    // ── Log area ──
    const HEADER_ROWS = 3;   // header + details + separator
    const FOOTER_ROWS = 2;   // separator + shortcut bar
    const logAreaRows = Math.max(1, rows - HEADER_ROWS - FOOTER_ROWS);

    const filtered = filterLogs(logLines);
    const visible = filtered.slice(-logAreaRows);

    for (let i = 0; i < logAreaRows; i++) {
      const entry = visible[i];
      if (entry) {
        buf.push(CLR_LINE + fmtLogEntry(entry, cols) + '\n');
      } else {
        buf.push(CLR_LINE + '\n');
      }
    }

    // ── Footer separator ──
    buf.push(CLR_LINE + C.dim + '\u2500'.repeat(cols) + C.r + '\n');

    // ── Footer bar ──
    if (searchMode) {
      buf.push(CLR_LINE + ` ${C.ylw}/${C.r} ${searchInput}\u2588` + CLR_BELOW);
    } else if (actionMsg) {
      buf.push(CLR_LINE + ` ${C.ylw}${actionMsg}${C.r}` + CLR_BELOW);
    } else {
      const k = (key, label) => `${C.b}${key}${C.r}${C.dim}${label}${C.r}`;
      // Build preset labels with active indicator
      const presetBar = PRESETS.map(p => {
        const active = activeFilter === p.key;
        return active
          ? `${C.bgBlu}${C.wht}${C.b}${p.key}${C.r}${C.bgBlu}${C.wht} ${p.label}${C.r}`
          : `${C.b}${p.key}${C.r} ${C.dim}${p.label}${C.r}`;
      }).join('  ');

      const searchActive = activeFilter === 'search';
      const searchLabel = searchActive
        ? `${C.bgBlu}${C.wht}${C.b}/${C.r}${C.bgBlu}${C.wht} "${searchText}"${C.r}`
        : `${C.b}/${C.r}${C.dim}search${C.r}`;

      const bar =
        ` ${presetBar}  ` +
        `${searchLabel}  ` +
        `${k('a', 'all')}  ` +
        `${C.dim}\u2502${C.r}  ` +
        `${k('r', 'estart')}  ` +
        `${k('c', 'lear')}  ` +
        `${k('x', '-stop')}  ` +
        `${k('q', 'uit')}  ` +
        `${C.b}K${C.r}${C.dim}ill${C.r}`;
      buf.push(CLR_LINE + bar + CLR_BELOW);
    }

    write(buf.join(''));
  }

  // ── Main poll loop ──────────────────────────────────────────────────────────
  while (running) {
    try {
      // Fetch session status
      const statusResult = await daemonRequest(`/sessions/${sessionId}`);
      if (statusResult.ok) {
        lastSession = statusResult.data.session;
      }

      // Fetch logs (always fetch all, filter client-side)
      const logResult = await daemonRequest(`/sessions/${sessionId}/logs?since=${logCursor}&limit=2000`);
      if (logResult.ok) {
        for (const entry of logResult.data.logs || []) {
          logLines.push(entry);
          logCursor = entry.index;
        }
        // Cap memory
        if (logLines.length > 5000) logLines = logLines.slice(-3000);
      }
    } catch {
      lastSession = null;
    }

    render();
    await sleep(500);
  }
}

// ── Non-interactive tail (for piping / scripting) ─────────────────────────────
async function cmdTail(sessionId) {
  await ensureDaemon();

  if (!sessionId) {
    const listResult = await daemonRequest('/sessions');
    if (!listResult.ok || !listResult.data.sessions?.length) {
      log(`${C.red}No sessions found${C.r}`);
      process.exit(1);
    }
    const running = listResult.data.sessions.find(s => s.status === 'running');
    sessionId = running ? running.id : listResult.data.sessions[0].id;
  }

  let lastIndex = -1;
  const poll = async () => {
    const result = await daemonRequest(`/sessions/${sessionId}/logs?since=${lastIndex}`);
    if (!result.ok) {
      if (result.status === 404) { log(`${C.red}Session not found${C.r}`); process.exit(1); }
      return;
    }
    for (const entry of result.data.logs) {
      const level = entry.level;
      let prefix = '';
      if (level === 'stderr' || level === 'error') prefix = C.red;
      else if (level === 'warn') prefix = C.ylw;
      else if (level === 'info') prefix = C.cyn;
      log(`${prefix}${entry.message}${C.r}`);
      lastIndex = entry.index;
    }
  };
  await poll();
  const interval = setInterval(poll, 500);
  process.on('SIGINT', () => {
    clearInterval(interval);
    log(`\n${C.dim}Disconnected. Dev server still running.${C.r}`);
    process.exit(0);
  });
}

// ── Parse arguments ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--kill') || args.includes('-k')) {
  (async () => {
    const result = await daemonRequest('/shutdown', { method: 'POST' });
    if (result.ok) log(`${C.grn}Daemon shutdown${C.r}`);
    else if (result.status === 0) log(`${C.dim}Daemon not running${C.r}`);
    else log(`${C.red}Error: ${result.error || result.data?.error}${C.r}`);
  })();
} else if (args.includes('--list') || args.includes('-l')) {
  listSessionsCli().then(() => process.exit(0));
} else if (args.includes('--stop') || args.includes('-s')) {
  const stopIdx = args.findIndex(a => a === '--stop' || a === '-s');
  stopSessionCli(args[stopIdx + 1]);
} else if (args.includes('--tail') || args.includes('-t')) {
  const tailIdx = args.findIndex(a => a === '--tail' || a === '-t');
  cmdTail(args[tailIdx + 1]);
} else if (args.includes('--help') || args.includes('-h')) {
  log(`
${C.b}Dev Server Console${C.r}

Usage:
  npm run dev:daemon                    ${C.dim}Launch dashboard TUI (starts server if needed)${C.r}
  npm run dev:daemon -- --tail [id]     ${C.dim}Non-interactive log tail${C.r}
  npm run dev:daemon -- --list          ${C.dim}List running sessions${C.r}
  npm run dev:daemon -- --stop [id]     ${C.dim}Stop a session${C.r}
  npm run dev:daemon -- --kill          ${C.dim}Shutdown daemon${C.r}

${C.b}Dashboard Keys:${C.r}
  ${C.b}1${C.r} errors   ${C.b}2${C.r} bitdex   ${C.b}3${C.r} trpc   ${C.b}4${C.r} api   ${C.b}5${C.r} prisma   ${C.b}6${C.r} stdout   ${C.b}7${C.r} stderr   ${C.b}8${C.r} info
  ${C.b}/${C.r} search   ${C.b}a${C.r} all   ${C.b}r${C.r} restart   ${C.b}c${C.r} clear logs   ${C.b}x${C.r} stop   ${C.b}q${C.r} quit   ${C.b}K${C.r} kill daemon
`);
} else {
  // Default: launch dashboard
  const worktree = args[0] && !args[0].startsWith('-') ? args[0] : null;
  cmdDashboard(worktree);
}
