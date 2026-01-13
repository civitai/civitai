/**
 * ClickUp API client - core HTTP layer and environment handling
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = resolve(__dirname, '..', '.env');
export const API_BASE = 'https://api.clickup.com/api/v2';

// Load .env from skill directory
export function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    return false;
  }

  try {
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Append a value to .env file
export function appendToEnv(key, value, comment = null) {
  try {
    let content = '\n';
    if (comment) {
      content += `# ${comment}\n`;
    }
    content += `${key}=${value}\n`;
    appendFileSync(ENV_PATH, content);
    process.env[key] = value;
    return true;
  } catch (e) {
    return false;
  }
}

// Make API request
export async function apiRequest(endpoint, options = {}) {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    console.error('Error: CLICKUP_API_TOKEN not configured');
    console.error('');
    console.error('Setup:');
    console.error('  1. Copy .env-example to .env in the skill directory');
    console.error('  2. Add your ClickUp Personal API Token');
    console.error('  3. Generate at: ClickUp Settings > Apps > API Token');
    process.exit(1);
  }

  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ClickUp API error: ${response.status} - ${text}`);
  }

  return response.json();
}
