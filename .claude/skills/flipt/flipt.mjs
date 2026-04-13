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
 *   node .claude/skills/flipt/flipt.mjs create <flag-key> --variant --variants "1.5,2" -d "description"
 *   node .claude/skills/flipt/flipt.mjs add-variant <flag-key> <variant-key>
 *   node .claude/skills/flipt/flipt.mjs remove-variant <flag-key> <variant-key>
 *   node .claude/skills/flipt/flipt.mjs set-rollout <flag-key> <variant-key> [--rollout 100]
 *
 * Options:
 *   --description, -d   Description for new flag
 *   --enabled           Create flag as enabled (default: disabled)
 *   --variant           Create as variant flag (default: boolean)
 *   --variants <keys>   Comma-separated variant keys (first is default)
 *   --default <key>     Set default variant key
 *   --rollout <pct>     Rollout percentage for set-rollout (default: 100)
 *   --segment <key>     Segment key for rules (default: all-users)
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
let extraArg = '';
let description = '';
let enabled = false;
let isVariant = false;
let variantKeys = [];
let defaultVariant = '';
let rolloutPct = 100;
let segmentKey = 'all-users';
let jsonOutput = false;
let quiet = false;
let force = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--description' || arg === '-d') {
    description = args[++i] || '';
  } else if (arg === '--enabled') {
    enabled = true;
  } else if (arg === '--variant') {
    isVariant = true;
  } else if (arg === '--variants') {
    isVariant = true;
    variantKeys = (args[++i] || '').split(',').map(v => v.trim()).filter(Boolean);
  } else if (arg === '--default') {
    defaultVariant = args[++i] || '';
  } else if (arg === '--rollout') {
    rolloutPct = parseInt(args[++i] || '100', 10);
  } else if (arg === '--segment') {
    segmentKey = args[++i] || 'all-users';
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
    } else if (!extraArg) {
      extraArg = arg;
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

  if (data.variants?.length > 0) {
    console.log('\nVariants:');
    for (const v of data.variants) {
      const def = v.default ? ' (default)' : '';
      const attach = v.attachment ? ` → ${JSON.stringify(v.attachment)}` : '';
      console.log(`  - ${v.key}${def}${attach}`);
    }
  }

  if (data.rules?.length > 0) {
    console.log('\nRules:');
    for (const rule of data.rules) {
      if (rule.segment) {
        const segs = rule.segment.keys?.join(', ') || 'unknown';
        console.log(`  - Segment: ${segs}`);
        for (const dist of rule.distributions || []) {
          console.log(`    → variant "${dist.variant}" at ${dist.rollout}%`);
        }
      }
    }
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
  const flagType = isVariant ? 'VARIANT_FLAG_TYPE' : 'BOOLEAN_FLAG_TYPE';
  try {
    const data = await apiRequest('POST', '/api/v1/flags', {
      key, name: key, type: flagType, description: desc || '', enabled: isEnabled,
    });

    if (isVariant && variantKeys.length > 0) {
      const defKey = defaultVariant || variantKeys[0];
      for (const vk of variantKeys) {
        await apiRequest('POST', `/api/v1/flags/${key}/variants`, { key: vk, default: vk === defKey });
      }
      if (!quiet) console.log(`  Created ${variantKeys.length} variants (default: ${defKey})`);
    }

    if (jsonOutput) { console.log(JSON.stringify(data, null, 2)); return; }

    console.log(`✓ Created ${isVariant ? 'variant' : 'boolean'} flag: ${key}`);
    console.log(`  Status: ${isEnabled ? 'enabled' : 'disabled'}`);
    console.log('\n⚠️  Note: API changes are temporary. For permanent changes, edit civitai/flipt-state repo.');
  } catch (err) {
    if (err.message.includes('Method Not Allowed')) {
      console.error('Error: API token does not have write permissions.');
      console.error('\nTo create flags permanently, use the GitOps workflow:');
      console.error('1. Clone: gh repo clone civitai/flipt-state /tmp/flipt-state');
      console.error('2. Edit: civitai-app/default/features.yaml');
      console.error('3. Add your flag to the flags section:');
      if (isVariant && variantKeys.length > 0) {
        const defKey = defaultVariant || variantKeys[0];
        const variantYaml = variantKeys.map(vk => {
          const def = vk === defKey ? '\n          default: true' : '';
          return `        - key: "${vk}"${def}`;
        }).join('\n');
        console.error(`
    - key: ${key}
      name: ${key}
      type: VARIANT_FLAG_TYPE
      description: ${desc || 'Your description here'}
      enabled: ${isEnabled}
      variants:
${variantYaml}
`);
      } else {
        console.error(`
    - key: ${key}
      name: ${key}
      type: ${flagType}
      description: ${desc || 'Your description here'}
      enabled: ${isEnabled}
`);
      }
      console.error('4. Commit and push the changes');
      process.exit(1);
    }
    throw err;
  }
}

async function addVariant(flagKey, variantKey) {
  const data = await apiRequest('POST', `/api/v1/flags/${flagKey}/variants`, { key: variantKey, default: false });
  if (jsonOutput) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`✓ Added variant "${variantKey}" to flag: ${flagKey}`);
  console.log('\n⚠️  Note: API changes are temporary. For permanent changes, edit civitai/flipt-state repo.');
}

async function removeVariant(flagKey, variantKey) {
  const allFlags = await apiRequest('GET', '/api/v1/flags');
  const flag = allFlags.flags?.find(f => f.key === flagKey);
  if (!flag) throw new Error(`Flag not found: ${flagKey}`);
  const variant = flag.variants?.find(v => v.key === variantKey);
  if (!variant) throw new Error(`Variant "${variantKey}" not found on flag: ${flagKey}`);
  await apiRequest('DELETE', `/api/v1/flags/${flagKey}/variants/${variant.id}`);
  if (!jsonOutput) {
    console.log(`✓ Removed variant "${variantKey}" from flag: ${flagKey}`);
    console.log('\n⚠️  Note: API changes are temporary. For permanent changes, edit civitai/flipt-state repo.');
  }
}

async function setRollout(flagKey, variantKey) {
  const allFlags = await apiRequest('GET', '/api/v1/flags');
  const flag = allFlags.flags?.find(f => f.key === flagKey);
  if (!flag) throw new Error(`Flag not found: ${flagKey}`);
  if (flag.type !== 'VARIANT_FLAG_TYPE') throw new Error(`Flag "${flagKey}" is not a variant flag`);
  const variant = flag.variants?.find(v => v.key === variantKey);
  if (!variant) throw new Error(`Variant "${variantKey}" not found on flag: ${flagKey}`);
  const rule = await apiRequest('POST', `/api/v1/flags/${flagKey}/rules`, {
    segmentKeys: [segmentKey], segmentOperator: 'OR_SEGMENT_OPERATOR',
  });
  await apiRequest('POST', `/api/v1/flags/${flagKey}/rules/${rule.id}/distributions`, {
    variantId: variant.id, rollout: rolloutPct,
  });
  if (jsonOutput) { console.log(JSON.stringify({ rule, variant: variantKey, rollout: rolloutPct }, null, 2)); return; }
  console.log(`✓ Set rollout for "${variantKey}" on flag "${flagKey}": ${rolloutPct}% (segment: ${segmentKey})`);
  console.log('\n⚠️  Note: API changes are temporary. For permanent changes, edit civitai/flipt-state repo.');
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
  list                            List all flags
  get <key>                       Get details for a specific flag
  create <key>                    Create a new flag (boolean by default)
  enable <key>                    Enable a flag
  disable <key>                   Disable a flag
  delete <key>                    Delete a flag (requires --force)
  add-variant <flag> <variant>    Add a variant to an existing flag
  remove-variant <flag> <variant> Remove a variant from a flag
  set-rollout <flag> <variant>    Set rollout rule for a variant

Options:
  --description, -d <text>   Description for new flag
  --enabled                  Create flag as enabled (default: disabled)
  --variant                  Create as variant flag (default: boolean)
  --variants <keys>          Comma-separated variant keys (first is default)
  --default <key>            Set default variant key
  --rollout <pct>            Rollout percentage (default: 100)
  --segment <key>            Segment key for rules (default: all-users)
  --json                     Output results as JSON
  --quiet, -q                Minimal output
  --force, -f                Skip confirmation prompts

Examples:
  node .claude/skills/flipt/flipt.mjs list
  node .claude/skills/flipt/flipt.mjs get my-feature
  node .claude/skills/flipt/flipt.mjs create my-feature -d "Enable new feature"
  node .claude/skills/flipt/flipt.mjs create my-feature --variant --variants "1.5,2" -d "Multiplier"
  node .claude/skills/flipt/flipt.mjs enable my-feature
  node .claude/skills/flipt/flipt.mjs set-rollout my-feature 2 --rollout 100
  node .claude/skills/flipt/flipt.mjs add-variant my-feature 3

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
      case 'add-variant':
        if (!flagKey || !extraArg) {
          console.error('Error: Flag key and variant key required');
          console.error('Usage: flipt.mjs add-variant <flag-key> <variant-key>');
          process.exit(1);
        }
        await addVariant(flagKey, extraArg);
        break;
      case 'remove-variant':
        if (!flagKey || !extraArg) {
          console.error('Error: Flag key and variant key required');
          console.error('Usage: flipt.mjs remove-variant <flag-key> <variant-key>');
          process.exit(1);
        }
        await removeVariant(flagKey, extraArg);
        break;
      case 'set-rollout':
        if (!flagKey || !extraArg) {
          console.error('Error: Flag key and variant key required');
          console.error('Usage: flipt.mjs set-rollout <flag-key> <variant-key> [--rollout 100] [--segment all-users]');
          process.exit(1);
        }
        await setRollout(flagKey, extraArg);
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
