#!/usr/bin/env node

/**
 * Flipt Feature Flag Manager
 *
 * Usage:
 *   node .claude/skills/flipt/flipt.mjs list
 *   node .claude/skills/flipt/flipt.mjs get <flag-key>
 *   node .claude/skills/flipt/flipt.mjs create <flag-key> -d "description"
 *   node .claude/skills/flipt/flipt.mjs enable <flag-key>
 *   node .claude/skills/flipt/flipt.mjs disable <flag-key>
 *
 * Options:
 *   --description, -d   Description for new flag
 *   --enabled           Create flag as enabled (default: disabled)
 *   --json              Output results as JSON
 *   --quiet, -q         Minimal output
 *   --force, -f         Skip confirmation prompts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env files
const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const projectRoot = resolve(__dirname, '../../..');

function loadEnv() {
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
      // File not found, continue
    }
  }
}

loadEnv();

const FLIPT_URL = process.env.FLIPT_URL;
const FLIPT_API_TOKEN = process.env.FLIPT_API_TOKEN;

if (!FLIPT_URL || !FLIPT_API_TOKEN) {
  console.error('Error: FLIPT_URL and FLIPT_API_TOKEN must be set');
  console.error('Copy .env.example to .env and configure your credentials');
  process.exit(1);
}

// Parse arguments
const args = process.argv.slice(2);
let command = '';
let flagKey = '';
let description = '';
let enabled = false;
let jsonOutput = false;
let quiet = false;
let force = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--description' || arg === '-d') {
    description = args[++i] || '';
  } else if (arg === '--enabled') {
    enabled = true;
  } else if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--quiet' || arg === '-q') {
    quiet = true;
  } else if (arg === '--force' || arg === '-f') {
    force = true;
  } else if (!arg.startsWith('-')) {
    if (!command) {
      command = arg;
    } else if (!flagKey) {
      flagKey = arg;
    }
  }
}

async function apiRequest(method, path, body = null) {
  const url = `${FLIPT_URL}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${FLIPT_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `API error: ${response.status}`);
  }

  return data;
}

async function listFlags() {
  const data = await apiRequest('GET', '/api/v1/flags');

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (!quiet) {
    console.log(`Found ${data.flags?.length || 0} flags:\n`);
    console.log('─'.repeat(80));
  }

  for (const flag of data.flags || []) {
    const status = flag.enabled ? '✓ ENABLED' : '✗ DISABLED';
    const statusColor = flag.enabled ? '\x1b[32m' : '\x1b[31m';
    console.log(`${statusColor}${status}\x1b[0m  ${flag.key}`);
    if (flag.description && !quiet) {
      console.log(`         ${flag.description}`);
    }
    if (!quiet) console.log('');
  }
}

async function getFlag(key) {
  // Flipt API doesn't support individual flag lookup well, so filter from list
  const allFlags = await apiRequest('GET', '/api/v1/flags');
  const data = allFlags.flags?.find(f => f.key === key);

  if (!data) {
    throw new Error(`Flag not found: ${key}`);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const status = data.enabled ? '✓ ENABLED' : '✗ DISABLED';
  const statusColor = data.enabled ? '\x1b[32m' : '\x1b[31m';

  console.log(`Flag: ${data.key}`);
  console.log(`Status: ${statusColor}${status}\x1b[0m`);
  console.log(`Type: ${data.type}`);
  if (data.description) {
    console.log(`Description: ${data.description}`);
  }

  if (data.rollouts?.length > 0) {
    console.log('\nRollout Rules:');
    for (const rollout of data.rollouts) {
      if (rollout.threshold) {
        console.log(`  - ${rollout.threshold.percentage}% → ${rollout.threshold.value}`);
      }
      if (rollout.segment) {
        console.log(`  - Segment: ${rollout.segment.keys?.join(', ')} → ${rollout.segment.value}`);
      }
    }
  }
}

async function createFlag(key, desc, isEnabled) {
  // Note: This may fail if the token is read-only
  try {
    const data = await apiRequest('POST', '/api/v1/flags', {
      key,
      name: key,
      type: 'BOOLEAN_FLAG_TYPE',
      description: desc || '',
      enabled: isEnabled,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`✓ Created flag: ${key}`);
    console.log(`  Status: ${isEnabled ? 'enabled' : 'disabled'}`);
    console.log('\n⚠️  Note: API changes are temporary. For permanent changes, edit civitai/flipt-state repo.');
  } catch (err) {
    if (err.message.includes('Method Not Allowed')) {
      console.error('Error: API token does not have write permissions.');
      console.error('\nTo create flags permanently, use the GitOps workflow:');
      console.error('1. Clone: gh repo clone civitai/flipt-state /tmp/flipt-state');
      console.error('2. Edit: civitai-app/default/features.yaml');
      console.error('3. Add your flag to the flags section:');
      console.error(`
    - key: ${key}
      name: ${key}
      type: BOOLEAN_FLAG_TYPE
      description: ${desc || 'Your description here'}
      enabled: ${isEnabled}
`);
      console.error('4. Commit and push the changes');
      process.exit(1);
    }
    throw err;
  }
}

async function updateFlag(key, isEnabled) {
  // First verify the flag exists
  const allFlags = await apiRequest('GET', '/api/v1/flags');
  const current = allFlags.flags?.find(f => f.key === key);

  if (!current) {
    throw new Error(`Flag not found: ${key}`);
  }

  try {
    // Try to update via API
    const data = await apiRequest('PUT', `/api/v1/flags/${key}`, {
      ...current,
      enabled: isEnabled,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const action = isEnabled ? 'Enabled' : 'Disabled';
    console.log(`✓ ${action} flag: ${key}`);
    console.log('\n⚠️  Note: API changes are temporary. For permanent changes, edit civitai/flipt-state repo.');
  } catch (err) {
    if (err.message.includes('Method Not Allowed') || err.message.includes('Not Found')) {
      console.error('Error: API token does not have write permissions.');
      console.error('\nTo update flags permanently, use the GitOps workflow:');
      console.error('1. Clone: gh repo clone civitai/flipt-state /tmp/flipt-state');
      console.error('2. Edit: civitai-app/default/features.yaml');
      console.error(`3. Find the flag "${key}" and set enabled: ${isEnabled}`);
      console.error('4. Commit and push the changes');
      process.exit(1);
    }
    throw err;
  }
}

async function deleteFlag(key) {
  if (!force) {
    console.error(`Warning: This will delete flag "${key}"`);
    console.error('Use --force to skip this confirmation');
    process.exit(1);
  }

  try {
    await apiRequest('DELETE', `/api/v1/flags/${key}`);
    console.log(`✓ Deleted flag: ${key}`);
    console.log('\n⚠️  Note: API changes are temporary. For permanent changes, edit civitai/flipt-state repo.');
  } catch (err) {
    if (err.message.includes('Method Not Allowed')) {
      console.error('Error: API token does not have write permissions.');
      console.error('\nTo delete flags permanently, use the GitOps workflow:');
      console.error('1. Clone: gh repo clone civitai/flipt-state /tmp/flipt-state');
      console.error('2. Edit: civitai-app/default/features.yaml');
      console.error(`3. Remove the flag "${key}" from the flags section`);
      console.error('4. Commit and push the changes');
      process.exit(1);
    }
    throw err;
  }
}

function showHelp() {
  console.log(`Flipt Feature Flag Manager

Usage:
  node .claude/skills/flipt/flipt.mjs <command> [options]

Commands:
  list              List all flags
  get <key>         Get details for a specific flag
  create <key>      Create a new boolean flag
  enable <key>      Enable a flag
  disable <key>     Disable a flag
  delete <key>      Delete a flag (requires --force)

Options:
  --description, -d <text>   Description for new flag
  --enabled                  Create flag as enabled (default: disabled)
  --json                     Output results as JSON
  --quiet, -q                Minimal output
  --force, -f                Skip confirmation prompts

Examples:
  node .claude/skills/flipt/flipt.mjs list
  node .claude/skills/flipt/flipt.mjs get my-feature
  node .claude/skills/flipt/flipt.mjs create my-feature -d "Enable new feature"
  node .claude/skills/flipt/flipt.mjs enable my-feature
  node .claude/skills/flipt/flipt.mjs disable my-feature

Note: Write operations require an admin token. If you have a read-only token,
use the GitOps workflow by editing the civitai/flipt-state repository.`);
}

async function main() {
  try {
    switch (command) {
      case 'list':
        await listFlags();
        break;
      case 'get':
        if (!flagKey) {
          console.error('Error: Flag key required');
          console.error('Usage: flipt.mjs get <flag-key>');
          process.exit(1);
        }
        await getFlag(flagKey);
        break;
      case 'create':
        if (!flagKey) {
          console.error('Error: Flag key required');
          console.error('Usage: flipt.mjs create <flag-key> -d "description"');
          process.exit(1);
        }
        await createFlag(flagKey, description, enabled);
        break;
      case 'enable':
        if (!flagKey) {
          console.error('Error: Flag key required');
          console.error('Usage: flipt.mjs enable <flag-key>');
          process.exit(1);
        }
        await updateFlag(flagKey, true);
        break;
      case 'disable':
        if (!flagKey) {
          console.error('Error: Flag key required');
          console.error('Usage: flipt.mjs disable <flag-key>');
          process.exit(1);
        }
        await updateFlag(flagKey, false);
        break;
      case 'delete':
        if (!flagKey) {
          console.error('Error: Flag key required');
          console.error('Usage: flipt.mjs delete <flag-key> --force');
          process.exit(1);
        }
        await deleteFlag(flagKey);
        break;
      case 'help':
      case '--help':
      case '-h':
        showHelp();
        break;
      default:
        if (!command) {
          showHelp();
        } else {
          console.error(`Unknown command: ${command}`);
          console.error('Run with --help for usage information');
          process.exit(1);
        }
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
