#!/usr/bin/env node
/**
 * Discord Skill Setup Script
 *
 * Authenticates with a Discord Team Proxy server via OAuth2
 * and saves the resulting token to .env
 *
 * Usage: node setup.mjs <proxy-url>
 * Example: node setup.mjs https://your-discord-proxy.example.com
 */

import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '.env');

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      log(`\nCould not open browser automatically.`, 'yellow');
      log(`Please open this URL manually:`, 'yellow');
      log(`  ${url}`, 'cyan');
    }
  });
}

function updateEnvFile(proxyUrl, token) {
  let envContent = '';

  // Read existing .env if it exists
  if (existsSync(ENV_PATH)) {
    envContent = readFileSync(ENV_PATH, 'utf-8');
  }

  // Update or add DISCORD_PROXY_URL
  if (envContent.includes('DISCORD_PROXY_URL=')) {
    envContent = envContent.replace(/DISCORD_PROXY_URL=.*/, `DISCORD_PROXY_URL=${proxyUrl}`);
  } else {
    envContent += `\n# Discord Team Proxy URL\nDISCORD_PROXY_URL=${proxyUrl}\n`;
  }

  // Update or add DISCORD_PROXY_TOKEN
  if (envContent.includes('DISCORD_PROXY_TOKEN=')) {
    envContent = envContent.replace(/DISCORD_PROXY_TOKEN=.*/, `DISCORD_PROXY_TOKEN=${token}`);
  } else {
    envContent += `\n# Your personal API token\nDISCORD_PROXY_TOKEN=${token}\n`;
  }

  // Remove any bot token lines (we're using proxy now)
  envContent = envContent.replace(/^DISCORD_BOT_TOKEN=.*\n?/gm, '');

  writeFileSync(ENV_PATH, envContent.trim() + '\n');
}

async function main() {
  const proxyUrl = process.argv[2];

  if (!proxyUrl) {
    log('\nDiscord Skill Setup', 'bright');
    log('==================\n', 'dim');
    log('Usage: node setup.mjs <proxy-url>', 'cyan');
    log('');
    log('Example:', 'dim');
    log('  node setup.mjs https://your-discord-proxy.example.com', 'cyan');
    log('');
    log('This will:', 'dim');
    log('  1. Open your browser to authenticate with Discord');
    log('  2. Verify you have access to the team server');
    log('  3. Save your API token to .env');
    process.exit(1);
  }

  // Validate URL
  let url;
  try {
    url = new URL(proxyUrl);
  } catch (e) {
    log(`\nError: Invalid URL: ${proxyUrl}`, 'red');
    process.exit(1);
  }

  const baseUrl = url.origin;

  log('\n🔐 Discord Skill Setup', 'bright');
  log('======================\n', 'dim');
  log(`Proxy URL: ${baseUrl}`, 'cyan');

  // Check if proxy is reachable
  log('\nChecking proxy server...', 'dim');
  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    if (!healthRes.ok) {
      throw new Error(`Health check failed: ${healthRes.status}`);
    }
    log('✓ Proxy server is reachable', 'green');
  } catch (e) {
    log(`✗ Could not reach proxy server: ${e.message}`, 'red');
    log('\nMake sure the Discord Team Proxy is running and accessible.', 'yellow');
    process.exit(1);
  }

  // Generate a state token for this auth session
  const state = randomBytes(16).toString('hex');

  // Create a local server to receive the callback
  const localPort = 19847; // Random high port
  let authToken = null;
  let authError = null;

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${localPort}`);

    if (reqUrl.pathname === '/callback') {
      const token = reqUrl.searchParams.get('token');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        authError = error;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; padding: 40px; text-align: center;">
              <h1 style="color: #dc3545;">Setup Failed</h1>
              <p>${error}</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
      } else if (token) {
        authToken = token;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; padding: 40px; text-align: center;">
              <h1 style="color: #28a745;">✓ Setup Complete!</h1>
              <p>Your Discord skill is now configured.</p>
              <p>You can close this window and return to the terminal.</p>
            </body>
          </html>
        `);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing token');
      }

      // Close server after response
      setTimeout(() => server.close(), 500);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  // Start local server
  await new Promise((resolve, reject) => {
    server.listen(localPort, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  // Build the auth URL with our callback
  // The proxy needs to support a cli_callback parameter
  const authUrl = `${baseUrl}/auth/login?cli_callback=http://localhost:${localPort}/callback`;

  log('\n📱 Opening browser for Discord authentication...', 'yellow');
  log('   (If browser does not open, visit the URL below)\n', 'dim');
  log(`   ${authUrl}`, 'cyan');

  openBrowser(authUrl);

  log('\n⏳ Waiting for authentication...', 'dim');
  log('   (Complete the Discord login in your browser)\n', 'dim');

  // Wait for callback (with timeout)
  const timeout = 300000; // 5 minutes
  const startTime = Date.now();

  await new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (authToken || authError) {
        clearInterval(checkInterval);
        resolve();
      } else if (Date.now() - startTime > timeout) {
        clearInterval(checkInterval);
        authError = 'Authentication timed out';
        server.close();
        resolve();
      }
    }, 100);
  });

  if (authError) {
    log(`\n✗ Setup failed: ${authError}`, 'red');
    process.exit(1);
  }

  if (!authToken) {
    log('\n✗ No token received', 'red');
    process.exit(1);
  }

  // Save to .env
  log('\n💾 Saving configuration...', 'dim');
  updateEnvFile(baseUrl, authToken);

  log('\n✓ Setup complete!', 'green');
  log(`\nConfiguration saved to: ${ENV_PATH}`, 'cyan');
  log('\nYou can now use the Discord skill:', 'dim');
  log('  /discord me', 'cyan');
  log('  /discord channels', 'cyan');
  log('  /discord send <channel> <message>', 'cyan');
}

main().catch((err) => {
  log(`\nError: ${err.message}`, 'red');
  process.exit(1);
});
