/**
 * ClickUp Multi-Account Credential Manager
 *
 * Manages named accounts in accounts.json. Auto-migrates from .env on first run.
 *
 * Schema:
 * {
 *   "defaultAccount": "bot",
 *   "accounts": {
 *     "bot": { "apiToken": "pk_...", "teamId": "...", ... },
 *     "justin": { "apiToken": "pk_...", ... }
 *   }
 * }
 *
 * Only apiToken is required. Other fields are auto-detected and cached.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, '..');
const ACCOUNTS_PATH = resolve(SKILL_DIR, 'accounts.json');
const ENV_PATH = resolve(SKILL_DIR, '.env');

// ENV key -> accounts.json field mapping
const ENV_KEY_MAP = {
  CLICKUP_API_TOKEN: 'apiToken',
  CLICKUP_TEAM_ID: 'teamId',
  CLICKUP_USER_ID: 'userId',
  CLICKUP_DEFAULT_LIST_ID: 'defaultListId',
  CLICKUP_EMAIL: 'email',
  CLICKUP_PASSWORD: 'password',
  CLICKUP_JWT: 'jwt',
  CLICKUP_INTERNAL_API: 'internalApiUrl',
};

/**
 * Parse a .env file into key-value pairs (skips comments and blank lines)
 */
function parseEnvFile(filePath) {
  const pairs = {};
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    pairs[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return pairs;
}

/**
 * Migrate credentials from .env to accounts.json format
 */
export function migrateFromEnv() {
  if (!existsSync(ENV_PATH)) return null;
  const envVars = parseEnvFile(ENV_PATH);
  const creds = {};
  for (const [envKey, jsonKey] of Object.entries(ENV_KEY_MAP)) {
    if (envVars[envKey]) {
      creds[jsonKey] = envVars[envKey];
    }
  }
  if (!creds.apiToken) return null;

  const config = {
    defaultAccount: 'default',
    accounts: { default: creds },
  };
  saveAccountConfig(config);
  console.error('Migrated credentials from .env to accounts.json');
  console.error('You can safely remove .env when ready (accounts.json is now the source of truth).');
  return config;
}

/**
 * Load accounts.json. Auto-migrates from .env if missing.
 */
export function loadAccountConfig() {
  if (existsSync(ACCOUNTS_PATH)) {
    try {
      return JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf-8'));
    } catch (e) {
      throw new Error(`Failed to parse accounts.json: ${e.message}`);
    }
  }
  // Auto-migrate from .env
  const migrated = migrateFromEnv();
  if (migrated) return migrated;
  return null;
}

/**
 * Write accounts.json with restricted permissions
 */
export function saveAccountConfig(config) {
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(config, null, 2) + '\n');
  try { chmodSync(ACCOUNTS_PATH, 0o600); } catch { /* Windows may not support */ }
}

/**
 * Get credentials for a specific account (or the default)
 */
export function getAccountCredentials(accountId) {
  const config = loadAccountConfig();
  if (!config) {
    throw new Error(
      'No accounts configured.\n' +
      'Setup: Create accounts.json or .env in the skill directory.\n' +
      'See SKILL.md for details.'
    );
  }
  const id = accountId || config.defaultAccount;
  const creds = config.accounts?.[id];
  if (!creds) {
    const available = Object.keys(config.accounts || {}).join(', ');
    throw new Error(
      `Account "${id}" not found in accounts.json.\n` +
      `Available accounts: ${available || '(none)'}`
    );
  }
  return { ...creds, _accountId: id };
}

/**
 * Update a single field on an account and persist
 */
export function updateAccountField(accountId, key, value) {
  const config = loadAccountConfig();
  if (!config) return false;
  const id = accountId || config.defaultAccount;
  if (!config.accounts?.[id]) return false;
  config.accounts[id][key] = value;
  saveAccountConfig(config);
  return true;
}

/**
 * Get the default account ID
 */
export function getDefaultAccount() {
  const config = loadAccountConfig();
  return config?.defaultAccount || null;
}

/**
 * Set the default account
 */
export function setDefaultAccount(accountId) {
  const config = loadAccountConfig();
  if (!config) throw new Error('No accounts.json found');
  if (!config.accounts?.[accountId]) {
    throw new Error(`Account "${accountId}" not found`);
  }
  config.defaultAccount = accountId;
  saveAccountConfig(config);
}

/**
 * List all accounts (summary, no secrets)
 */
export function listAccounts() {
  const config = loadAccountConfig();
  if (!config) return [];
  return Object.entries(config.accounts || {}).map(([id, creds]) => ({
    id,
    isDefault: id === config.defaultAccount,
    hasApiToken: !!creds.apiToken,
    hasJwt: !!creds.jwt,
    teamId: creds.teamId || null,
    userId: creds.userId || null,
    email: creds.email || null,
  }));
}

/**
 * Add a new account
 */
export function addAccount(accountId, creds) {
  let config = loadAccountConfig();
  if (!config) {
    config = { defaultAccount: accountId, accounts: {} };
  }
  if (config.accounts[accountId]) {
    throw new Error(`Account "${accountId}" already exists. Remove it first.`);
  }
  config.accounts[accountId] = creds;
  saveAccountConfig(config);
}

/**
 * Remove an account
 */
export function removeAccount(accountId) {
  const config = loadAccountConfig();
  if (!config?.accounts?.[accountId]) {
    throw new Error(`Account "${accountId}" not found`);
  }
  delete config.accounts[accountId];
  if (config.defaultAccount === accountId) {
    const remaining = Object.keys(config.accounts);
    config.defaultAccount = remaining[0] || null;
  }
  saveAccountConfig(config);
}
