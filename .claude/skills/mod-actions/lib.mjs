/**
 * Shared library for skill scripts that call the Civitai API.
 *
 * Exports: loadEnv, trpcCall, lookupUser, getModUserId, parseArgs, createCli, isMain, whoami
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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
  // An input-less query must omit the param: `input={}` (what `{ json: undefined }` serialises to)
  // is rejected with a 400.
  const query =
    method === 'GET' && input !== undefined
      ? `?input=${encodeURIComponent(JSON.stringify(wrappedInput))}`
      : '';
  const url = `${API_URL}/api/trpc/${procedure}${query}`;

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
          key === 'flagged-for-review' || key === 'has-active-strikes' || key === 'force' ||
          key === 'lock') {
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

/**
 * Flag parsing, validation and dispatch for a skill CLI. Unlike parseArgs, the caller names its
 * own boolean flags; every other `--flag` takes the next argument as its value.
 */
export function createCli(booleanFlags = []) {
  const booleans = new Set(booleanFlags);
  const positional = [];
  const flags = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    flags[key] = booleans.has(key) ? true : argv[++i];
  }

  const fail = (message) => {
    console.error(`Error: ${message}`);
    process.exit(1);
  };
  const required = (name) => {
    const value = flags[name];
    if (value === undefined || value === true || value === '') fail(`--${name} is required`);
    return value;
  };
  const requiredInt = (name) => {
    const value = Number(required(name));
    if (!Number.isInteger(value) || value <= 0) fail(`--${name} must be a positive integer`);
    return value;
  };
  const oneOf = (name, value, allowed) => {
    if (!allowed.includes(value)) fail(`--${name} must be one of: ${allowed.join(', ')}`);
    return value;
  };
  const dryRun = (label, payload) => {
    console.log(`[dry run] ${label} → ${API_URL}`);
    console.log(JSON.stringify(payload, null, 2));
    console.log('Re-run with --writable to apply.');
  };
  const dispatch = (commands, help) => {
    const command = commands[positional.slice(0, 2).join(' ')] ?? commands[positional[0]];
    if (!command) {
      console.log(help);
      process.exit(positional.length ? 1 : 0);
    }
    requireApiKey();
    command().catch((err) => fail(err.message));
  };

  return { positional, flags, writable: !!flags.writable, fail, required, requiredInt, oneOf, dryRun, dispatch };
}

/** Whether the module at `moduleUrl` is the script node was started with, rather than an import. */
export function isMain(moduleUrl) {
  return !!process.argv[1] && moduleUrl === pathToFileURL(process.argv[1]).href;
}

/** Print the API target, the key's user, and whether that user is a moderator. */
export async function whoami() {
  const { token } = await trpcCall('user.getToken', undefined, 'GET');
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const moderator = await trpcCall('generation.getGateRules', undefined, 'GET').then(
    () => true,
    () => false
  );
  console.log(`Target:    ${API_URL}`);
  console.log(`User id:   ${payload.userId ?? payload.id ?? 'unknown'}`);
  console.log(`Moderator: ${moderator ? 'yes' : 'NO — moderator-only commands will fail'}`);
}
