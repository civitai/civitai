/**
 * Session Manager
 *
 * Manages browser sessions for exploration.
 * For persistent sessions, use the REPL mode (--explore-repl).
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, rmdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { createInterface } from 'readline';
import { inspectPage } from './inspector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../../..');
const sessionsDir = resolve(projectRoot, '.browser/sessions');
const flowsDir = resolve(projectRoot, '.browser/flows');
const profilesDir = resolve(projectRoot, '.browser/profiles');

// Ensure directories exist
function ensureDirs() {
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
  if (!existsSync(flowsDir)) mkdirSync(flowsDir, { recursive: true });
  if (!existsSync(profilesDir)) mkdirSync(profilesDir, { recursive: true });
}

/**
 * Get profile file path
 */
function getProfilePath(profileName) {
  return resolve(profilesDir, `${profileName}.json`);
}

/**
 * Check if profile exists
 */
function profileExists(profileName) {
  return existsSync(getProfilePath(profileName));
}

/**
 * Generate a short session ID
 */
function generateSessionId() {
  return randomBytes(4).toString('hex');
}

/**
 * Get session folder path
 */
function getSessionDir(sessionId) {
  return resolve(sessionsDir, sessionId);
}

/**
 * Get session JSON file path
 */
function getSessionPath(sessionId) {
  return resolve(getSessionDir(sessionId), 'session.json');
}

/**
 * Get screenshots folder path
 */
function getScreenshotsDir(sessionId) {
  return resolve(getSessionDir(sessionId), 'screenshots');
}

/**
 * Ensure session directories exist
 */
function ensureSessionDirs(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  const screenshotsDir = getScreenshotsDir(sessionId);
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true });
}

/**
 * Generate screenshot path for a session
 */
function getScreenshotPath(sessionId, name, index) {
  const screenshotsDir = getScreenshotsDir(sessionId);
  const paddedIndex = String(index).padStart(3, '0');
  // Sanitize name for filesystem
  const safeName = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().substring(0, 50);
  return resolve(screenshotsDir, `${paddedIndex}-${safeName}.png`);
}

/**
 * Load session data from file
 */
function loadSession(sessionId) {
  const path = getSessionPath(sessionId);
  if (!existsSync(path)) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Save session data to file
 */
function saveSession(sessionId, data) {
  ensureDirs();
  ensureSessionDirs(sessionId);
  const path = getSessionPath(sessionId);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Delete session folder
 */
function deleteSession(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  if (existsSync(sessionDir)) {
    // Remove all files in screenshots
    const screenshotsDir = getScreenshotsDir(sessionId);
    if (existsSync(screenshotsDir)) {
      for (const file of readdirSync(screenshotsDir)) {
        unlinkSync(resolve(screenshotsDir, file));
      }
      rmdirSync(screenshotsDir);
    }
    // Remove session.json
    const sessionPath = getSessionPath(sessionId);
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
    // Remove session folder
    rmdirSync(sessionDir);
  }
}

/**
 * Interactive REPL exploration session
 * Browser stays open and accepts commands via stdin
 */
export async function startExploreRepl(url, options = {}) {
  ensureDirs();

  const sessionId = generateSessionId();
  const headless = options.headless ?? false;
  const profileName = options.profile || null;

  // Create session directories
  ensureSessionDirs(sessionId);

  console.error(`Starting exploration session: ${sessionId}`);
  console.error(`Session folder: ${getSessionDir(sessionId)}`);
  if (profileName) {
    console.error(`Using profile: ${profileName}`);
    if (profileExists(profileName)) {
      console.error(`  (loading saved auth)`);
    } else {
      console.error(`  (new profile - use {"cmd": "save-auth"} to save)`);
    }
  }
  console.error(`Opening: ${url}`);

  // Launch browser
  const browser = await chromium.launch({ headless });

  // Context options - include storageState if profile exists
  const contextOptions = {
    viewport: { width: 1280, height: 720 },
  };

  // Load profile if it exists
  if (profileName && profileExists(profileName)) {
    contextOptions.storageState = getProfilePath(profileName);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Navigate to starting URL (use longer timeout for slow dev servers)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(2000);

  // Session state
  const chunks = [];
  let currentUrl = page.url();
  let screenshotIndex = 0;

  // Helper to get next screenshot path
  const nextScreenshot = (name) => {
    screenshotIndex++;
    return getScreenshotPath(sessionId, name, screenshotIndex);
  };

  // Get and output initial inspection
  const screenshotPath = nextScreenshot('session-start');
  const inspection = await inspectPage(page, { screenshotPath });
  outputJson({
    type: 'session_started',
    sessionId,
    sessionDir: getSessionDir(sessionId),
    inspection,
  });

  // Set up readline for commands
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // Don't interfere with JSON output
    terminal: false,
  });

  console.error('\nSession ready. Commands: chunk, inspect, review, save, exit');
  console.error('Format: {"cmd": "chunk", "label": "...", "code": "..."}');

  // Process commands
  for await (const line of rl) {
    if (!line.trim()) continue;

    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (e) {
      outputJson({ type: 'error', message: 'Invalid JSON command' });
      continue;
    }

    try {
      switch (cmd.cmd) {
        case 'chunk': {
          // Execute a code chunk
          const label = cmd.label || `Chunk ${chunks.length + 1}`;
          const code = cmd.code;

          if (!code) {
            outputJson({ type: 'error', message: 'No code provided' });
            break;
          }

          try {
            const asyncFn = new Function('page', `return (async () => { ${code} })();`);
            await asyncFn(page);
            await page.waitForTimeout(500);

            // Record chunk
            const chunkIndex = chunks.length + 1;
            chunks.push({
              index: chunkIndex,
              label,
              code,
              timestamp: new Date().toISOString(),
              urlAfter: page.url(),
            });
            currentUrl = page.url();

            // Get inspection with session screenshot
            const screenshotPath = nextScreenshot(`chunk-${label}`);
            const inspection = await inspectPage(page, { screenshotPath });
            outputJson({
              type: 'chunk_executed',
              chunkIndex,
              label,
              inspection,
            });
          } catch (execError) {
            let inspection = null;
            try {
              const screenshotPath = nextScreenshot(`chunk-failed-${cmd.label || 'unknown'}`);
              inspection = await inspectPage(page, { screenshotPath });
            } catch (e) {}
            outputJson({
              type: 'chunk_failed',
              error: execError.message,
              inspection,
            });
          }
          break;
        }

        case 'inspect': {
          const screenshotPath = nextScreenshot('inspect');
          const inspection = await inspectPage(page, { screenshotPath });
          outputJson({ type: 'inspection', inspection });
          break;
        }

        case 'review': {
          outputJson({
            type: 'review',
            sessionId,
            startUrl: url,
            currentUrl,
            chunks: chunks.map(c => ({
              index: c.index,
              label: c.label,
              code: c.code,
            })),
          });
          break;
        }

        case 'list-flows': {
          // List available flows
          const flows = listFlowsInternal();
          outputJson({
            type: 'flows_list',
            flows: flows.map(f => ({ name: f.name, startUrl: f.startUrl })),
          });
          break;
        }

        case 'flow': {
          // Run a saved flow as a chunk
          const flowName = cmd.name;
          if (!flowName) {
            outputJson({ type: 'error', message: 'No flow name provided' });
            break;
          }

          const flowPath = resolve(flowsDir, `${flowName}.js`);
          if (!existsSync(flowPath)) {
            outputJson({ type: 'error', message: `Flow not found: ${flowName}` });
            break;
          }

          const flowScript = readFileSync(flowPath, 'utf-8');

          // Extract just the code (skip the header comments)
          const codeLines = flowScript.split('\n').filter(line => {
            return !line.startsWith('/**') &&
                   !line.startsWith(' *') &&
                   !line.startsWith('*/') &&
                   line.trim() !== '';
          });
          const flowCode = codeLines.join('\n');

          try {
            const asyncFn = new Function('page', `return (async () => { ${flowCode} })();`);
            await asyncFn(page);
            await page.waitForTimeout(500);

            // Record as a chunk
            const chunkIndex = chunks.length + 1;
            chunks.push({
              index: chunkIndex,
              label: `[flow: ${flowName}]`,
              code: flowCode,
              timestamp: new Date().toISOString(),
              urlAfter: page.url(),
              isFlow: true,
              flowName,
            });
            currentUrl = page.url();

            const screenshotPath = nextScreenshot(`flow-${flowName}`);
            const inspection = await inspectPage(page, { screenshotPath });
            outputJson({
              type: 'flow_executed',
              chunkIndex,
              flowName,
              inspection,
            });
          } catch (execError) {
            let inspection = null;
            try {
              const screenshotPath = nextScreenshot(`flow-failed-${flowName}`);
              inspection = await inspectPage(page, { screenshotPath });
            } catch (e) {}
            outputJson({
              type: 'flow_failed',
              flowName,
              error: execError.message,
              inspection,
            });
          }
          break;
        }

        case 'save': {
          const flowName = cmd.name;
          const keepIndexes = cmd.keep;

          if (!flowName) {
            outputJson({ type: 'error', message: 'No flow name provided' });
            break;
          }

          if (!keepIndexes || keepIndexes.length === 0) {
            outputJson({ type: 'error', message: 'No chunks selected (use "keep": [1,2,3])' });
            break;
          }

          const selectedChunks = chunks.filter(c => keepIndexes.includes(c.index));
          if (selectedChunks.length === 0) {
            outputJson({ type: 'error', message: 'No matching chunks found' });
            break;
          }

          // Build script
          const scriptLines = [
            `/**`,
            ` * Flow: ${flowName}`,
            ` * Generated: ${new Date().toISOString()}`,
            ` * Start URL: ${url}`,
            ` */`,
            ``,
          ];

          for (const chunk of selectedChunks) {
            scriptLines.push(`// --- ${chunk.label} ---`);
            scriptLines.push(chunk.code);
            scriptLines.push(``);
          }

          const script = scriptLines.join('\n');

          // Save
          ensureDirs();
          const flowPath = resolve(flowsDir, `${flowName}.js`);
          writeFileSync(flowPath, script);

          outputJson({
            type: 'flow_saved',
            flowName,
            flowPath,
            chunksIncluded: selectedChunks.map(c => c.index),
            script,
          });
          break;
        }

        case 'save-auth': {
          // Save current browser auth state to profile
          if (!profileName) {
            outputJson({
              type: 'error',
              message: 'No profile specified. Start session with --profile <name> to use auth persistence.',
            });
            break;
          }

          try {
            const profilePath = getProfilePath(profileName);
            await context.storageState({ path: profilePath });
            outputJson({
              type: 'auth_saved',
              profile: profileName,
              path: profilePath,
            });
          } catch (saveError) {
            outputJson({
              type: 'error',
              message: `Failed to save auth: ${saveError.message}`,
            });
          }
          break;
        }

        case 'exit': {
          // Auto-save auth on exit if using a profile
          if (profileName) {
            try {
              const profilePath = getProfilePath(profileName);
              await context.storageState({ path: profilePath });
              console.error(`Auth saved to profile: ${profileName}`);
            } catch (e) {
              console.error(`Warning: Failed to save auth on exit: ${e.message}`);
            }
          }
          outputJson({ type: 'session_ended', sessionId, totalChunks: chunks.length });
          await browser.close();
          process.exit(0);
        }

        default:
          outputJson({ type: 'error', message: `Unknown command: ${cmd.cmd}` });
      }
    } catch (cmdError) {
      outputJson({ type: 'error', message: cmdError.message });
    }
  }

  // EOF - cleanup
  await browser.close();
}

/**
 * Output JSON to stdout (for agent consumption)
 */
function outputJson(obj) {
  console.log(JSON.stringify(obj));
}

/**
 * Run a saved flow
 */
export async function runFlow(flowName, options = {}) {
  ensureDirs();

  const flowPath = resolve(flowsDir, `${flowName}.js`);

  if (!existsSync(flowPath)) {
    throw new Error(`Flow not found: ${flowName}`);
  }

  const script = readFileSync(flowPath, 'utf-8');
  const profileName = options.profile || null;

  // Extract start URL from script comments
  const urlMatch = script.match(/Start URL: (.+)/);
  const startUrl = options.startUrl || (urlMatch ? urlMatch[1] : null);

  if (!startUrl) {
    throw new Error('No start URL specified and could not extract from flow');
  }

  // Launch browser
  const browser = await chromium.launch({
    headless: options.headless ?? false,
  });

  // Context options - include storageState if profile exists
  const contextOptions = {
    viewport: { width: 1280, height: 720 },
  };

  if (profileName && profileExists(profileName)) {
    contextOptions.storageState = getProfilePath(profileName);
  }

  const context = await browser.newContext(contextOptions);

  const page = await context.newPage();
  page.setDefaultTimeout(options.timeout || 30000);

  try {
    // Navigate to start URL
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Execute the flow script
    const asyncFn = new Function('page', `return (async () => { ${script} })();`);
    await asyncFn(page);

    // Get final inspection
    const inspection = await inspectPage(page);

    await browser.close();

    return {
      status: 'passed',
      flowName,
      inspection,
    };

  } catch (error) {
    let inspection = null;
    try {
      inspection = await inspectPage(page);
    } catch (e) {}

    await browser.close();

    return {
      status: 'failed',
      flowName,
      error: error.message,
      inspection,
    };
  }
}

/**
 * List all saved flows (internal)
 */
function listFlowsInternal() {
  ensureDirs();
  const files = readdirSync(flowsDir).filter(f => f.endsWith('.js'));

  return files.map(f => {
    const name = f.replace('.js', '');
    const content = readFileSync(resolve(flowsDir, f), 'utf-8');
    const urlMatch = content.match(/Start URL: (.+)/);
    return {
      name,
      startUrl: urlMatch ? urlMatch[1] : 'unknown',
      path: resolve(flowsDir, f),
    };
  });
}

/**
 * List all saved flows (exported)
 */
export function listFlows() {
  return listFlowsInternal();
}

/**
 * List all saved auth profiles
 */
export function listProfiles() {
  ensureDirs();
  const files = readdirSync(profilesDir).filter(f => f.endsWith('.json'));

  return files.map(f => {
    const name = f.replace('.json', '');
    return {
      name,
      path: resolve(profilesDir, f),
    };
  });
}
