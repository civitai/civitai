#!/usr/bin/env node

/**
 * Content & Training Moderation - CLI script for managing models, articles, and training data.
 *
 * Commands:
 *   models                           List models for moderation
 *   flagged-models                   List flagged models
 *   resolve-flagged                  Resolve flagged models by IDs
 *   model-versions                   List model versions
 *   rescan-model <id>                Rescan a model
 *   restore-model <id>               Restore a removed model
 *   toggle-cannot-promote <id>       Toggle cannot-promote flag
 *   toggle-cannot-publish <id>       Toggle cannot-publish flag
 *   articles                         List articles for moderation
 *   training-models                  List training models
 *   approve-training <id>            Approve training data
 *   deny-training <id>               Deny training data
 *   mod-rule <id>                    Get a moderation rule by ID
 *
 * Options:
 *   --json                Output raw JSON
 *   --dry-run             Preview without making changes
 *   --ids <id1,id2,...>   Comma-separated IDs
 *   --page <n>            Page number
 *   --limit <n>           Page size
 */

import {
  requireApiKey, trpcCall, parseArgs, output, parseIds, intOrUndef, run, API_URL,
} from './lib.mjs';

requireApiKey();

const { command, target, flags } = parseArgs(process.argv);
const jsonMode = !!flags['json'];
const dryRun = !!flags['dry-run'];

function showUsage() {
  console.error(`Usage: node content.mjs <command> [options]

Commands (READ):
  models                           List models for moderation
  flagged-models                   List flagged models
  model-versions                   List model versions
  articles                         List articles for moderation
  training-models                  List training models
  mod-rule <id>                    Get a moderation rule by ID

Commands (WRITE):
  resolve-flagged --ids <ids>      Resolve flagged models
  rescan-model <id>                Rescan a model
  restore-model <id>               Restore a removed model
  toggle-cannot-promote <id>       Toggle cannot-promote flag on a model
  toggle-cannot-publish <id>       Toggle cannot-publish flag on a model
  approve-training <id>            Approve training data
  deny-training <id>               Deny training data

Options:
  --json                Output raw JSON
  --dry-run             Preview without making changes (write commands)
  --ids <id1,id2,...>   Comma-separated IDs (for resolve-flagged)
  --page <n>            Page number (default: 1)
  --limit <n>           Page size (default: 20)

Examples:
  node content.mjs models
  node content.mjs models --limit 50 --page 2
  node content.mjs flagged-models --json
  node content.mjs resolve-flagged --ids 101,102,103
  node content.mjs resolve-flagged --ids 101,102 --dry-run
  node content.mjs rescan-model 456
  node content.mjs restore-model 789 --dry-run
  node content.mjs toggle-cannot-promote 456
  node content.mjs toggle-cannot-publish 456
  node content.mjs articles --limit 10
  node content.mjs training-models
  node content.mjs approve-training 321
  node content.mjs deny-training 321 --dry-run
  node content.mjs mod-rule 5 --json

Configuration:
  Set CIVITAI_API_KEY and CIVITAI_API_URL in .claude/skills/mod-actions/.env
  See .env-example for details.`);
  process.exit(1);
}

if (!command) showUsage();

// Build pagination input from flags
function pagination() {
  return {
    limit: intOrUndef(flags['limit']) ?? 20,
    page: intOrUndef(flags['page']) ?? 1,
  };
}

// Require a numeric ID from target (positional arg after command)
function requireId(label = 'ID') {
  const id = parseInt(target);
  if (!id || isNaN(id)) {
    console.error(`Error: ${label} is required and must be a number`);
    showUsage();
  }
  return id;
}

async function main() {
  console.error(`Using API: ${API_URL}`);

  switch (command) {
    // ── READ commands ──────────────────────────────────────────

    case 'models': {
      const result = await trpcCall('moderator.models.query', pagination(), 'GET');
      output(result, jsonMode);
      break;
    }

    case 'flagged-models': {
      const result = await trpcCall('moderator.models.queryFlagged', pagination(), 'GET');
      output(result, jsonMode);
      break;
    }

    case 'model-versions': {
      const result = await trpcCall('moderator.modelVersions.query', pagination(), 'GET');
      output(result, jsonMode);
      break;
    }

    case 'articles': {
      const result = await trpcCall('moderator.articles.query', pagination(), 'GET');
      output(result, jsonMode);
      break;
    }

    case 'training-models': {
      const result = await trpcCall('moderator.models.queryTraining', pagination(), 'GET');
      output(result, jsonMode);
      break;
    }

    case 'mod-rule': {
      const id = requireId('Rule ID');
      const result = await trpcCall('moderator.rules.getById', { id }, 'GET');
      output(result, jsonMode);
      break;
    }

    // ── WRITE commands ─────────────────────────────────────────

    case 'resolve-flagged': {
      const ids = parseIds(flags['ids']);
      if (ids.length === 0) {
        console.error('Error: --ids is required (comma-separated model IDs)');
        showUsage();
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would resolve flagged models:`);
        console.log(`IDs: ${ids.join(', ')}`);
        break;
      }

      const result = await trpcCall('moderator.models.resolveFlagged', { ids }, 'POST');
      output(result, jsonMode, () => `Resolved ${ids.length} flagged model(s): ${ids.join(', ')}`);
      break;
    }

    case 'rescan-model': {
      const id = requireId('Model ID');

      if (dryRun) {
        console.log(`[DRY RUN] Would rescan model: ${id}`);
        break;
      }

      const result = await trpcCall('model.rescan', { id }, 'POST');
      output(result, jsonMode, () => `Rescan initiated for model ${id}`);
      break;
    }

    case 'restore-model': {
      const id = requireId('Model ID');

      if (dryRun) {
        console.log(`[DRY RUN] Would restore model: ${id}`);
        break;
      }

      const result = await trpcCall('model.restore', { id }, 'POST');
      output(result, jsonMode, () => `Restored model ${id}`);
      break;
    }

    case 'toggle-cannot-promote': {
      const id = requireId('Model ID');

      if (dryRun) {
        console.log(`[DRY RUN] Would toggle cannot-promote for model: ${id}`);
        break;
      }

      const result = await trpcCall('model.toggleCannotPromote', { id }, 'POST');
      output(result, jsonMode, () => `Toggled cannot-promote for model ${id}`);
      break;
    }

    case 'toggle-cannot-publish': {
      const id = requireId('Model ID');

      if (dryRun) {
        console.log(`[DRY RUN] Would toggle cannot-publish for model: ${id}`);
        break;
      }

      const result = await trpcCall('model.toggleCannotPublish', { id }, 'POST');
      output(result, jsonMode, () => `Toggled cannot-publish for model ${id}`);
      break;
    }

    case 'approve-training': {
      const id = requireId('Training data ID');

      if (dryRun) {
        console.log(`[DRY RUN] Would approve training data: ${id}`);
        break;
      }

      const result = await trpcCall('moderator.trainingData.approve', { id }, 'POST');
      output(result, jsonMode, () => `Approved training data ${id}`);
      break;
    }

    case 'deny-training': {
      const id = requireId('Training data ID');

      if (dryRun) {
        console.log(`[DRY RUN] Would deny training data: ${id}`);
        break;
      }

      const result = await trpcCall('moderator.trainingData.deny', { id }, 'POST');
      output(result, jsonMode, () => `Denied training data ${id}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

run(main);
