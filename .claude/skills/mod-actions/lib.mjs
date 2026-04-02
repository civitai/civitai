/**
 * Shared library for mod-actions skill scripts.
 *
 * Exports: loadEnv, trpcCall, lookupUser, getModUserId, parseArgs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve paths relative to the caller's location
const __dirname = dirname(fileURLToPath(import.meta.url));
export const skillDir = __dirname;
export const projectRoot = resolve(__dirname, '../../..');

// Load .env files (skill-specific first, then project root)
export function loadEnv() {
  const envFiles = [
    resolve(skillDir, '.env'),
    resolve(projectRoot, '.env'),
  ];

  for (const envPath of envFiles) {
    try {
      const envContent = readFileSync(envPath, 'utf-8');
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
    } catch (e) {
      // Ignore missing files
    }
  }
}

// Initialize env on import
loadEnv();

export const API_KEY = process.env.CIVITAI_API_KEY;
export const API_URL = (process.env.CIVITAI_API_URL || 'https://civitai.com').replace(/\/$/, '');

// Validate API key is set
export function requireApiKey() {
  if (!API_KEY) {
    console.error('Error: CIVITAI_API_KEY not set');
    console.error('Create .claude/skills/mod-actions/.env with your API key');
    console.error('See .env-example for details');
    process.exit(1);
  }
}

/**
 * Call a tRPC endpoint.
 * @param {string} procedure - tRPC procedure path (e.g. 'strike.create')
 * @param {any} input - Input object (will be wrapped in { json: ... })
 * @param {'GET'|'POST'} method - HTTP method
 * @returns {Promise<any>} Unwrapped response data
 */
export async function trpcCall(procedure, input, method = 'POST') {
  const wrappedInput = { json: input };
  const url = method === 'GET'
    ? `${API_URL}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(wrappedInput))}`
    : `${API_URL}/api/trpc/${procedure}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  if (method === 'POST') {
    options.body = JSON.stringify(wrappedInput);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
    try {
      const errorData = JSON.parse(text);
      if (errorData.error?.message) {
        errorMessage = errorData.error.message;
      } else if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      if (text) errorMessage += `: ${text.slice(0, 200)}`;
    }
    throw new Error(errorMessage);
  }

  const data = await response.json();
  return data.result?.data?.json ?? data.result?.data ?? data;
}

/**
 * Look up user by numeric ID or username.
 */
export async function lookupUser(input) {
  const isId = /^\d+$/.test(input);
  if (isId) {
    return await trpcCall('user.getById', { id: parseInt(input) }, 'GET');
  } else {
    return await trpcCall('user.getCreator', { username: input }, 'GET');
  }
}

/**
 * Resolve the mod's user ID from the API key via JWT.
 */
let _modUserId = null;
export async function getModUserId() {
  if (_modUserId) return _modUserId;
  if (process.env.MOD_USER_ID) {
    _modUserId = parseInt(process.env.MOD_USER_ID);
    return _modUserId;
  }
  try {
    const result = await trpcCall('user.getToken', undefined, 'GET');
    const token = result.token;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (payload.userId) {
      _modUserId = payload.userId;
      return _modUserId;
    }
  } catch (e) {
    console.error(`Warning: Could not resolve mod user ID via API: ${e.message}`);
  }
  throw new Error(
    'Could not resolve moderator user ID. Set MOD_USER_ID in .claude/skills/mod-actions/.env'
  );
}

/**
 * Format user for display.
 */
export function formatUser(user) {
  if (!user) return 'User not found';
  return `User: ${user.username}
ID: ${user.id}
Status: ${user.deletedAt ? 'Deleted' : 'Active'}
Banned: ${user.bannedAt ? `Yes (${new Date(user.bannedAt).toISOString().split('T')[0]})` : 'No'}
Muted: ${user.muted ? 'Yes' : 'No'}
Leaderboard Eligible: ${user.excludeFromLeaderboards ? 'No' : 'Yes'}
Created: ${user.createdAt ? new Date(user.createdAt).toISOString().split('T')[0] : 'N/A'}`;
}

/**
 * Parse CLI arguments into a structured object.
 * Returns { command, target, args: [...positional], flags: { key: value } }
 */
export function parseArgs(argv) {
  const raw = argv.slice(2);
  const positional = [];
  const flags = {};

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Boolean flags (no value)
      if (key === 'json' || key === 'dry-run' || key === 'confirm' || key === 'subtasks' ||
          key === 'flagged-for-review' || key === 'has-active-strikes' || key === 'force') {
        flags[key] = true;
      } else {
        flags[key] = raw[++i];
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] || null,
    target: positional[1] || null,
    extra: positional.slice(2),
    flags,
  };
}

/**
 * Output result as JSON or formatted text.
 */
export function output(data, jsonMode, formatter) {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (formatter) {
    console.log(formatter(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * Parse comma-separated IDs into an array of numbers.
 */
export function parseIds(str) {
  if (!str) return [];
  return str.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
}

/**
 * Parse a value as integer, or return undefined.
 */
export function intOrUndef(val) {
  if (val === undefined || val === null) return undefined;
  const n = parseInt(val);
  return isNaN(n) ? undefined : n;
}

/**
 * Standard main wrapper with error handling.
 */
export function run(fn) {
  fn().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
