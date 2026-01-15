#!/usr/bin/env node

/**
 * Moderator Actions - User moderation skill via tRPC API
 *
 * Commands:
 *   user <id|username>              Look up user info
 *   ban <id|username>               Toggle ban status
 *   mute <id|username>              Toggle mute status
 *   leaderboard <id|username> <bool> Set leaderboard eligibility
 *   remove-content <id|username>    Remove all user content
 *
 * Options:
 *   --json                Output raw JSON
 *   --dry-run             Preview without making changes
 *   --reason <code>       Ban reason code
 *   --message <text>      External message for user
 *   --internal <text>     Internal notes
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const projectRoot = resolve(__dirname, '../../..');

// Load .env files (skill-specific first, then project root)
function loadEnv() {
  const envFiles = [
    resolve(skillDir, '.env'),      // Skill-specific (API key, URL)
    resolve(projectRoot, '.env'),   // Project root (fallback)
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

loadEnv();

// Configuration
const API_KEY = process.env.CIVITAI_API_KEY;
const API_URL = (process.env.CIVITAI_API_URL || 'https://civitai.com').replace(/\/$/, '');

// Ban reason codes
const BAN_REASONS = [
  'SexualMinor', 'SexualMinorGenerator', 'SexualMinorTraining',
  'SexualPOI', 'Bestiality', 'Scat', 'Nudify', 'Harassment',
  'LeaderboardCheating', 'BuzzCheating', 'RRDViolation', 'Other'
];

// Parse arguments
const args = process.argv.slice(2);
let command = null;
let targetInput = null;
let arg2 = null;
let jsonOutput = false;
let dryRun = false;
let reasonCode = null;
let messageText = null;
let internalNotes = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--reason') {
    reasonCode = args[++i];
  } else if (arg === '--message') {
    messageText = args[++i];
  } else if (arg === '--internal') {
    internalNotes = args[++i];
  } else if (!command) {
    command = arg;
  } else if (!targetInput) {
    targetInput = arg;
  } else if (!arg2) {
    arg2 = arg;
  }
}

function showUsage() {
  console.error(`Usage: node query.mjs <command> [options]

Commands:
  user <id|username>              Look up user info
  ban <id|username>               Toggle ban status
  mute <id|username>              Toggle mute status
  leaderboard <id|username> <bool> Set leaderboard eligibility
  remove-content <id|username>    Remove all user content

Options:
  --json                Output raw JSON
  --dry-run             Preview without making changes
  --reason <code>       Ban reason code
  --message <text>      External message for user
  --internal <text>     Internal notes

Ban Reason Codes:
  ${BAN_REASONS.join(', ')}

Examples:
  node query.mjs user 3879899
  node query.mjs user unfazedanomaly964
  node query.mjs ban 3879899 --reason Other --message "ToS violation"
  node query.mjs mute 3879899
  node query.mjs leaderboard 3879899 false
  node query.mjs remove-content 3879899 --dry-run

Configuration:
  Set CIVITAI_API_KEY and CIVITAI_API_URL in .claude/skills/mod-actions/.env
  See .env-example for details.`);
  process.exit(1);
}

if (!command) showUsage();

if (!API_KEY) {
  console.error('Error: CIVITAI_API_KEY not set');
  console.error('Create .claude/skills/mod-actions/.env with your API key');
  console.error('See .env-example for details');
  process.exit(1);
}

// Call tRPC endpoint
async function trpcCall(procedure, input, method = 'POST') {
  // tRPC expects input wrapped in { json: ... } format
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
  // tRPC wraps response in { result: { data: { json: ... } } }
  return data.result?.data?.json ?? data.result?.data ?? data;
}

// Look up user by ID or username
async function lookupUser(input) {
  const isId = /^\d+$/.test(input);

  if (isId) {
    // Use getById for numeric IDs
    return await trpcCall('user.getById', { id: parseInt(input) }, 'GET');
  } else {
    // Use getCreator for usernames
    return await trpcCall('user.getCreator', { username: input }, 'GET');
  }
}

// Format user for display
function formatUser(user) {
  if (!user) return 'User not found';

  return `User: ${user.username}
ID: ${user.id}
Status: ${user.deletedAt ? 'Deleted' : 'Active'}
Banned: ${user.bannedAt ? `Yes (${new Date(user.bannedAt).toISOString().split('T')[0]})` : 'No'}
Muted: ${user.muted ? 'Yes' : 'No'}
Leaderboard Eligible: ${user.excludeFromLeaderboards ? 'No' : 'Yes'}
Created: ${user.createdAt ? new Date(user.createdAt).toISOString().split('T')[0] : 'N/A'}`;
}

// Toggle ban status
async function toggleBan(userId, options) {
  const input = { id: userId };
  if (options.reasonCode) input.reasonCode = options.reasonCode;
  if (options.message) input.detailsExternal = options.message;
  if (options.internal) input.detailsInternal = options.internal;

  return await trpcCall('user.toggleBan', input, 'POST');
}

// Toggle mute status
async function toggleMute(userId) {
  return await trpcCall('user.toggleMute', { id: userId }, 'POST');
}

// Set leaderboard eligibility
async function setLeaderboardEligibility(userId, eligible) {
  return await trpcCall('user.setLeaderboardEligibility', { id: userId, setTo: eligible }, 'POST');
}

// Remove all content
async function removeAllContent(userId) {
  return await trpcCall('user.removeAllContent', { id: userId }, 'POST');
}

// Format action result
function formatResult(action, user, result, options = {}) {
  if (options.dryRun) {
    let output = `[DRY RUN] Would ${action}:\n`;
    output += `User: ${user.username} (ID: ${user.id})\n`;

    if (action === 'ban') {
      output += `Action: ${user.bannedAt ? 'UNBAN' : 'BAN'}\n`;
      if (options.reasonCode) output += `Reason: ${options.reasonCode}\n`;
      if (options.message) output += `Message: ${options.message}\n`;
    } else if (action === 'mute') {
      output += `Action: ${user.muted ? 'UNMUTE' : 'MUTE'}\n`;
    } else if (action === 'leaderboard') {
      output += `Action: ${options.eligible ? 'INCLUDE' : 'EXCLUDE'} from leaderboards\n`;
    } else if (action === 'remove-content') {
      output += `Action: Remove all content\n`;
    }

    return output;
  }

  let output = `Action: ${action.toUpperCase()}\n`;
  output += `User: ${user.username} (ID: ${user.id})\n`;
  output += `Success: Yes\n`;

  if (action === 'ban') {
    output += `Previous: ${user.bannedAt ? 'Banned' : 'Not Banned'}\n`;
    output += `Now: ${user.bannedAt ? 'Not Banned' : 'Banned'}\n`;
    if (options.reasonCode) output += `Reason: ${options.reasonCode}\n`;
  } else if (action === 'mute') {
    output += `Previous: ${user.muted ? 'Muted' : 'Not Muted'}\n`;
    output += `Now: ${user.muted ? 'Not Muted' : 'Muted'}\n`;
  } else if (action === 'leaderboard') {
    output += `Previous: ${user.excludeFromLeaderboards ? 'Excluded' : 'Eligible'}\n`;
    output += `Now: ${options.eligible ? 'Eligible' : 'Excluded'}\n`;
  } else if (action === 'remove-content') {
    output += `All content has been removed\n`;
  }

  return output;
}

async function main() {
  console.error(`Using API: ${API_URL}`);

  switch (command) {
    case 'user': {
      if (!targetInput) {
        console.error('Error: User ID or username required');
        showUsage();
      }
      const user = await lookupUser(targetInput);
      if (jsonOutput) {
        console.log(JSON.stringify(user, null, 2));
      } else {
        console.log(formatUser(user));
      }
      break;
    }

    case 'ban': {
      if (!targetInput) {
        console.error('Error: User ID or username required');
        showUsage();
      }
      if (reasonCode && !BAN_REASONS.includes(reasonCode)) {
        console.error(`Error: Invalid reason code. Valid codes: ${BAN_REASONS.join(', ')}`);
        process.exit(1);
      }

      const user = await lookupUser(targetInput);
      if (!user) {
        console.error('Error: User not found');
        process.exit(1);
      }

      if (dryRun) {
        console.log(formatResult('ban', user, null, { dryRun, reasonCode, message: messageText }));
        break;
      }

      const result = await toggleBan(user.id, {
        reasonCode,
        message: messageText,
        internal: internalNotes,
      });

      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatResult('ban', user, result, { reasonCode }));
      }
      break;
    }

    case 'mute': {
      if (!targetInput) {
        console.error('Error: User ID or username required');
        showUsage();
      }

      const user = await lookupUser(targetInput);
      if (!user) {
        console.error('Error: User not found');
        process.exit(1);
      }

      if (dryRun) {
        console.log(formatResult('mute', user, null, { dryRun }));
        break;
      }

      const result = await toggleMute(user.id);

      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatResult('mute', user, result));
      }
      break;
    }

    case 'leaderboard': {
      if (!targetInput || !arg2) {
        console.error('Error: User ID/username and true/false required');
        showUsage();
      }

      const eligible = arg2.toLowerCase() === 'true';
      const user = await lookupUser(targetInput);
      if (!user) {
        console.error('Error: User not found');
        process.exit(1);
      }

      if (dryRun) {
        console.log(formatResult('leaderboard', user, null, { dryRun, eligible }));
        break;
      }

      const result = await setLeaderboardEligibility(user.id, eligible);

      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatResult('leaderboard', user, result, { eligible }));
      }
      break;
    }

    case 'remove-content': {
      if (!targetInput) {
        console.error('Error: User ID or username required');
        showUsage();
      }

      const user = await lookupUser(targetInput);
      if (!user) {
        console.error('Error: User not found');
        process.exit(1);
      }

      if (dryRun) {
        console.log(formatResult('remove-content', user, null, { dryRun }));
        break;
      }

      const result = await removeAllContent(user.id);

      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatResult('remove-content', user, result));
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
