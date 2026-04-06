#!/usr/bin/env node

/**
 * Generation Moderation - CLI script for generation-related moderation actions.
 *
 * Commands:
 *   flagged-consumers                   List flagged generation consumers
 *   flagged-reasons                     List flagged reasons
 *   consumer-strikes <userId>           Get strikes for a consumer
 *   review-strikes <userId>             Review consumer strikes (WRITE)
 *   user-generations <userId>           Query user generated images
 *   restrictions                        List user restrictions
 *   resolve-restriction <id>            Resolve a user restriction (WRITE)
 *   allowlist-add                       Add to restriction allowlist (WRITE)
 *   debug-audit <prompt>                Debug audit a prompt
 *   todays-counts                       Get today's user restriction counts
 *   suspicious-matches                  Get suspicious restriction matches
 *
 * Options:
 *   --json                Output raw JSON
 *   --dry-run             Preview without making changes (write commands)
 *   --status <val>        Filter by status (Pending|Upheld|Overturned)
 *   --reason <text>       Flagged reason filter
 *   --start-date <date>   Start date filter
 *   --message <text>      Resolved message for resolve-restriction
 *   --trigger <text>      Allowlist trigger
 *   --category <text>     Allowlist category
 *   --negative-prompt <t> Negative prompt for debug-audit
 *   --user-id <id>        Filter by user ID
 *   --username <name>     Filter by username
 *   --restriction-id <id> UserRestriction ID for allowlist
 *   --page <n>            Page number
 *   --limit <n>           Page size
 */

import {
  requireApiKey, trpcCall, parseArgs, output, parseIds, intOrUndef, run, API_URL,
} from './lib.mjs';

requireApiKey();

const { command, target, flags } = parseArgs(process.argv);
const jsonMode = !!flags.json;
const dryRun = !!flags['dry-run'];

function showUsage() {
  console.error(`Usage: node generation.mjs <command> [target] [options]

Commands (READ):
  flagged-consumers                   List flagged generation consumers
  flagged-reasons                     List flagged reasons
  consumer-strikes <userId>           Get strikes for a consumer
  user-generations <userId>           Query user generated images
  restrictions                        List user restrictions
  todays-counts                       Get today's user restriction counts
  suspicious-matches                  Get suspicious restriction matches
  debug-audit <prompt>                Debug audit a prompt

Commands (WRITE - support --dry-run):
  review-strikes <userId>             Review consumer strikes
  resolve-restriction <id>            Resolve a user restriction
  allowlist-add                       Add to restriction allowlist

Options:
  --json                  Output raw JSON
  --dry-run               Preview without making changes
  --status <val>          Filter: Pending | Upheld | Overturned
  --reason <text>         Flagged reason filter
  --start-date <date>     Start date filter (ISO format)
  --message <text>        Resolved message for resolve-restriction
  --trigger <text>        Allowlist trigger (required for allowlist-add)
  --category <text>       Allowlist category (required for allowlist-add)
  --negative-prompt <t>   Negative prompt for debug-audit
  --user-id <id>          Filter by user ID
  --username <name>       Filter by username
  --restriction-id <id>   UserRestriction ID for allowlist-add
  --page <n>              Page number
  --limit <n>             Page size

Examples:
  node generation.mjs flagged-consumers
  node generation.mjs flagged-consumers --start-date 2025-01-01 --reason "csam"
  node generation.mjs flagged-reasons --start-date 2025-01-01
  node generation.mjs consumer-strikes 12345
  node generation.mjs review-strikes 12345 --dry-run
  node generation.mjs user-generations 12345
  node generation.mjs restrictions --status Pending --limit 20
  node generation.mjs restrictions --username someuser
  node generation.mjs resolve-restriction 99 --status Upheld --message "Confirmed violation"
  node generation.mjs resolve-restriction 99 --status Overturned --dry-run
  node generation.mjs allowlist-add --trigger "some trigger" --category "some category" --reason "false positive"
  node generation.mjs allowlist-add --trigger "x" --category "y" --restriction-id 99 --dry-run
  node generation.mjs debug-audit "a cat sitting on a couch"
  node generation.mjs debug-audit "test prompt" --negative-prompt "bad quality"
  node generation.mjs todays-counts
  node generation.mjs suspicious-matches --json

Configuration:
  Set CIVITAI_API_KEY and CIVITAI_API_URL in .claude/skills/mod-actions/.env
  See .env-example for details.`);
  process.exit(1);
}

if (!command) showUsage();

async function main() {
  console.error(`Using API: ${API_URL}`);

  switch (command) {
    case 'flagged-consumers': {
      const input = {};
      if (flags['start-date']) input.startDate = new Date(flags['start-date']);
      if (flags.reason) input.reason = flags.reason;
      const result = await trpcCall('orchestrator.getFlaggedConsumers', input, 'GET');
      output(result, jsonMode);
      break;
    }

    case 'flagged-reasons': {
      const input = {};
      if (flags['start-date']) input.startDate = new Date(flags['start-date']);
      const result = await trpcCall('orchestrator.getFlaggedReasons', input, 'GET');
      output(result, jsonMode);
      break;
    }

    case 'consumer-strikes': {
      if (!target) {
        console.error('Error: userId required');
        console.error('Usage: node generation.mjs consumer-strikes <userId>');
        process.exit(1);
      }
      const consumerId = `civitai-${target}`;
      const result = await trpcCall(
        'orchestrator.getFlaggedConsumerStrikes',
        { consumerId },
        'GET'
      );
      output(result, jsonMode);
      break;
    }

    case 'review-strikes': {
      if (!target) {
        console.error('Error: userId required');
        console.error('Usage: node generation.mjs review-strikes <userId>');
        process.exit(1);
      }
      const userId = parseInt(target);
      if (isNaN(userId)) {
        console.error('Error: userId must be a number');
        process.exit(1);
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would review strikes:`);
        console.log(`User ID: ${userId}`);
        break;
      }

      const result = await trpcCall(
        'orchestrator.reviewConsumerStrikes',
        { userId },
        'POST'
      );
      output(result, jsonMode);
      break;
    }

    case 'user-generations': {
      if (!target) {
        console.error('Error: userId required');
        console.error('Usage: node generation.mjs user-generations <userId>');
        process.exit(1);
      }
      const userId = parseInt(target);
      if (isNaN(userId)) {
        console.error('Error: userId must be a number');
        process.exit(1);
      }
      const input = { userId };
      const result = await trpcCall(
        'orchestrator.queryUserGeneratedImages',
        input,
        'GET'
      );
      output(result, jsonMode);
      break;
    }

    case 'restrictions': {
      const input = {};
      if (flags.limit) input.limit = parseInt(flags.limit);
      if (flags.page) input.page = parseInt(flags.page);
      if (flags.status) input.status = flags.status;
      if (flags.username) input.username = flags.username;
      if (flags['user-id']) input.userId = parseInt(flags['user-id']);
      const result = await trpcCall('userRestriction.getAll', input, 'GET');
      output(result, jsonMode);
      break;
    }

    case 'resolve-restriction': {
      if (!target) {
        console.error('Error: restriction ID required');
        console.error('Usage: node generation.mjs resolve-restriction <id> --status <Upheld|Overturned>');
        process.exit(1);
      }
      const userRestrictionId = parseInt(target);
      if (isNaN(userRestrictionId)) {
        console.error('Error: restriction ID must be a number');
        process.exit(1);
      }
      if (!flags.status || !['Upheld', 'Overturned'].includes(flags.status)) {
        console.error('Error: --status is required and must be "Upheld" or "Overturned"');
        process.exit(1);
      }

      const input = {
        userRestrictionId,
        status: flags.status,
      };
      if (flags.message) input.resolvedMessage = flags.message;

      if (dryRun) {
        console.log(`[DRY RUN] Would resolve restriction:`);
        console.log(`Restriction ID: ${userRestrictionId}`);
        console.log(`Status: ${flags.status}`);
        if (flags.message) console.log(`Message: ${flags.message}`);
        break;
      }

      const result = await trpcCall('userRestriction.resolve', input, 'POST');
      output(result, jsonMode);
      break;
    }

    case 'allowlist-add': {
      if (!flags.trigger) {
        console.error('Error: --trigger is required');
        process.exit(1);
      }
      if (!flags.category) {
        console.error('Error: --category is required');
        process.exit(1);
      }

      const input = {
        trigger: flags.trigger,
        category: flags.category,
      };
      if (flags.reason) input.reason = flags.reason;
      if (flags['restriction-id']) input.userRestrictionId = parseInt(flags['restriction-id']);

      if (dryRun) {
        console.log(`[DRY RUN] Would add to allowlist:`);
        console.log(`Trigger: ${flags.trigger}`);
        console.log(`Category: ${flags.category}`);
        if (flags.reason) console.log(`Reason: ${flags.reason}`);
        if (flags['restriction-id']) console.log(`Restriction ID: ${flags['restriction-id']}`);
        break;
      }

      const result = await trpcCall('userRestriction.addToAllowlist', input, 'POST');
      output(result, jsonMode);
      break;
    }

    case 'debug-audit': {
      if (!target) {
        console.error('Error: prompt text required');
        console.error('Usage: node generation.mjs debug-audit "your prompt text"');
        process.exit(1);
      }

      const input = { prompt: target };
      if (flags['negative-prompt']) input.negativePrompt = flags['negative-prompt'];

      const result = await trpcCall('userRestriction.debugAudit', input, 'POST');
      output(result, jsonMode);
      break;
    }

    case 'todays-counts': {
      const result = await trpcCall('userRestriction.getTodaysUserCounts', {}, 'GET');
      output(result, jsonMode);
      break;
    }

    case 'suspicious-matches': {
      const result = await trpcCall('userRestriction.getSuspiciousMatches', {}, 'GET');
      output(result, jsonMode);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

run(main);
