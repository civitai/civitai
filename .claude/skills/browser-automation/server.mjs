#!/usr/bin/env node
/**
 * Browser Automation Server
 *
 * HTTP server that manages multiple concurrent browser sessions.
 * Supports multi-user flows by running sessions with different profiles simultaneously.
 *
 * Usage:
 *   node server.mjs [--port <port>]
 *
 * Endpoints:
 *   GET  /profiles                    - List available auth profiles
 *   GET  /sessions                    - List all active sessions
 *   POST /sessions                    - Create session { name, url, profile?, headless? }
 *   DELETE /sessions/:name            - Close a specific session
 *   GET  /flows                       - List saved flows
 *   POST /flows/:name/run             - Run a flow { profile?, startUrl?, headless? }
 *
 *   Session-specific (use ?session=name or defaults to 'default'):
 *   GET  /status                      - Get session status
 *   GET  /inspect                     - Get current page state
 *   POST /chunk                       - Execute code { label, code }
 *   POST /navigate                    - Navigate to URL { url }
 *   POST /save-auth                   - Save auth { profile, description } (description required for new profiles)
 *   GET  /review                      - Review recorded chunks
 *
 *   POST /exit                        - Shutdown server (closes all sessions)
 */

import http from 'http';
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const profilesDir = resolve(projectRoot, '.browser/profiles');
const sessionsDir = resolve(projectRoot, '.browser/sessions');
const flowsDir = resolve(projectRoot, '.browser/flows');
const profilesMetaPath = resolve(profilesDir, 'profiles.meta.json');

// Ensure directories exist
if (!existsSync(profilesDir)) mkdirSync(profilesDir, { recursive: true });
if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
if (!existsSync(flowsDir)) mkdirSync(flowsDir, { recursive: true });

// Profile metadata management
function loadProfilesMeta() {
  if (!existsSync(profilesMetaPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(profilesMetaPath, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveProfilesMeta(meta) {
  writeFileSync(profilesMetaPath, JSON.stringify(meta, null, 2));
}

function getProfileMeta(name) {
  const meta = loadProfilesMeta();
  return meta[name] || null;
}

function setProfileMeta(name, data) {
  const meta = loadProfilesMeta();
  meta[name] = {
    ...meta[name],
    ...data,
    updatedAt: new Date().toISOString(),
  };
  if (!meta[name].createdAt) {
    meta[name].createdAt = meta[name].updatedAt;
  }
  saveProfilesMeta(meta);
}

// List available profiles
function listProfiles() {
  const files = readdirSync(profilesDir).filter(f => f.endsWith('.json') && f !== 'profiles.meta.json');
  const meta = loadProfilesMeta();

  return files.map(f => {
    const name = f.replace('.json', '');
    const filePath = resolve(profilesDir, f);
    const stats = statSync(filePath);
    const profileMeta = meta[name] || {};

    // Try to extract domain from storageState
    let domain = null;
    try {
      const state = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (state.cookies && state.cookies.length > 0) {
        domain = state.cookies[0].domain;
      }
    } catch (e) {}

    return {
      name,
      description: profileMeta.description || null,
      domain,
      createdAt: profileMeta.createdAt || null,
      updatedAt: profileMeta.updatedAt || stats.mtime.toISOString(),
    };
  });
}

// Flow management
function listFlows() {
  const files = readdirSync(flowsDir).filter(f => f.endsWith('.js'));
  return files.map(f => {
    const name = f.replace('.js', '');
    const filePath = resolve(flowsDir, f);
    const content = readFileSync(filePath, 'utf-8');
    const stats = statSync(filePath);

    // Extract metadata from script comments
    const urlMatch = content.match(/Start URL: (.+)/);
    const dateMatch = content.match(/Generated: (.+)/);

    return {
      name,
      startUrl: urlMatch ? urlMatch[1].trim() : null,
      generatedAt: dateMatch ? dateMatch[1].trim() : null,
      modifiedAt: stats.mtime.toISOString(),
    };
  });
}

async function runFlow(flowName, options = {}) {
  const flowPath = resolve(flowsDir, `${flowName}.js`);

  if (!existsSync(flowPath)) {
    throw new Error(`Flow not found: ${flowName}`);
  }

  const script = readFileSync(flowPath, 'utf-8');
  const { profile, startUrl: overrideUrl, headless = false } = options;

  // Extract start URL from script comments if not overridden
  const urlMatch = script.match(/Start URL: (.+)/);
  const startUrl = overrideUrl || (urlMatch ? urlMatch[1].trim() : null);

  if (!startUrl) {
    throw new Error('No start URL specified and could not extract from flow');
  }

  // Launch browser
  const browser = await chromium.launch({ headless });

  const contextOptions = { viewport: { width: 1280, height: 720 } };
  const profilePath = profile ? resolve(profilesDir, `${profile}.json`) : null;

  if (profilePath && existsSync(profilePath)) {
    contextOptions.storageState = profilePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    // Navigate to start URL
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(1000);

    // Execute the flow script
    const asyncFn = new Function('page', `return (async () => { ${script} })();`);
    await asyncFn(page);

    // Get final page state
    const finalState = await inspectPage(page);

    await browser.close();

    return {
      status: 'passed',
      flowName,
      startUrl,
      profile,
      inspection: finalState,
    };

  } catch (error) {
    let finalState = null;
    try {
      finalState = await inspectPage(page);
    } catch (e) {}

    await browser.close();

    return {
      status: 'failed',
      flowName,
      startUrl,
      profile,
      error: error.message,
      inspection: finalState,
    };
  }
}

// Session management
function generateSessionId() {
  return randomBytes(4).toString('hex');
}

function getSessionDir(sessionId) {
  return resolve(sessionsDir, sessionId);
}

function getScreenshotsDir(sessionId) {
  return resolve(getSessionDir(sessionId), 'screenshots');
}

function ensureSessionDirs(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  const screenshotsDir = getScreenshotsDir(sessionId);
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true });
}

function getScreenshotPath(sessionId, name, index) {
  const screenshotsDir = getScreenshotsDir(sessionId);
  const paddedIndex = String(index).padStart(3, '0');
  const safeName = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().substring(0, 50);
  return resolve(screenshotsDir, `${paddedIndex}-${safeName}.png`);
}

// Parse args
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: 9222,
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

// Page inspection
async function inspectPage(page, screenshotPath = null, options = {}) {
  // Take screenshot if path provided
  if (screenshotPath) {
    await page.screenshot({
      path: screenshotPath,
      fullPage: options.fullPage ?? false
    });
  }

  const inspection = await page.evaluate(() => {
    function getSelector(el) {
      if (el.id) return `#${el.id}`;
      if (el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
      if (el.name) return `[name="${el.name}"]`;

      if (el.tagName === 'A' && el.getAttribute('href')) {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('javascript:') && href !== '#') {
          return `a[href='${href}']`;
        }
      }

      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
        const text = el.textContent?.trim();
        if (text && text.length < 30) {
          return `button:has-text('${text.replace(/'/g, "\\'")}')`;
        }
      }

      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      }

      return el.tagName.toLowerCase();
    }

    function isVisible(el) {
      if (!el.offsetParent && el.tagName !== 'BODY') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function isInViewport(el) {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0 &&
             rect.left < window.innerWidth && rect.right > 0;
    }

    const buttons = [];
    document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(el => {
      if (!isVisible(el)) return;
      const text = el.textContent?.trim() || el.value || '';
      buttons.push({
        type: 'button',
        text: text.substring(0, 50),
        selector: getSelector(el),
        inViewport: isInViewport(el),
      });
    });

    const links = [];
    document.querySelectorAll('a[href]').forEach(el => {
      if (!isVisible(el)) return;
      const href = el.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript:')) return;
      const text = el.textContent?.trim() || '';
      links.push({
        text: text.substring(0, 50),
        href: href.substring(0, 100),
        selector: getSelector(el),
        inViewport: isInViewport(el),
      });
    });

    const inputs = [];
    document.querySelectorAll('input, textarea, select').forEach(el => {
      if (!isVisible(el) || el.type === 'hidden') return;
      inputs.push({
        type: el.type || el.tagName.toLowerCase(),
        name: el.name || el.id || '',
        selector: getSelector(el),
        placeholder: el.placeholder || '',
        inViewport: isInViewport(el),
      });
    });

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter(isVisible)
      .slice(0, 5)
      .map(el => el.textContent?.trim().substring(0, 100));

    return {
      url: window.location.href,
      title: document.title,
      headings,
      buttons: buttons.slice(0, 15),
      links: links.slice(0, 15),
      inputs: inputs.slice(0, 10),
    };
  });

  return {
    ...inspection,
    screenshot: screenshotPath,
  };
}

// Browser Session class
class BrowserSession {
  constructor(name) {
    this.name = name;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sessionId = null;
    this.profile = null;
    this.chunks = [];
    this.screenshotIndex = 0;
    this.startUrl = null;
    this.createdAt = null;
  }

  async start(options = {}) {
    const { url, profile, headless = false } = options;

    this.sessionId = generateSessionId();
    this.profile = profile;
    this.startUrl = url;
    this.chunks = [];
    this.screenshotIndex = 0;
    this.createdAt = new Date().toISOString();

    ensureSessionDirs(this.sessionId);

    console.error(`Starting browser session '${this.name}': ${this.sessionId}`);
    console.error(`  Session folder: ${getSessionDir(this.sessionId)}`);
    console.error(`  URL: ${url}`);
    console.error(`  Profile: ${profile || '(none)'}`);

    // Launch browser
    this.browser = await chromium.launch({ headless });

    const contextOptions = { viewport: { width: 1280, height: 720 } };
    const profilePath = profile ? resolve(profilesDir, `${profile}.json`) : null;

    if (profilePath && existsSync(profilePath)) {
      console.error(`  Loading saved auth from profile...`);
      contextOptions.storageState = profilePath;
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);

    // Navigate to initial URL
    console.error(`  Navigating to ${url}...`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await this.page.waitForTimeout(2000);
    console.error(`  Page loaded.`);

    // Take initial screenshot
    const initialScreenshot = this.nextScreenshot('session-start');
    const inspection = await inspectPage(this.page, initialScreenshot);

    return {
      name: this.name,
      sessionId: this.sessionId,
      sessionDir: getSessionDir(this.sessionId),
      profile: this.profile,
      inspection,
    };
  }

  async stop() {
    if (!this.browser) return null;

    // Auto-save auth if using profile
    if (this.profile) {
      try {
        const profilePath = resolve(profilesDir, `${this.profile}.json`);
        await this.context.storageState({ path: profilePath });
        console.error(`Session '${this.name}': Auth saved to profile: ${this.profile}`);
      } catch (e) {
        console.error(`Session '${this.name}': Warning: Failed to save auth: ${e.message}`);
      }
    }

    const result = {
      name: this.name,
      sessionId: this.sessionId,
      sessionDir: getSessionDir(this.sessionId),
      chunksRecorded: this.chunks.length,
      screenshotsTaken: this.screenshotIndex,
    };

    await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;

    return result;
  }

  nextScreenshot(name) {
    this.screenshotIndex++;
    return getScreenshotPath(this.sessionId, name, this.screenshotIndex);
  }

  isActive() {
    return this.browser !== null;
  }

  getStatus() {
    return {
      name: this.name,
      active: this.isActive(),
      sessionId: this.sessionId,
      sessionDir: this.sessionId ? getSessionDir(this.sessionId) : null,
      url: this.page?.url() || null,
      profile: this.profile,
      chunksRecorded: this.chunks.length,
      screenshotsTaken: this.screenshotIndex,
      createdAt: this.createdAt,
    };
  }
}

// Session manager - holds all active sessions
const sessions = new Map();

function getSession(name) {
  return sessions.get(name);
}

function getSessionOrDefault(requestedName) {
  // If name specified, use it
  if (requestedName) {
    return sessions.get(requestedName);
  }

  // If only one session, use it
  if (sessions.size === 1) {
    return sessions.values().next().value;
  }

  // If 'default' exists, use it
  if (sessions.has('default')) {
    return sessions.get('default');
  }

  return null;
}

function listSessions() {
  return Array.from(sessions.values()).map(s => s.getStatus());
}

// Main server
async function main() {
  const config = parseArgs();

  console.error(`Starting browser automation server...`);
  console.error(`  Port: ${config.port}`);

  // HTTP request handler
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const path = url.pathname;
    const sessionParam = url.searchParams.get('session');

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
      // GET /profiles - List available auth profiles
      if (path === '/profiles' && req.method === 'GET') {
        const profiles = listProfiles();
        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'profiles',
          profiles,
        }));
        return;
      }

      // GET /sessions - List all active sessions
      if (path === '/sessions' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'sessions',
          sessions: listSessions(),
        }));
        return;
      }

      // POST /sessions - Create a new session
      if (path === '/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const { name, url: startUrl, profile, headless } = JSON.parse(body || '{}');

        const sessionName = name || 'default';

        if (!startUrl) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'URL required. Send { "url": "...", "name": "optional-name" }' }));
          return;
        }

        // Close existing session with same name if exists
        if (sessions.has(sessionName)) {
          const existing = sessions.get(sessionName);
          await existing.stop();
          sessions.delete(sessionName);
        }

        const session = new BrowserSession(sessionName);
        const result = await session.start({ url: startUrl, profile, headless });
        sessions.set(sessionName, session);

        res.writeHead(200);
        res.end(JSON.stringify({ type: 'session_created', ...result }));
        return;
      }

      // GET /flows - List saved flows
      if (path === '/flows' && req.method === 'GET') {
        const flows = listFlows();
        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'flows',
          flows,
        }));
        return;
      }

      // POST /flows/:name/run - Run a saved flow
      const flowRunMatch = path.match(/^\/flows\/([^/]+)\/run$/);
      if (flowRunMatch && req.method === 'POST') {
        const flowName = decodeURIComponent(flowRunMatch[1]);
        const body = await readBody(req);
        const { profile, startUrl, headless } = JSON.parse(body || '{}');

        try {
          const result = await runFlow(flowName, { profile, startUrl, headless });
          res.writeHead(200);
          res.end(JSON.stringify({ type: 'flow_result', ...result }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // DELETE /sessions/:name - Close a specific session
      const deleteMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (deleteMatch && req.method === 'DELETE') {
        const sessionName = decodeURIComponent(deleteMatch[1]);
        const session = sessions.get(sessionName);

        if (!session) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Session '${sessionName}' not found` }));
          return;
        }

        const result = await session.stop();
        sessions.delete(sessionName);

        res.writeHead(200);
        res.end(JSON.stringify({ type: 'session_closed', ...result }));
        return;
      }

      // --- Session-specific endpoints below ---
      // These use ?session=name query param, or default to single/default session

      // Helper to get session for request
      const getRequestSession = async () => {
        // Check body for session param too
        let bodySession = null;
        if (req.method === 'POST') {
          // We'll parse body later, for now just use query param
        }

        const session = getSessionOrDefault(sessionParam);

        if (!session) {
          if (sessions.size === 0) {
            return {
              error: 'No active sessions. Create one with POST /sessions { "url": "...", "name": "..." }',
            };
          } else {
            return {
              error: `Multiple sessions active. Specify which with ?session=name. Active: ${Array.from(sessions.keys()).join(', ')}`,
            };
          }
        }

        return { session };
      };

      // GET /status
      if (path === '/status' && req.method === 'GET') {
        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'status',
          ...session.getStatus(),
        }));
        return;
      }

      // GET /inspect
      if (path === '/inspect' && req.method === 'GET') {
        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        const fullPage = url.searchParams.get('fullPage') === 'true';
        const screenshotPath = session.nextScreenshot('inspect');
        const inspection = await inspectPage(session.page, screenshotPath, { fullPage });
        res.writeHead(200);
        res.end(JSON.stringify({ type: 'inspection', session: session.name, inspection }));
        return;
      }

      // POST /chunk - Execute code
      if (path === '/chunk' && req.method === 'POST') {
        const body = await readBody(req);
        const { label, code, session: bodySessionName } = JSON.parse(body);

        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No code provided' }));
          return;
        }

        const chunkLabel = label || `Chunk ${session.chunks.length + 1}`;

        try {
          const asyncFn = new Function('page', `return (async () => { ${code} })();`);
          await asyncFn(session.page);
          await session.page.waitForTimeout(500);

          session.chunks.push({ index: session.chunks.length + 1, label: chunkLabel, code });

          const screenshotPath = session.nextScreenshot(`chunk-${chunkLabel}`);
          const inspection = await inspectPage(session.page, screenshotPath);
          res.writeHead(200);
          res.end(JSON.stringify({ type: 'chunk_executed', session: session.name, label: chunkLabel, inspection }));
        } catch (execError) {
          let inspection = null;
          try {
            const screenshotPath = session.nextScreenshot(`chunk-failed-${chunkLabel}`);
            inspection = await inspectPage(session.page, screenshotPath);
          } catch (e) {}
          res.writeHead(200);
          res.end(JSON.stringify({ type: 'chunk_failed', session: session.name, error: execError.message, inspection }));
        }
        return;
      }

      // POST /navigate
      if (path === '/navigate' && req.method === 'POST') {
        const body = await readBody(req);
        const { url: navUrl, fullPage } = JSON.parse(body);

        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        await session.page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await session.page.waitForTimeout(1000);

        // Extract page name from URL for screenshot
        const urlPath = new URL(navUrl, 'http://localhost').pathname;
        const pageName = urlPath.replace(/\//g, '-').replace(/^-|-$/g, '') || 'home';
        const screenshotPath = session.nextScreenshot(`navigate-${pageName}`);
        const inspection = await inspectPage(session.page, screenshotPath, { fullPage: fullPage ?? false });
        res.writeHead(200);
        res.end(JSON.stringify({ type: 'navigated', session: session.name, url: navUrl, inspection }));
        return;
      }

      // POST /save-auth
      if (path === '/save-auth' && req.method === 'POST') {
        const body = await readBody(req);
        const { profile, description } = JSON.parse(body || '{}');

        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        const profileName = profile || session.profile;
        if (!profileName) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: 'No profile specified. Send { "profile": "name", "description": "..." }',
          }));
          return;
        }

        // Check if this is a new profile (require description for new profiles)
        const existingMeta = getProfileMeta(profileName);
        if (!existingMeta && !description) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: 'Description required for new profiles. Send { "profile": "name", "description": "User type and purpose" }',
          }));
          return;
        }

        // Update session's profile
        session.profile = profileName;

        // Save auth state
        const profilePath = resolve(profilesDir, `${profileName}.json`);
        await session.context.storageState({ path: profilePath });

        // Save/update metadata
        const metaUpdate = {};
        if (description) {
          metaUpdate.description = description;
        }
        setProfileMeta(profileName, metaUpdate);

        const updatedMeta = getProfileMeta(profileName);
        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'auth_saved',
          session: session.name,
          profile: profileName,
          description: updatedMeta.description,
          path: profilePath,
        }));
        return;
      }

      // GET /review
      if (path === '/review' && req.method === 'GET') {
        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'review',
          session: session.name,
          sessionId: session.sessionId,
          sessionDir: getSessionDir(session.sessionId),
          chunks: session.chunks.map(c => ({ index: c.index, label: c.label, code: c.code })),
        }));
        return;
      }

      // POST /exit - Shutdown server entirely
      if (path === '/exit' && req.method === 'POST') {
        const results = [];
        for (const [name, session] of sessions) {
          const result = await session.stop();
          results.push(result);
        }
        sessions.clear();

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'server_shutdown',
          sessionsClosed: results,
        }));

        // Shutdown after response
        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 100);
        return;
      }

      // 404
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
      console.error('Request error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  };

  // Helper to read request body
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  // Start server
  const server = http.createServer(handler);
  server.listen(config.port, () => {
    console.error(`\nServer running on http://localhost:${config.port}`);
    console.error(`\nEndpoints:`);
    console.error(`  GET  /profiles              - List auth profiles`);
    console.error(`  GET  /sessions              - List active sessions`);
    console.error(`  POST /sessions              - Create session { name, url, profile?, headless? }`);
    console.error(`  DELETE /sessions/:name      - Close session`);
    console.error(`  GET  /flows                 - List saved flows`);
    console.error(`  POST /flows/:name/run       - Run flow { profile?, startUrl?, headless? }`);
    console.error(``);
    console.error(`  Session-specific (use ?session=name if multiple):`);
    console.error(`  GET  /status, /inspect, /review`);
    console.error(`  POST /chunk, /navigate, /save-auth`);
    console.error(``);
    console.error(`  POST /exit                  - Shutdown server`);
    console.error(`\nReady. Use POST /sessions to create a session.`);

    // Output ready signal to stdout for parsing
    console.log(JSON.stringify({
      type: 'server_ready',
      port: config.port,
      sessions: [],
    }));
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.error('\nShutting down...');
    for (const [name, session] of sessions) {
      await session.stop();
    }
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
