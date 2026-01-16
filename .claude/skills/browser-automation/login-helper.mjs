#!/usr/bin/env node
/**
 * Login Helper
 *
 * Opens a browser for manual login, then saves the auth state.
 * Usage: node login-helper.mjs <url> <profile-name>
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../../..');
const profilesDir = resolve(projectRoot, '.browser/profiles');

// Ensure profiles directory exists
if (!existsSync(profilesDir)) {
  mkdirSync(profilesDir, { recursive: true });
}

const url = process.argv[2] || 'http://localhost:3000';
const profileName = process.argv[3] || 'default';
const profilePath = resolve(profilesDir, `${profileName}.json`);

console.log(`\n=== Login Helper ===`);
console.log(`URL: ${url}`);
console.log(`Profile: ${profileName}`);
console.log(`Profile path: ${profilePath}`);
console.log(`\nOpening browser...`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await context.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

console.log(`\n>>> Browser is open. Please login manually.`);
console.log(`>>> When done, press ENTER here to save auth and close.`);
console.log(`>>> Or press Ctrl+C to cancel without saving.\n`);

// Wait for Enter key
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

await new Promise(resolve => {
  rl.question('', () => {
    rl.close();
    resolve();
  });
});

// Save auth state
console.log(`\nSaving auth to profile: ${profileName}...`);
await context.storageState({ path: profilePath });
console.log(`Auth saved to: ${profilePath}`);

await browser.close();
console.log(`Browser closed. You can now use --profile ${profileName} in future sessions.`);
