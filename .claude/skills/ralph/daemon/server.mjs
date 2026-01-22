#!/usr/bin/env node
/**
 * Ralph Daemon Server
 *
 * HTTP server that hosts multiple autonomous agent sessions with:
 * - RESTful API for session management and control
 * - WebSocket for real-time log streaming
 * - Web UI for human monitoring
 *
 * Usage:
 *   node server.mjs [options]
 *
 * Options:
 *   --port <port>    Port to listen on (default: 9333)
 *   --host <host>    Host to bind to (default: localhost)
 *
 * API Endpoints:
 *   POST   /api/sessions              Create new session
 *   GET    /api/sessions              List all sessions
 *   GET    /api/sessions/:id          Get session status
 *   DELETE /api/sessions/:id          Destroy session
 *
 *   POST   /api/sessions/:id/start    Start session execution
 *   POST   /api/sessions/:id/pause    Pause session
 *   POST   /api/sessions/:id/resume   Resume session
 *   POST   /api/sessions/:id/inject   Inject guidance
 *   POST   /api/sessions/:id/abort    Abort session
 *   POST   /api/sessions/:id/skip     Skip current story
 *   POST   /api/sessions/:id/approve  Approve pending operation
 *   POST   /api/sessions/:id/reject   Reject pending operation
 *
 *   GET    /api/sessions/:id/logs     Get log history
 *   GET    /api/sessions/:id/turns    Get turn history
 *   GET    /api/sessions/:id/prd      Get PRD
 *   GET    /api/sessions/:id/checkpoints  Get checkpoints
 *   POST   /api/sessions/:id/restore  Restore to checkpoint
 *
 *   GET    /api/sessions/:id/stream   WebSocket for live logs
 *
 *   POST   /api/cleanup               Cleanup old sessions
 *   POST   /api/exit                  Shutdown server
 *
 *   GET    /                          Web UI dashboard
 */

import http from 'http';
import { readFileSync, existsSync } from 'fs';

// Try to import WebSocket support (optional)
let WebSocketServer = null;
try {
  const ws = await import('ws');
  WebSocketServer = ws.WebSocketServer;
} catch (e) {
  console.error('WebSocket support not available (ws module not installed)');
  console.error('Install with: npm install ws');
  console.error('Proceeding without WebSocket support...\n');
}
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSessionManager } from './session-manager.mjs';
import { GuidanceType } from './turn-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: 9333,
    host: 'localhost',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        config.port = parseInt(args[++i], 10);
        break;
      case '--host':
      case '-h':
        config.host = args[++i];
        break;
      case '--help':
        console.log(`
Ralph Daemon Server

Usage: node server.mjs [options]

Options:
  --port, -p <port>    Port to listen on (default: 9333)
  --host, -h <host>    Host to bind to (default: localhost)
  --help               Show this help

API Documentation:
  See SKILL.md for full API documentation
`);
        process.exit(0);
    }
  }

  return config;
}

// Helper to read request body with size limit (1MB max)
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large (max 1MB)'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// JSON response helper
function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Error response helper
function errorResponse(res, status, message) {
  jsonResponse(res, status, { error: message });
}

// Main server
async function main() {
  const config = parseArgs();
  const manager = getSessionManager();

  console.error(`Starting Ralph Daemon...`);
  console.error(`  Host: ${config.host}`);
  console.error(`  Port: ${config.port}`);

  // WebSocket connections per session
  const wsConnections = new Map(); // sessionId -> Set<ws>

  // HTTP request handler
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${config.host}:${config.port}`);
    const path = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Request logging
    const startTime = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      console.error(`${req.method} ${path} - ${res.statusCode} (${duration}ms)`);
    });

    try {
      // ========================
      // Web UI Routes
      // ========================

      // Serve Web UI
      if (path === '/' && req.method === 'GET') {
        const uiPath = resolve(__dirname, 'ui.html');
        if (existsSync(uiPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(readFileSync(uiPath, 'utf-8'));
        } else {
          // Inline fallback UI
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(getInlineUI());
        }
        return;
      }

      // ========================
      // API Routes
      // ========================

      // POST /api/sessions - Create session
      if (path === '/api/sessions' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const { prd, name, model, maxTurns, workingDirectory, autoStart } = body;

        if (!prd) {
          return errorResponse(res, 400, 'PRD path required');
        }

        const session = await manager.createSession({
          prd,
          name,
          model,
          maxTurns,
          workingDirectory,
          autoStart,
        });

        return jsonResponse(res, 201, { type: 'session_created', session });
      }

      // GET /api/sessions - List sessions
      if (path === '/api/sessions' && req.method === 'GET') {
        const active = url.searchParams.get('active') === 'true';
        const status = url.searchParams.get('status');

        const sessions = manager.listSessions({
          active,
          status: status ? status.split(',') : undefined,
        });

        return jsonResponse(res, 200, { type: 'sessions', sessions });
      }

      // Session-specific routes
      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2];

        // GET /api/sessions/:id - Get session status
        if (!action && req.method === 'GET') {
          const status = manager.getSessionStatus(sessionId);
          if (!status) {
            return errorResponse(res, 404, `Session ${sessionId} not found`);
          }
          return jsonResponse(res, 200, { type: 'session_status', ...status });
        }

        // DELETE /api/sessions/:id - Destroy session
        if (!action && req.method === 'DELETE') {
          const session = manager.getSession(sessionId);
          if (!session) {
            return errorResponse(res, 404, `Session ${sessionId} not found`);
          }
          await manager.destroySession(sessionId);
          return jsonResponse(res, 200, { type: 'session_destroyed', sessionId });
        }

        // POST /api/sessions/:id/start - Start session
        if (action === 'start' && req.method === 'POST') {
          const session = manager.getSession(sessionId);
          if (!session) {
            return errorResponse(res, 404, `Session ${sessionId} not found`);
          }
          await manager.startSession(sessionId);
          return jsonResponse(res, 200, { type: 'session_started', sessionId });
        }

        // POST /api/sessions/:id/pause - Pause session
        if (action === 'pause' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { source, reason } = body;

          const result = await manager.pauseSession(sessionId, { source, reason });
          return jsonResponse(res, 200, { type: 'pause_requested', sessionId, ...result });
        }

        // POST /api/sessions/:id/resume - Resume session
        if (action === 'resume' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { source, guidance, guidanceType, lockToken, force } = body;

          try {
            const result = await manager.resumeSession(sessionId, {
              source,
              guidance,
              guidanceType,
              lockToken,
              force,
            });
            return jsonResponse(res, 200, { type: 'resume_requested', sessionId, ...result });
          } catch (err) {
            return errorResponse(res, 423, err.message);
          }
        }

        // POST /api/sessions/:id/inject - Inject guidance
        if (action === 'inject' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { content, type, source, priority, contextDiff } = body;

          if (!content) {
            return errorResponse(res, 400, 'Guidance content required');
          }

          const result = await manager.injectGuidance(sessionId, {
            content,
            type: type || GuidanceType.HINT,
            source,
            priority,
            contextDiff,
          });
          return jsonResponse(res, 200, { type: 'guidance_injected', sessionId, ...result });
        }

        // POST /api/sessions/:id/abort - Abort session
        if (action === 'abort' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { source } = body;

          const result = await manager.abortSession(sessionId, { source });
          return jsonResponse(res, 200, { type: 'session_aborted', sessionId, ...result });
        }

        // POST /api/sessions/:id/skip - Skip current story
        if (action === 'skip' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { source, reason } = body;

          const result = await manager.skipStory(sessionId, { source, reason });
          return jsonResponse(res, 200, { type: 'skip_requested', sessionId, ...result });
        }

        // POST /api/sessions/:id/approve - Approve operation
        if (action === 'approve' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { source } = body;

          const result = await manager.approveOperation(sessionId, { source });
          return jsonResponse(res, 200, { type: 'operation_approved', sessionId, ...result });
        }

        // POST /api/sessions/:id/reject - Reject operation
        if (action === 'reject' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { source, reason } = body;

          const result = await manager.rejectOperation(sessionId, { source, reason });
          return jsonResponse(res, 200, { type: 'operation_rejected', sessionId, ...result });
        }

        // GET /api/sessions/:id/logs - Get logs
        if (action === 'logs' && req.method === 'GET') {
          const limit = parseInt(url.searchParams.get('limit') || '100', 10);
          const offset = parseInt(url.searchParams.get('offset') || '0', 10);
          const since = url.searchParams.get('since');

          const logs = manager.getLogs(sessionId, { limit, offset, since });
          return jsonResponse(res, 200, { type: 'logs', sessionId, logs });
        }

        // GET /api/sessions/:id/turns - Get turn history
        if (action === 'turns' && req.method === 'GET') {
          const limit = parseInt(url.searchParams.get('limit') || '100', 10);
          const offset = parseInt(url.searchParams.get('offset') || '0', 10);

          const turns = manager.getTurns(sessionId, { limit, offset });
          return jsonResponse(res, 200, { type: 'turns', sessionId, turns });
        }

        // GET /api/sessions/:id/prd - Get PRD
        if (action === 'prd' && req.method === 'GET') {
          try {
            const prd = manager.getPrd(sessionId);
            return jsonResponse(res, 200, { type: 'prd', sessionId, prd });
          } catch (err) {
            return errorResponse(res, 404, err.message);
          }
        }

        // GET /api/sessions/:id/checkpoints - Get checkpoints
        if (action === 'checkpoints' && req.method === 'GET') {
          const checkpoints = manager.getCheckpoints(sessionId);
          return jsonResponse(res, 200, { type: 'checkpoints', sessionId, checkpoints });
        }

        // POST /api/sessions/:id/restore - Restore to checkpoint
        if (action === 'restore' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { turnNumber, source } = body;

          if (turnNumber === undefined) {
            return errorResponse(res, 400, 'turnNumber required');
          }

          try {
            const result = await manager.restoreToCheckpoint(sessionId, turnNumber, { source });
            return jsonResponse(res, 200, { type: 'checkpoint_restored', sessionId, ...result });
          } catch (err) {
            return errorResponse(res, 400, err.message);
          }
        }

        // ========================================
        // Orchestration Endpoints
        // ========================================

        // POST /api/sessions/:id/spawn - Spawn child session
        if (action === 'spawn' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { prd, name, model, maxTurns, workingDirectory, autoStart } = body;

          if (!prd) {
            return errorResponse(res, 400, 'PRD path required');
          }

          try {
            const child = await manager.spawnSession(sessionId, {
              prd,
              name,
              model,
              maxTurns,
              workingDirectory,
              autoStart,
            });
            return jsonResponse(res, 201, { type: 'child_spawned', parentId: sessionId, child });
          } catch (err) {
            return errorResponse(res, 400, err.message);
          }
        }

        // GET /api/sessions/:id/children - List children
        if (action === 'children' && req.method === 'GET') {
          const status = url.searchParams.get('status');

          try {
            const children = manager.getChildren(sessionId, {
              status: status ? status.split(',') : undefined,
            });
            return jsonResponse(res, 200, { type: 'children', sessionId, children });
          } catch (err) {
            return errorResponse(res, 404, err.message);
          }
        }

        // POST /api/sessions/:id/wait - Wait for children to complete
        if (action === 'wait' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { timeout = 0, pollInterval = 2000 } = body;

          try {
            const result = await manager.waitForChildren(sessionId, { timeout, pollInterval });
            return jsonResponse(res, 200, { type: 'wait_result', sessionId, ...result });
          } catch (err) {
            return errorResponse(res, 400, err.message);
          }
        }

        // POST /api/sessions/:id/wait-state - Wait for significant state change
        if (action === 'wait-state' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { timeout = 0, pollInterval = 2000 } = body;

          try {
            const result = await manager.waitForStateChange(sessionId, { timeout, pollInterval });
            return jsonResponse(res, 200, { type: 'state_change', sessionId, ...result });
          } catch (err) {
            return errorResponse(res, 400, err.message);
          }
        }

        // GET /api/sessions/:id/tree - Get session tree (parent + all descendants)
        if (action === 'tree' && req.method === 'GET') {
          try {
            const tree = manager.getSessionTree(sessionId);
            return jsonResponse(res, 200, { type: 'session_tree', tree });
          } catch (err) {
            return errorResponse(res, 404, err.message);
          }
        }

        // GET /api/sessions/:id/parent - Get parent session
        if (action === 'parent' && req.method === 'GET') {
          const parent = manager.getParent(sessionId);
          if (!parent) {
            return jsonResponse(res, 200, { type: 'parent', sessionId, parent: null });
          }
          return jsonResponse(res, 200, { type: 'parent', sessionId, parent });
        }

        // POST /api/sessions/:id/abort-cascade - Abort session and all children
        if (action === 'abort-cascade' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { source } = body;

          try {
            const result = await manager.abortSessionCascade(sessionId, { source });
            return jsonResponse(res, 200, { type: 'cascade_aborted', ...result });
          } catch (err) {
            return errorResponse(res, 400, err.message);
          }
        }

        // WebSocket upgrade for /api/sessions/:id/stream is handled by WSS
        if (action === 'stream' && req.method === 'GET') {
          // This is handled by the WebSocket server
          return;
        }
      }

      // POST /api/cleanup - Cleanup old sessions
      if (path === '/api/cleanup' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const { olderThanDays = 7 } = body;

        const result = manager.cleanup(olderThanDays);
        return jsonResponse(res, 200, { type: 'cleanup_complete', ...result });
      }

      // POST /api/exit - Shutdown server
      if (path === '/api/exit' && req.method === 'POST') {
        jsonResponse(res, 200, { type: 'shutting_down' });

        setTimeout(async () => {
          await manager.shutdown();
          server.close();
          wss.close();
          process.exit(0);
        }, 100);
        return;
      }

      // 404
      return errorResponse(res, 404, 'Not found');

    } catch (err) {
      console.error('Request error:', err);
      return errorResponse(res, 500, err.message);
    }
  };

  // Create HTTP server
  const server = http.createServer(handler);

  // Create WebSocket server (if available)
  const wss = WebSocketServer ? new WebSocketServer({ noServer: true }) : null;

  // Handle WebSocket upgrade (if WebSocket is available)
  if (wss) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://${config.host}:${config.port}`);
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);

      if (!match) {
        socket.destroy();
        return;
      }

      const sessionId = decodeURIComponent(match[1]);
      const session = manager.getSession(sessionId);

      if (!session) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        // Add to connections
        if (!wsConnections.has(sessionId)) {
          wsConnections.set(sessionId, new Set());
        }
        wsConnections.get(sessionId).add(ws);

        console.error(`WebSocket connected for session ${sessionId}`);

        // Subscribe to session events
        const unsubscribe = manager.subscribe(sessionId, (event) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(event));
          }
        });

        // Handle close
        ws.on('close', () => {
          unsubscribe();
          const conns = wsConnections.get(sessionId);
          if (conns) {
            conns.delete(ws);
            if (conns.size === 0) {
              wsConnections.delete(sessionId);
            }
          }
          console.error(`WebSocket disconnected for session ${sessionId}`);
        });

        // Send initial status
        const status = manager.getSessionStatus(sessionId);
        ws.send(JSON.stringify({ event: 'connected', ...status }));
      });
    });
  }

  // Start server
  server.listen(config.port, config.host, () => {
    console.error(`\nRalph Daemon running on http://${config.host}:${config.port}`);
    console.error(`\nAPI Endpoints:`);
    console.error(`  POST   /api/sessions              Create session`);
    console.error(`  GET    /api/sessions              List sessions`);
    console.error(`  GET    /api/sessions/:id          Get session status`);
    console.error(`  DELETE /api/sessions/:id          Destroy session`);
    console.error(`  POST   /api/sessions/:id/start    Start session`);
    console.error(`  POST   /api/sessions/:id/pause    Pause session`);
    console.error(`  POST   /api/sessions/:id/resume   Resume session`);
    console.error(`  POST   /api/sessions/:id/inject   Inject guidance`);
    console.error(`  POST   /api/sessions/:id/abort    Abort session`);
    console.error(`  GET    /api/sessions/:id/logs     Get logs`);
    if (wss) {
      console.error(`  GET    /api/sessions/:id/stream   WebSocket stream`);
    }
    console.error(`  GET    /                          Web UI`);
    console.error(`\nReady.`);

    // Output ready signal to stdout
    console.log(JSON.stringify({
      type: 'server_ready',
      host: config.host,
      port: config.port,
    }));
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.error('\nShutting down...');
    await manager.shutdown();
    server.close();
    if (wss) wss.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('\nShutting down...');
    await manager.shutdown();
    server.close();
    if (wss) wss.close();
    process.exit(0);
  });
}

// Inline fallback UI (used if ui.html doesn't exist)
function getInlineUI() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ralph Daemon</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { color: #00d9ff; margin-bottom: 20px; }
    .sessions { display: grid; gap: 15px; }
    .session { background: #16213e; border-radius: 8px; padding: 15px; border-left: 4px solid #00d9ff; }
    .session.running { border-color: #00ff88; }
    .session.paused { border-color: #ffaa00; }
    .session.completed { border-color: #888; }
    .session.aborted { border-color: #ff4444; }
    .session-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .session-name { font-weight: bold; font-size: 1.1em; }
    .session-status { padding: 4px 8px; border-radius: 4px; font-size: 0.85em; }
    .session-status.RUNNING { background: #00ff8833; color: #00ff88; }
    .session-status.PAUSED { background: #ffaa0033; color: #ffaa00; }
    .session-status.COMPLETED { background: #88888833; color: #888; }
    .session-status.ABORTED { background: #ff444433; color: #ff4444; }
    .session-status.CREATED { background: #00d9ff33; color: #00d9ff; }
    .session-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 10px; }
    .session-info div { font-size: 0.9em; }
    .session-info label { color: #888; display: block; font-size: 0.8em; }
    .btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; margin-right: 5px; }
    .btn-primary { background: #00d9ff; color: #000; }
    .btn-warning { background: #ffaa00; color: #000; }
    .btn-danger { background: #ff4444; color: #fff; }
    .btn-success { background: #00ff88; color: #000; }
    .btn:hover { opacity: 0.8; }
    .logs { background: #0f0f1a; border-radius: 4px; padding: 10px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.85em; margin-top: 10px; }
    .log-entry { margin: 2px 0; }
    .log-entry.error { color: #ff4444; }
    .log-entry.warn { color: #ffaa00; }
    .log-entry.tool { color: #00d9ff; }
    .new-session { background: #16213e; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
    .new-session input { background: #0f0f1a; border: 1px solid #333; color: #eee; padding: 8px; border-radius: 4px; margin-right: 10px; width: 300px; }
    .empty { text-align: center; padding: 40px; color: #888; }
    .inject-input { display: flex; gap: 10px; margin-top: 10px; }
    .inject-input input { flex: 1; background: #0f0f1a; border: 1px solid #333; color: #eee; padding: 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Ralph Daemon</h1>

    <div class="new-session">
      <input type="text" id="prd-path" placeholder="PRD path (e.g., .claude/skills/ralph/projects/my-project/prd.json)">
      <button class="btn btn-primary" onclick="createSession()">Create Session</button>
    </div>

    <div id="sessions" class="sessions">
      <div class="empty">Loading sessions...</div>
    </div>
  </div>

  <script>
    const API_BASE = window.location.origin + '/api';
    let sessions = [];
    let wsConnections = new Map();

    async function fetchSessions() {
      try {
        const res = await fetch(API_BASE + '/sessions');
        const data = await res.json();
        sessions = data.sessions || [];
        renderSessions();
      } catch (err) {
        console.error('Failed to fetch sessions:', err);
      }
    }

    function renderSessions() {
      const container = document.getElementById('sessions');

      if (sessions.length === 0) {
        container.innerHTML = '<div class="empty">No sessions. Create one to get started.</div>';
        return;
      }

      container.innerHTML = sessions.map(s => \`
        <div class="session \${s.status.toLowerCase()}" data-id="\${s.id}">
          <div class="session-header">
            <span class="session-name">\${s.name || s.id}</span>
            <span class="session-status \${s.status}">\${s.status}</span>
          </div>
          <div class="session-info">
            <div>
              <label>Story</label>
              \${s.currentStoryId || '-'} \${s.currentStoryTitle ? '- ' + s.currentStoryTitle : ''}
            </div>
            <div>
              <label>Progress</label>
              \${s.storiesCompleted || 0}/\${s.storiesTotal || 0} stories
            </div>
            <div>
              <label>Turns</label>
              \${s.turnCount || 0}/\${s.maxTurns || 100}
            </div>
            <div>
              <label>Health</label>
              \${s.health || 'HEALTHY'}
            </div>
          </div>
          <div>
            \${s.status === 'CREATED' ? '<button class="btn btn-success" onclick="startSession(\\'' + s.id + '\\')">Start</button>' : ''}
            \${s.status === 'RUNNING' ? '<button class="btn btn-warning" onclick="pauseSession(\\'' + s.id + '\\')">Pause</button>' : ''}
            \${s.status === 'PAUSED' ? '<button class="btn btn-success" onclick="resumeSession(\\'' + s.id + '\\')">Resume</button>' : ''}
            \${['RUNNING', 'PAUSED'].includes(s.status) ? '<button class="btn btn-danger" onclick="abortSession(\\'' + s.id + '\\')">Abort</button>' : ''}
            <button class="btn" onclick="viewSession('\\'' + s.id + '\\')">View</button>
            \${['COMPLETED', 'ABORTED'].includes(s.status) ? '<button class="btn btn-danger" onclick="destroySession(\\'' + s.id + '\\')">Delete</button>' : ''}
          </div>
          <div class="inject-input">
            <input type="text" id="inject-\${s.id}" placeholder="Inject guidance...">
            <button class="btn btn-primary" onclick="injectGuidance('\${s.id}')">Send</button>
          </div>
          <div class="logs" id="logs-\${s.id}"></div>
        </div>
      \`).join('');

      // Connect WebSocket for active sessions
      sessions.filter(s => ['RUNNING', 'PAUSED', 'CREATED'].includes(s.status)).forEach(connectWs);
    }

    function connectWs(session) {
      if (wsConnections.has(session.id)) return;

      const ws = new WebSocket(\`ws://\${window.location.host}/api/sessions/\${session.id}/stream\`);
      wsConnections.set(session.id, ws);

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        appendLog(session.id, data);
        if (data.event === 'completed' || data.event === 'aborted') {
          fetchSessions();
        }
      };

      ws.onclose = () => {
        wsConnections.delete(session.id);
      };
    }

    function appendLog(sessionId, data) {
      const logsEl = document.getElementById('logs-' + sessionId);
      if (!logsEl) return;

      let text = '';
      let className = 'log-entry';

      if (data.event === 'log') {
        text = \`[\${data.level}] \${data.message}\`;
        if (data.level === 'error') className += ' error';
        if (data.level === 'warn') className += ' warn';
        if (data.level === 'tool') className += ' tool';
      } else {
        text = \`[EVENT] \${data.event}\`;
      }

      const entry = document.createElement('div');
      entry.className = className;
      entry.textContent = text;
      logsEl.appendChild(entry);
      logsEl.scrollTop = logsEl.scrollHeight;
    }

    async function createSession() {
      const prd = document.getElementById('prd-path').value;
      if (!prd) return alert('PRD path required');

      try {
        const res = await fetch(API_BASE + '/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prd, autoStart: false })
        });
        const data = await res.json();
        if (data.error) return alert(data.error);
        document.getElementById('prd-path').value = '';
        fetchSessions();
      } catch (err) {
        alert('Failed to create session: ' + err.message);
      }
    }

    async function startSession(id) {
      await fetch(API_BASE + '/sessions/' + id + '/start', { method: 'POST' });
      fetchSessions();
    }

    async function pauseSession(id) {
      await fetch(API_BASE + '/sessions/' + id + '/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'web-ui' })
      });
      fetchSessions();
    }

    async function resumeSession(id) {
      await fetch(API_BASE + '/sessions/' + id + '/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'web-ui', force: true })
      });
      fetchSessions();
    }

    async function abortSession(id) {
      if (!confirm('Are you sure you want to abort this session?')) return;
      await fetch(API_BASE + '/sessions/' + id + '/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'web-ui' })
      });
      fetchSessions();
    }

    async function destroySession(id) {
      if (!confirm('Are you sure you want to delete this session?')) return;
      await fetch(API_BASE + '/sessions/' + id, { method: 'DELETE' });
      fetchSessions();
    }

    async function injectGuidance(id) {
      const input = document.getElementById('inject-' + id);
      const content = input.value;
      if (!content) return;

      await fetch(API_BASE + '/sessions/' + id + '/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, source: 'web-ui' })
      });
      input.value = '';
    }

    function viewSession(id) {
      // For now just scroll to logs
      const logsEl = document.getElementById('logs-' + id);
      if (logsEl) logsEl.scrollIntoView({ behavior: 'smooth' });
    }

    // Initial load
    fetchSessions();
    setInterval(fetchSessions, 10000);
  </script>
</body>
</html>`;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
