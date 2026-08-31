/**
 * ClickUp API client - core HTTP layer and credential management
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAccountCredentials } from '../lib/accounts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = resolve(__dirname, '..', '.env');
export const API_BASE = 'https://api.clickup.com/api/v2';
export const API_BASE_V3 = 'https://api.clickup.com/api/v3';

const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

// Active account credentials (set by initClient)
let _activeCredentials = null;
let _activeAccountId = null;

/**
 * Initialize the client with a specific account (or the default).
 * Replaces the old loadEnv() approach.
 */
export function initClient(accountId) {
  const creds = getAccountCredentials(accountId);
  _activeCredentials = creds;
  _activeAccountId = creds._accountId;
  // Populate process.env for backward compat with modules that still read it
  if (creds.apiToken) process.env.CLICKUP_API_TOKEN = creds.apiToken;
  if (creds.teamId) process.env.CLICKUP_TEAM_ID = creds.teamId;
  if (creds.userId) process.env.CLICKUP_USER_ID = creds.userId;
  if (creds.defaultListId) process.env.CLICKUP_DEFAULT_LIST_ID = creds.defaultListId;
  if (creds.jwt) process.env.CLICKUP_JWT = creds.jwt;
  if (creds.internalApiUrl) process.env.CLICKUP_INTERNAL_API = creds.internalApiUrl;
  if (creds.email) process.env.CLICKUP_EMAIL = creds.email;
  if (creds.password) process.env.CLICKUP_PASSWORD = creds.password;
  return true;
}

/**
 * Get the active account's credentials object
 */
export function getActiveCredentials() {
  if (!_activeCredentials) {
    throw new Error('Client not initialized. Call initClient() first.');
  }
  return _activeCredentials;
}

/**
 * Get the active account ID
 */
export function getActiveAccountId() {
  return _activeAccountId;
}

/**
 * @deprecated Use initClient(accountId) instead.
 * Kept for transitional compatibility.
 */
export function loadEnv() {
  if (_activeCredentials) return true;
  // Legacy fallback: load from .env directly
  if (!existsSync(ENV_PATH)) return false;
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

/**
 * @deprecated Use updateAccountField from lib/accounts.mjs instead.
 */
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

// Get API token or exit with setup instructions
function getToken() {
  if (_activeCredentials?.apiToken) {
    return _activeCredentials.apiToken;
  }
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    console.error('Error: No API token configured');
    console.error('');
    console.error('Setup:');
    console.error('  1. Create accounts.json (see SKILL.md) or .env in the skill directory');
    console.error('  2. Add your ClickUp Personal API Token (starts with pk_)');
    console.error('  3. Generate at: ClickUp Settings > Apps > API Token');
    process.exit(1);
  }
  return token;
}

// Core fetch with timeout, rate limit handling, and structured error parsing
async function fetchWithRetry(url, options, retries = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    // Handle rate limiting (429)
    if (response.status === 429 && retries < MAX_RETRIES) {
      const resetHeader = response.headers.get('X-RateLimit-Reset');
      let waitMs = 60000; // Default: wait 60s
      if (resetHeader) {
        waitMs = Math.max((parseInt(resetHeader) * 1000) - Date.now(), 1000);
      }
      console.error(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s before retry...`);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchWithRetry(url, options, retries + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch {}
      const err = new Error(
        parsed?.err || `ClickUp API error: ${response.status} - ${text}`
      );
      err.status = response.status;
      err.ecode = parsed?.ECODE || null;
      throw err;
    }

    // Handle empty responses (e.g., DELETE returns empty body)
    const text = await response.text();
    if (!text) {
      return {};
    }
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`ClickUp API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Internal: make API request to any base URL
function makeRequest(baseUrl) {
  return async function(endpoint, options = {}) {
    const token = getToken();
    const url = `${baseUrl}${endpoint}`;
    return fetchWithRetry(url, {
      ...options,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  };
}

// Make API v2 request
export const apiRequest = makeRequest(API_BASE);

// Make API v3 request (used for Docs API)
export const apiRequestV3 = makeRequest(API_BASE_V3);

// Auto-paginate v2 task endpoints (page-based pagination)
// Returns all items across all pages
export async function fetchAllPages(endpoint, key = 'tasks') {
  let page = 0;
  let allItems = [];
  while (true) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const response = await apiRequest(`${endpoint}${sep}page=${page}`);
    const items = response[key] || [];
    allItems = allItems.concat(items);
    if (response.last_page || items.length < 100) break;
    page++;
  }
  return allItems;
}
