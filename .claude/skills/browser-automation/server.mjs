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
 *   GET  /fixtures                    - List available test fixtures (images)
 *   GET  /sessions                    - List all active sessions
 *   POST /sessions                    - Create session { name, url, profile?, headless? }
 *   DELETE /sessions/:name            - Close a specific session
 *   GET  /flows                       - List saved flows (with params)
 *   POST /flows/:name/run             - Run a flow { profile?, startUrl?, headless?, params? }
 *
 *   Session-specific (use ?session=name or defaults to 'default'):
 *   GET  /status                      - Get session status
 *   GET  /inspect                     - Get page state (inputs include label-based selectors)
 *   POST /chunk                       - Execute code { label, code }
 *   POST /fill-form                   - Fill form by labels { fields: { "Label": "value" }, fixture? }
 *   POST /navigate                    - Navigate to URL { url }
 *   POST /save-auth                   - Save auth { profile, description }
 *   GET  /review                      - Review recorded chunks
 *   POST /save-flow                   - Save chunks as flow { name, chunks?: [1,2,3], params? }
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
const fixturesDir = resolve(projectRoot, '.browser/fixtures');
const interactionsDir = resolve(projectRoot, '.browser/interactions');
const profilesMetaPath = resolve(profilesDir, 'profiles.meta.json');

// Load complex interaction helpers
function loadInteractions() {
  const indexPath = resolve(interactionsDir, 'index.js');
  if (!existsSync(indexPath)) return {};

  try {
    // Clear require cache to pick up changes
    delete require.cache[require.resolve(indexPath)];
    const interactions = require(indexPath);

    // Build helpers object for ctx
    const helpers = {};
    for (const [name, config] of Object.entries(interactions)) {
      if (typeof config.fn === 'function') {
        helpers[name] = config.fn;
      }
    }
    return helpers;
  } catch (e) {
    console.error('Failed to load interactions:', e.message);
    return {};
  }
}

// Get interaction descriptions for documentation
function getInteractionDocs() {
  const indexPath = resolve(interactionsDir, 'index.js');
  if (!existsSync(indexPath)) return [];

  try {
    delete require.cache[require.resolve(indexPath)];
    const interactions = require(indexPath);

    return Object.entries(interactions).map(([name, config]) => ({
      name,
      description: config.description,
      usage: config.usage,
      identify: config.identify,
    }));
  } catch (e) {
    return [];
  }
}

// Ensure directories exist
if (!existsSync(profilesDir)) mkdirSync(profilesDir, { recursive: true });
if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
if (!existsSync(flowsDir)) mkdirSync(flowsDir, { recursive: true });
if (!existsSync(fixturesDir)) mkdirSync(fixturesDir, { recursive: true });

// Fixture management
function listFixtures() {
  if (!existsSync(fixturesDir)) return [];
  const files = readdirSync(fixturesDir).filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
  return files.map(f => {
    const filePath = resolve(fixturesDir, f);
    const stats = statSync(filePath);
    return {
      name: f,
      path: filePath,
      size: stats.size,
    };
  });
}

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
function parseFlowMeta(content) {
  // Look for embedded JSON metadata in /* FLOW_META ... */ block
  const metaMatch = content.match(/\/\* FLOW_META\s*([\s\S]*?)\*\//);
  if (metaMatch) {
    try {
      return JSON.parse(metaMatch[1].trim());
    } catch (e) {}
  }

  // Fallback: parse from legacy comment format
  const urlMatch = content.match(/Start URL: (.+)/);
  const dateMatch = content.match(/Generated: (.+)/);
  return {
    startUrl: urlMatch ? urlMatch[1].trim() : null,
    generatedAt: dateMatch ? dateMatch[1].trim() : null,
  };
}

function listFlows() {
  const files = readdirSync(flowsDir).filter(f => f.endsWith('.js'));
  return files.map(f => {
    const name = f.replace('.js', '');
    const filePath = resolve(flowsDir, f);
    const content = readFileSync(filePath, 'utf-8');
    const stats = statSync(filePath);

    const meta = parseFlowMeta(content);

    return {
      name,
      startUrl: meta.startUrl || null,
      params: meta.params || null,
      generatedAt: meta.generatedAt || null,
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
  const { profile, startUrl: overrideUrl, headless = false, params = {} } = options;

  // Parse embedded metadata from the flow file
  const meta = parseFlowMeta(script);

  const startUrl = overrideUrl || meta.startUrl;

  if (!startUrl) {
    throw new Error('No start URL specified and could not extract from flow');
  }

  // Check for required params (only those marked required: true, or all if no required flag)
  if (meta.params) {
    const missingParams = Object.entries(meta.params)
      .filter(([k, v]) => {
        const isRequired = v.required !== false; // Default to required if not specified
        return isRequired && !(k in params);
      })
      .map(([k]) => k);
    if (missingParams.length > 0) {
      throw new Error(`Missing required params: ${missingParams.join(', ')}. Flow expects: ${JSON.stringify(meta.params)}`);
    }
  }

  // Launch browser
  const browser = await chromium.launch({ headless });

  const contextOptions = { viewport: { width: 1920, height: 969 } };
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

    // Execute the flow script with params and context
    const context = {
      fixturesDir,
      projectRoot,
    };
    const asyncFn = new Function('page', 'params', 'ctx', `return (async () => { ${script} })();`);
    await asyncFn(page, params, context);

    // Get final page state
    const finalState = await inspectPage(page);

    await browser.close();

    return {
      status: 'passed',
      flowName,
      startUrl,
      profile,
      params,
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
      params,
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

      // Try to find associated label
      let label = null;
      let labelSelector = null;

      // Method 1: label with for attribute matching input id
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${el.id}"]`);
        if (labelEl) {
          label = labelEl.textContent?.trim().replace(/\s*\*$/, '') || null; // Remove required asterisk
        }
      }

      // Method 2: label wrapping the input
      if (!label) {
        const parentLabel = el.closest('label');
        if (parentLabel) {
          // Get text content excluding the input's own text
          const clone = parentLabel.cloneNode(true);
          clone.querySelectorAll('input, textarea, select').forEach(n => n.remove());
          label = clone.textContent?.trim().replace(/\s*\*$/, '') || null;
        }
      }

      // Method 3: aria-label attribute
      if (!label && el.getAttribute('aria-label')) {
        label = el.getAttribute('aria-label');
      }

      // Method 4: placeholder as fallback label
      if (!label && el.placeholder) {
        label = el.placeholder;
      }

      // Generate label-based selector if we found a label
      if (label) {
        labelSelector = `getByLabel('${label.replace(/'/g, "\\'")}')`;
      }

      // Get role attribute (important for identifying Mantine comboboxes)
      const role = el.getAttribute('role') || null;

      // Get options for select elements
      let options = null;
      if (el.tagName === 'SELECT') {
        options = Array.from(el.options).map(opt => ({
          value: opt.value,
          text: opt.textContent?.trim() || '',
          selected: opt.selected,
        }));
      }

      inputs.push({
        type: el.type || el.tagName.toLowerCase(),
        name: el.name || el.id || '',
        selector: getSelector(el),
        label: label,
        labelSelector: labelSelector,
        role: role,
        placeholder: el.placeholder || '',
        value: el.value || '',
        options: options,
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
    // Recording state
    this.recordings = {}; // { recordingId: { startIndex, chunks: [] } }
    this.activeRecording = null;
    // Console and network logs
    this.consoleLogs = [];
    this.networkLogs = [];
    this.consoleLogIndex = 0;
    this.networkLogIndex = 0;
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

    const contextOptions = { viewport: { width: 1920, height: 969 } };
    const profilePath = profile ? resolve(profilesDir, `${profile}.json`) : null;

    if (profilePath && existsSync(profilePath)) {
      console.error(`  Loading saved auth from profile...`);
      contextOptions.storageState = profilePath;
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);

    // Set up console log capture
    this.page.on('console', msg => {
      this.consoleLogs.push({
        index: ++this.consoleLogIndex,
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
        timestamp: new Date().toISOString(),
      });
      // Keep only last 200 logs to prevent memory issues
      if (this.consoleLogs.length > 200) {
        this.consoleLogs = this.consoleLogs.slice(-200);
      }
    });

    // Set up network log capture
    this.page.on('request', request => {
      this.networkLogs.push({
        index: ++this.networkLogIndex,
        type: 'request',
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        timestamp: new Date().toISOString(),
      });
    });

    this.page.on('response', response => {
      this.networkLogs.push({
        index: ++this.networkLogIndex,
        type: 'response',
        status: response.status(),
        url: response.url(),
        timestamp: new Date().toISOString(),
      });
      // Keep only last 500 network logs to prevent memory issues
      if (this.networkLogs.length > 500) {
        this.networkLogs = this.networkLogs.slice(-500);
      }
    });

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
      consoleLogCount: this.consoleLogs.length,
      networkLogCount: this.networkLogs.length,
    };
  }

  // Get console logs since a certain index
  getConsoleLogs(sinceIndex = 0) {
    return this.consoleLogs.filter(log => log.index > sinceIndex);
  }

  // Get network logs since a certain index
  getNetworkLogs(sinceIndex = 0) {
    return this.networkLogs.filter(log => log.index > sinceIndex);
  }

  // Get current log indices (for tracking what's new)
  getLogIndices() {
    return {
      consoleIndex: this.consoleLogIndex,
      networkIndex: this.networkLogIndex,
    };
  }

  // Clear logs
  clearLogs() {
    this.consoleLogs = [];
    this.networkLogs = [];
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

      // GET /interactions - List available complex interaction helpers
      if (path === '/interactions' && req.method === 'GET') {
        const interactions = getInteractionDocs();
        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'interactions',
          interactions,
          interactionsDir,
        }));
        return;
      }

      // GET /fixtures - List available test fixtures
      if (path === '/fixtures' && req.method === 'GET') {
        const fixtures = listFixtures();
        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'fixtures',
          fixtures,
          fixturesDir,
        }));
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
        const { profile, startUrl, headless, params } = JSON.parse(body || '{}');

        try {
          const result = await runFlow(flowName, { profile, startUrl, headless, params });
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

      // GET /console - Get console logs
      if (path === '/console' && req.method === 'GET') {
        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        const sinceIndex = parseInt(url.searchParams.get('since') || '0', 10);
        const typeFilter = url.searchParams.get('type'); // e.g., 'error', 'warning', 'log'
        let logs = session.getConsoleLogs(sinceIndex);

        if (typeFilter) {
          logs = logs.filter(l => l.type === typeFilter);
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'console_logs',
          session: session.name,
          currentIndex: session.consoleLogIndex,
          logs,
        }));
        return;
      }

      // GET /network - Get network logs
      if (path === '/network' && req.method === 'GET') {
        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        const sinceIndex = parseInt(url.searchParams.get('since') || '0', 10);
        const typeFilter = url.searchParams.get('type'); // 'request' or 'response'
        const statusFilter = url.searchParams.get('status'); // e.g., '4xx', '5xx', '200'
        let logs = session.getNetworkLogs(sinceIndex);

        if (typeFilter) {
          logs = logs.filter(l => l.type === typeFilter);
        }

        if (statusFilter) {
          if (statusFilter === '4xx') {
            logs = logs.filter(l => l.status >= 400 && l.status < 500);
          } else if (statusFilter === '5xx') {
            logs = logs.filter(l => l.status >= 500);
          } else if (statusFilter === 'error') {
            logs = logs.filter(l => l.status >= 400);
          } else {
            const targetStatus = parseInt(statusFilter, 10);
            logs = logs.filter(l => l.status === targetStatus);
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'network_logs',
          session: session.name,
          currentIndex: session.networkLogIndex,
          logs,
        }));
        return;
      }

      // POST /clear-logs - Clear console and network logs
      if (path === '/clear-logs' && req.method === 'POST') {
        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        session.clearLogs();

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'logs_cleared',
          session: session.name,
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

        // Capture log indices before execution
        const logIndicesBefore = session.getLogIndices();

        try {
          const asyncFn = new Function('page', `return (async () => { ${code} })();`);
          const returnValue = await asyncFn(session.page);
          await session.page.waitForTimeout(500);

          session.chunks.push({ index: session.chunks.length + 1, label: chunkLabel, code });

          // Get logs that occurred during chunk execution
          const consoleLogs = session.getConsoleLogs(logIndicesBefore.consoleIndex);
          const networkLogs = session.getNetworkLogs(logIndicesBefore.networkIndex);

          const screenshotPath = session.nextScreenshot(`chunk-${chunkLabel}`);
          const inspection = await inspectPage(session.page, screenshotPath);
          res.writeHead(200);
          res.end(JSON.stringify({
            type: 'chunk_executed',
            session: session.name,
            label: chunkLabel,
            returnValue: returnValue !== undefined ? returnValue : undefined,
            inspection,
            consoleLogs: consoleLogs.length > 0 ? consoleLogs : undefined,
            networkLogs: networkLogs.length > 0 ? networkLogs.slice(-20) : undefined, // Limit network logs in response
          }));
        } catch (execError) {
          // Get logs that occurred during chunk execution (including error)
          const consoleLogs = session.getConsoleLogs(logIndicesBefore.consoleIndex);
          const networkLogs = session.getNetworkLogs(logIndicesBefore.networkIndex);

          let inspection = null;
          try {
            const screenshotPath = session.nextScreenshot(`chunk-failed-${chunkLabel}`);
            inspection = await inspectPage(session.page, screenshotPath);
          } catch (e) {}
          res.writeHead(200);
          res.end(JSON.stringify({
            type: 'chunk_failed',
            session: session.name,
            error: execError.message,
            inspection,
            consoleLogs: consoleLogs.length > 0 ? consoleLogs : undefined,
            networkLogs: networkLogs.length > 0 ? networkLogs.slice(-20) : undefined,
          }));
        }
        return;
      }

      // POST /fill-form - Fill form fields by label
      if (path === '/fill-form' && req.method === 'POST') {
        const body = await readBody(req);
        const { fields, fixture } = JSON.parse(body);

        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        if (!fields || typeof fields !== 'object') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'fields object required. Send { "fields": { "Label": "value", ... } }' }));
          return;
        }

        const results = [];
        const errors = [];

        for (const [label, value] of Object.entries(fields)) {
          try {
            // Try multiple strategies to find and fill the field
            const filled = await session.page.evaluate(async ({ label, value }) => {
              // Helper to find input by label
              function findInputByLabel(labelText) {
                // Strategy 1: label[for] -> input[id]
                const labels = Array.from(document.querySelectorAll('label'));
                for (const lbl of labels) {
                  const text = lbl.textContent?.trim().replace(/\s*\*$/, '');
                  if (text && text.toLowerCase() === labelText.toLowerCase()) {
                    if (lbl.htmlFor) {
                      return document.getElementById(lbl.htmlFor);
                    }
                    // Strategy 2: input inside label
                    const input = lbl.querySelector('input, textarea, select');
                    if (input) return input;
                  }
                }

                // Strategy 3: aria-label
                const ariaInput = document.querySelector(`[aria-label="${labelText}" i]`);
                if (ariaInput) return ariaInput;

                // Strategy 4: placeholder
                const placeholderInput = document.querySelector(`input[placeholder="${labelText}" i], textarea[placeholder="${labelText}" i]`);
                if (placeholderInput) return placeholderInput;

                // Strategy 5: partial match on label text
                for (const lbl of labels) {
                  const text = lbl.textContent?.trim().replace(/\s*\*$/, '');
                  if (text && text.toLowerCase().includes(labelText.toLowerCase())) {
                    if (lbl.htmlFor) {
                      return document.getElementById(lbl.htmlFor);
                    }
                    const input = lbl.querySelector('input, textarea, select');
                    if (input) return input;
                  }
                }

                return null;
              }

              const input = findInputByLabel(label);
              if (!input) return { found: false };

              // Return element info for Playwright to fill
              return {
                found: true,
                tagName: input.tagName,
                type: input.type,
                id: input.id,
                name: input.name,
              };
            }, { label, value });

            if (!filled.found) {
              errors.push({ label, error: 'Field not found' });
              continue;
            }

            // Use Playwright to fill based on what we found
            let selector = filled.id ? `#${filled.id}` : `[name="${filled.name}"]`;

            if (filled.tagName === 'SELECT') {
              await session.page.selectOption(selector, value);
            } else {
              await session.page.fill(selector, value);
            }

            results.push({ label, filled: true, selector });

          } catch (fieldError) {
            errors.push({ label, error: fieldError.message });
          }
        }

        // Handle file fixture if specified
        if (fixture) {
          try {
            const fixturePath = resolve(fixturesDir, fixture);
            if (!existsSync(fixturePath)) {
              errors.push({ fixture, error: `Fixture not found: ${fixture}` });
            } else {
              const fileInput = session.page.locator('input[type="file"]').first();
              await fileInput.setInputFiles(fixturePath);
              results.push({ fixture, uploaded: true, path: fixturePath });
            }
          } catch (fixtureError) {
            errors.push({ fixture, error: fixtureError.message });
          }
        }

        await session.page.waitForTimeout(500);

        // Record as a chunk for flow recording
        const chunkLabel = `fill-form-${Object.keys(fields).length}-fields`;
        const code = Object.entries(fields).map(([l, v]) =>
          `await page.getByLabel('${l}').fill('${v}');`
        ).join('\n');
        session.chunks.push({ index: session.chunks.length + 1, label: chunkLabel, code, params: fields });

        const screenshotPath = session.nextScreenshot(chunkLabel);
        const inspection = await inspectPage(session.page, screenshotPath);

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'form_filled',
          session: session.name,
          results,
          errors: errors.length > 0 ? errors : undefined,
          inspection,
        }));
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

      // POST /run-flow - Run a flow within the current session (interactive, debuggable)
      if (path === '/run-flow' && req.method === 'POST') {
        const body = await readBody(req);
        const { flow: flowName, params = {} } = JSON.parse(body || '{}');

        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        if (!flowName) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'flow name required. Send { "flow": "flow-name", "params": {...} }' }));
          return;
        }

        const flowPath = resolve(flowsDir, `${flowName}.js`);
        if (!existsSync(flowPath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Flow not found: ${flowName}` }));
          return;
        }

        const script = readFileSync(flowPath, 'utf-8');
        const meta = parseFlowMeta(script);

        // Check for required params
        if (meta.params) {
          const missingParams = Object.entries(meta.params)
            .filter(([k, v]) => {
              const isRequired = v.required !== false;
              return isRequired && !(k in params);
            })
            .map(([k]) => k);
          if (missingParams.length > 0) {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: `Missing required params: ${missingParams.join(', ')}`,
              flow: flowName,
              expectedParams: meta.params,
            }));
            return;
          }
        }

        try {
          // Parse chunks from flow for step tracking
          const chunkMatches = script.matchAll(/\/\/\s*(.+?)\n([^]*?)(?=\/\/\s*\w|$)/g);
          const flowChunks = Array.from(chunkMatches).map((m, i) => ({
            index: i + 1,
            label: m[1].trim(),
            code: m[2].trim(),
          })).filter(c => c.code.length > 0);

          // Execute flow in current session context with step tracking
          const context = { fixturesDir, projectRoot };
          let currentStep = 0;
          let lastCompletedStep = null;

          // Load interaction helpers into context
          const interactions = loadInteractions();
          for (const [name, fn] of Object.entries(interactions)) {
            // Bind page to helper functions
            context[name] = (...args) => fn(session.page, ...args);
          }

          // Execute each chunk separately for better error tracking
          if (flowChunks.length > 0) {
            for (const chunk of flowChunks) {
              currentStep = chunk.index;
              try {
                const asyncFn = new Function('page', 'params', 'ctx', `return (async () => { ${chunk.code} })();`);
                await asyncFn(session.page, params, context);
                lastCompletedStep = chunk.label;
              } catch (stepError) {
                // Step failed - report which one
                let inspection = null;
                try {
                  const screenshotPath = session.nextScreenshot(`flow-${flowName}-failed-step-${currentStep}`);
                  inspection = await inspectPage(session.page, screenshotPath);
                } catch (e) {}

                res.writeHead(200);
                res.end(JSON.stringify({
                  type: 'flow_executed',
                  session: session.name,
                  flow: flowName,
                  status: 'failed',
                  failedAtStep: currentStep,
                  failedAtLabel: chunk.label,
                  lastCompletedStep,
                  totalSteps: flowChunks.length,
                  error: stepError.message,
                  params,
                  inspection,
                  hint: 'Session is still active. Use /inspect to see current state, or /chunk to continue manually.',
                }));
                return;
              }
            }
          } else {
            // No chunks detected, run as single block
            const asyncFn = new Function('page', 'params', 'ctx', `return (async () => { ${script} })();`);
            await asyncFn(session.page, params, context);
          }

          // Record as a chunk
          session.chunks.push({
            index: session.chunks.length + 1,
            label: `run-flow-${flowName}`,
            code: `// Ran flow: ${flowName}\n// Params: ${JSON.stringify(params)}`,
            params,
          });

          const screenshotPath = session.nextScreenshot(`flow-${flowName}-complete`);
          const inspection = await inspectPage(session.page, screenshotPath);

          res.writeHead(200);
          res.end(JSON.stringify({
            type: 'flow_executed',
            session: session.name,
            flow: flowName,
            status: 'passed',
            stepsCompleted: flowChunks.length || 1,
            params,
            inspection,
          }));

        } catch (flowError) {
          // Flow failed but session is still alive - take screenshot for debugging
          let inspection = null;
          try {
            const screenshotPath = session.nextScreenshot(`flow-${flowName}-failed`);
            inspection = await inspectPage(session.page, screenshotPath);
          } catch (e) {}

          res.writeHead(200);
          res.end(JSON.stringify({
            type: 'flow_executed',
            session: session.name,
            flow: flowName,
            status: 'failed',
            error: flowError.message,
            params,
            inspection,
            hint: 'Session is still active. Use /inspect to see current state, or /chunk to continue manually.',
          }));
        }
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
          startUrl: session.startUrl,
          chunks: session.chunks.map(c => ({
            index: c.index,
            label: c.label,
            code: c.code,
            params: c.params || null,
          })),
        }));
        return;
      }

      // POST /start-recording - Start recording chunks with an ID
      if (path === '/start-recording' && req.method === 'POST') {
        const body = await readBody(req);
        const { id } = JSON.parse(body || '{}');

        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        const recordingId = id || `recording-${Date.now()}`;

        if (session.recordings[recordingId]) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Recording '${recordingId}' already exists. Use a different ID or stop it first.` }));
          return;
        }

        session.recordings[recordingId] = {
          startIndex: session.chunks.length,
          startedAt: new Date().toISOString(),
          startUrl: session.page?.url() || null,
        };
        session.activeRecording = recordingId;

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'recording_started',
          session: session.name,
          recordingId,
          startUrl: session.recordings[recordingId].startUrl,
        }));
        return;
      }

      // POST /stop-recording - Stop recording and get chunks
      if (path === '/stop-recording' && req.method === 'POST') {
        const body = await readBody(req);
        const { id } = JSON.parse(body || '{}');

        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        const recordingId = id || session.activeRecording;

        if (!recordingId || !session.recordings[recordingId]) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: 'No active recording. Start one with POST /start-recording { "id": "my-recording" }',
            activeRecording: session.activeRecording,
            recordings: Object.keys(session.recordings),
          }));
          return;
        }

        const recording = session.recordings[recordingId];
        const recordedChunks = session.chunks.slice(recording.startIndex);

        recording.stoppedAt = new Date().toISOString();
        recording.endUrl = session.page?.url() || null;
        recording.chunks = recordedChunks;

        if (session.activeRecording === recordingId) {
          session.activeRecording = null;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'recording_stopped',
          session: session.name,
          recordingId,
          startUrl: recording.startUrl,
          endUrl: recording.endUrl,
          chunksRecorded: recordedChunks.length,
          chunks: recordedChunks.map(c => ({
            index: c.index,
            label: c.label,
            code: c.code,
            params: c.params || null,
          })),
        }));
        return;
      }

      // GET /recordings - List all recordings in session
      if (path === '/recordings' && req.method === 'GET') {
        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        const recordings = Object.entries(session.recordings).map(([id, r]) => ({
          id,
          startUrl: r.startUrl,
          endUrl: r.endUrl,
          startedAt: r.startedAt,
          stoppedAt: r.stoppedAt,
          chunksRecorded: r.chunks?.length || (session.chunks.length - r.startIndex),
          isActive: session.activeRecording === id,
        }));

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'recordings',
          session: session.name,
          activeRecording: session.activeRecording,
          recordings,
        }));
        return;
      }

      // POST /save-flow - Save selected chunks as a reusable flow
      if (path === '/save-flow' && req.method === 'POST') {
        const body = await readBody(req);
        const { name, chunks: chunkIndices, recording: recordingId, params: paramDefs } = JSON.parse(body || '{}');

        const { session, error } = await getRequestSession();
        if (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error }));
          return;
        }

        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Flow name required. Send { "name": "flow-name", "chunks": [1, 2, 3] } or { "name": "flow-name", "recording": "recording-id" }' }));
          return;
        }

        // Get selected chunks from recording, indices, or all
        let selectedChunks = session.chunks;
        let startUrl = session.startUrl;

        if (recordingId && session.recordings[recordingId]) {
          const recording = session.recordings[recordingId];
          selectedChunks = recording.chunks || session.chunks.slice(recording.startIndex);
          startUrl = recording.startUrl || startUrl;
        } else if (chunkIndices && Array.isArray(chunkIndices)) {
          selectedChunks = session.chunks.filter(c => chunkIndices.includes(c.index));
        }

        if (selectedChunks.length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No chunks to save. Record some actions first.' }));
          return;
        }

        // Collect all params used in chunks
        const collectedParams = {};
        selectedChunks.forEach(c => {
          if (c.params) {
            Object.entries(c.params).forEach(([k, v]) => {
              if (!collectedParams[k]) {
                collectedParams[k] = { example: v, usedIn: [] };
              }
              collectedParams[k].usedIn.push(c.label);
            });
          }
        });

        // Merge with explicit param definitions
        const finalParams = { ...collectedParams };
        if (paramDefs && typeof paramDefs === 'object') {
          Object.entries(paramDefs).forEach(([k, v]) => {
            finalParams[k] = { ...finalParams[k], ...v };
          });
        }

        // Generate the flow script - wrap each chunk in IIFE to prevent variable conflicts
        const flowCode = selectedChunks.map(c => {
          let code = c.code;
          // Replace hardcoded values with params references if params exist
          if (c.params) {
            Object.entries(c.params).forEach(([key, value]) => {
              // Escape special regex characters in the value
              const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              code = code.replace(new RegExp(`'${escapedValue}'`, 'g'), `params['${key}']`);
              code = code.replace(new RegExp(`"${escapedValue}"`, 'g'), `params["${key}"]`);
            });
          }
          // Wrap in IIFE to isolate variable scope between chunks
          return `// ${c.label}\nawait (async () => {\n${code}\n})();`;
        }).join('\n\n');

        // Build embedded metadata
        const flowMeta = {
          name,
          startUrl: startUrl,
          params: Object.keys(finalParams).length > 0 ? finalParams : undefined,
          generatedAt: new Date().toISOString(),
          generatedFrom: session.sessionId,
        };

        // Build the flow file content with embedded metadata
        const flowContent = `/* FLOW_META
${JSON.stringify(flowMeta, null, 2)}
*/

/**
 * Flow: ${name}
 * Generated: ${flowMeta.generatedAt}
 * Start URL: ${startUrl}
 *
 * Parameters:
${Object.keys(finalParams).length > 0
  ? Object.entries(finalParams).map(([k, v]) => ` *   ${k}: ${v.example ? `(example: "${v.example}")` : ''}`).join('\n')
  : ' *   (none)'}
 *
 * Usage:
 *   curl -X POST http://localhost:9222/flows/${name}/run \\
 *     -d '{"profile": "...", "params": {...}}'
 */

${flowCode}
`;

        // Save the flow (single self-contained file)
        const flowPath = resolve(flowsDir, `${name}.js`);
        writeFileSync(flowPath, flowContent);

        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'flow_saved',
          name,
          path: flowPath,
          startUrl,
          params: finalParams,
          chunksIncluded: selectedChunks.length,
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
    console.error(`  GET  /fixtures              - List test fixtures (images for uploads)`);
    console.error(`  GET  /sessions              - List active sessions`);
    console.error(`  POST /sessions              - Create session { name, url, profile?, headless? }`);
    console.error(`  DELETE /sessions/:name      - Close session`);
    console.error(`  GET  /flows                 - List saved flows (with params)`);
    console.error(`  POST /flows/:name/run       - Run flow { profile?, startUrl?, params? }`);
    console.error(``);
    console.error(`  Session-specific (use ?session=name if multiple):`);
    console.error(`  GET  /status, /inspect, /review`);
    console.error(`  POST /chunk, /fill-form, /navigate, /save-auth, /save-flow`);
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
