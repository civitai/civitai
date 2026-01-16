#!/usr/bin/env node
/**
 * Browser Automation Server
 *
 * HTTP server that manages a browser session and accepts commands.
 * Run in background, send commands via HTTP.
 *
 * Usage:
 *   node server.mjs --url <url> [--profile <name>] [--port <port>]
 *
 * Endpoints:
 *   GET  /status          - Check if server is running
 *   GET  /inspect         - Get current page state
 *   POST /chunk           - Execute code chunk { label, code }
 *   POST /navigate        - Navigate to URL { url }
 *   POST /save-auth       - Save auth to profile
 *   POST /exit            - Close browser and shutdown server
 */

import http from 'http';
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../../..');
const profilesDir = resolve(projectRoot, '.browser/profiles');
const sessionsDir = resolve(projectRoot, '.browser/sessions');

// Ensure directories exist
if (!existsSync(profilesDir)) mkdirSync(profilesDir, { recursive: true });
if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

// Parse args
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    url: 'http://localhost:3000',
    profile: null,
    port: 9222,
    headless: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
        config.url = args[++i];
        break;
      case '--profile':
      case '-p':
        config.profile = args[++i];
        break;
      case '--port':
        config.port = parseInt(args[++i], 10);
        break;
      case '--headless':
        config.headless = true;
        break;
    }
  }

  return config;
}

// Page inspection
async function inspectPage(page) {
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

  return inspection;
}

// Main server
async function main() {
  const config = parseArgs();
  const profilePath = config.profile ? resolve(profilesDir, `${config.profile}.json`) : null;

  console.error(`Starting browser automation server...`);
  console.error(`  URL: ${config.url}`);
  console.error(`  Profile: ${config.profile || '(none)'}`);
  console.error(`  Port: ${config.port}`);

  // Launch browser
  const browser = await chromium.launch({ headless: config.headless });

  const contextOptions = { viewport: { width: 1280, height: 720 } };
  if (profilePath && existsSync(profilePath)) {
    console.error(`  Loading saved auth from profile...`);
    contextOptions.storageState = profilePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Navigate to initial URL
  console.error(`  Navigating to ${config.url}...`);
  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(2000);
  console.error(`  Page loaded.`);

  // Track chunks for review
  const chunks = [];

  // HTTP request handler
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
      // GET /status
      if (path === '/status' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'running',
          url: page.url(),
          profile: config.profile,
          chunksRecorded: chunks.length,
        }));
        return;
      }

      // GET /inspect
      if (path === '/inspect' && req.method === 'GET') {
        const inspection = await inspectPage(page);
        res.writeHead(200);
        res.end(JSON.stringify({ type: 'inspection', inspection }));
        return;
      }

      // POST /chunk - Execute code
      if (path === '/chunk' && req.method === 'POST') {
        const body = await readBody(req);
        const { label, code } = JSON.parse(body);

        if (!code) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No code provided' }));
          return;
        }

        try {
          const asyncFn = new Function('page', `return (async () => { ${code} })();`);
          await asyncFn(page);
          await page.waitForTimeout(500);

          chunks.push({ index: chunks.length + 1, label: label || `Chunk ${chunks.length + 1}`, code });

          const inspection = await inspectPage(page);
          res.writeHead(200);
          res.end(JSON.stringify({ type: 'chunk_executed', label, inspection }));
        } catch (execError) {
          const inspection = await inspectPage(page).catch(() => null);
          res.writeHead(200);
          res.end(JSON.stringify({ type: 'chunk_failed', error: execError.message, inspection }));
        }
        return;
      }

      // POST /navigate
      if (path === '/navigate' && req.method === 'POST') {
        const body = await readBody(req);
        const { url: navUrl } = JSON.parse(body);

        await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1000);

        const inspection = await inspectPage(page);
        res.writeHead(200);
        res.end(JSON.stringify({ type: 'navigated', url: navUrl, inspection }));
        return;
      }

      // POST /save-auth
      if (path === '/save-auth' && req.method === 'POST') {
        if (!config.profile) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No profile specified. Start server with --profile <name>' }));
          return;
        }

        await context.storageState({ path: profilePath });
        res.writeHead(200);
        res.end(JSON.stringify({ type: 'auth_saved', profile: config.profile, path: profilePath }));
        return;
      }

      // GET /review
      if (path === '/review' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          type: 'review',
          chunks: chunks.map(c => ({ index: c.index, label: c.label, code: c.code })),
        }));
        return;
      }

      // POST /exit
      if (path === '/exit' && req.method === 'POST') {
        // Auto-save auth if using profile
        if (config.profile) {
          await context.storageState({ path: profilePath });
          console.error(`Auth saved to profile: ${config.profile}`);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ type: 'session_ended', chunksRecorded: chunks.length }));

        // Shutdown after response
        setTimeout(async () => {
          await browser.close();
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
    console.error(`  GET  /status     - Check server status`);
    console.error(`  GET  /inspect    - Get current page state`);
    console.error(`  POST /chunk      - Execute code { label, code }`);
    console.error(`  POST /navigate   - Go to URL { url }`);
    console.error(`  POST /save-auth  - Save auth to profile`);
    console.error(`  POST /exit       - Close and shutdown`);
    console.error(`\nBrowser is open. You can interact manually or send commands.`);

    // Output ready signal to stdout for parsing
    console.log(JSON.stringify({ type: 'server_ready', port: config.port, url: config.url }));
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.error('\nShutting down...');
    if (config.profile) {
      await context.storageState({ path: profilePath });
      console.error(`Auth saved to profile: ${config.profile}`);
    }
    await browser.close();
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
