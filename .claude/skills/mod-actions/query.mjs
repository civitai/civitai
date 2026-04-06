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
 *   dm <id|username>                Send a DM to a user
 *
 * Options:
 *   --json                Output raw JSON
 *   --dry-run             Preview without making changes
 *   --reason <code>       Ban reason code
 *   --message <text>      External message for user / DM content
 *   --internal <text>     Internal notes
 */

import {
  requireApiKey, trpcCall, lookupUser, getModUserId, formatUser, API_URL, API_KEY, run,
} from './lib.mjs';

requireApiKey();

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
  dm <id|username>                Send a DM to a user

Options:
  --json                Output raw JSON
  --dry-run             Preview without making changes
  --reason <code>       Ban reason code
  --message <text>      External message for user / DM content
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
  node query.mjs dm 3879899 --message "Hello, this is a message from the mod team"

Configuration:
  Set CIVITAI_API_KEY and CIVITAI_API_URL in .claude/skills/mod-actions/.env
  See .env-example for details.`);
  process.exit(1);
}

if (!command) showUsage();

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

// Create or find a 1-on-1 chat between the mod and a target user
async function createOrFindChat(modUserId, targetUserId) {
  return await trpcCall('chat.createChat', { userIds: [modUserId, targetUserId] }, 'POST');
}

// Send a message in a chat
async function sendChatMessage(chatId, content) {
  return await trpcCall('chat.createMessage', {
    chatId,
    content,
    contentType: 'Markdown',
  }, 'POST');
}

// Send a DM to a user (create chat + send message)
async function sendDm(targetUserId, message) {
  const modUserId = await getModUserId();
  const chat = await createOrFindChat(modUserId, targetUserId);
  const chatId = chat.id;
  const result = await sendChatMessage(chatId, message);
  return { chatId, messageId: result.id, modUserId };
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

    case 'dm': {
      if (!targetInput) {
        console.error('Error: User ID or username required');
        showUsage();
      }
      if (!messageText) {
        console.error('Error: --message is required for dm command');
        console.error('Usage: node query.mjs dm <id|username> --message "Your message here"');
        process.exit(1);
      }

      const user = await lookupUser(targetInput);
      if (!user) {
        console.error('Error: User not found');
        process.exit(1);
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would send DM:`);
        console.log(`To: ${user.username} (ID: ${user.id})`);
        console.log(`Message: ${messageText}`);
        break;
      }

      const dmResult = await sendDm(user.id, messageText);

      if (jsonOutput) {
        console.log(JSON.stringify({ ...dmResult, user: { id: user.id, username: user.username } }, null, 2));
      } else {
        console.log(`Action: DM SENT`);
        console.log(`To: ${user.username} (ID: ${user.id})`);
        console.log(`Chat ID: ${dmResult.chatId}`);
        console.log(`Message ID: ${dmResult.messageId}`);
        console.log(`Success: Yes`);
      }
      break;
    }

    case 'reprocess-order': {
      if (!targetInput) {
        console.error('Error: NowPayments payment ID required');
        console.error('Usage: node query.mjs reprocess-order <paymentId> [--reason nowpayments|coinbase]');
        process.exit(1);
      }

      const provider = reasonCode || 'nowpayments';

      if (dryRun) {
        console.log(`[DRY RUN] Would reprocess order:`);
        console.log(`Provider: ${provider}`);
        console.log(`Payment ID: ${targetInput}`);
        break;
      }

      console.error(`Reprocessing ${provider} order ${targetInput}...`);
      const reprocessUrl = `${API_URL}/api/mod/reprocess-order?provider=${encodeURIComponent(provider)}&orderId=${encodeURIComponent(targetInput)}`;
      const reprocessResponse = await fetch(reprocessUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      if (!reprocessResponse.ok) {
        const errorText = await reprocessResponse.text();
        let errorMsg = `Reprocess failed: ${reprocessResponse.status}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMsg = errorData.error || errorMsg;
        } catch {
          errorMsg += `: ${errorText.slice(0, 200)}`;
        }
        console.error(errorMsg);
        process.exit(1);
      }

      const reprocessResult = await reprocessResponse.json();
      if (jsonOutput) {
        console.log(JSON.stringify(reprocessResult, null, 2));
      } else {
        console.log(`Action: REPROCESS ORDER`);
        console.log(`Provider: ${provider}`);
        console.log(`Payment ID: ${targetInput}`);
        console.log(`User ID: ${reprocessResult.userId || 'N/A'}`);
        console.log(`Buzz Credited: ${reprocessResult.buzzAmount || 0}`);
        console.log(`Transaction ID: ${reprocessResult.transactionId || 'N/A'}`);
        console.log(`Success: Yes`);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

run(main);
