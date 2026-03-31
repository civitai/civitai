#!/usr/bin/env node

/**
 * Moderator Actions - Image moderation skill via tRPC API
 *
 * Commands:
 *   review-queue                    Show images pending moderator review
 *   review-counts                   Show counts for each review queue tab
 *   moderate <imageIds> <action>    Moderate images with a given action
 *   tos-violation <imageId>         Mark image as ToS violation
 *   rescan <imageId>                Rescan an image
 *   report-csam <imageIds>          Report images as CSAM
 *   poi-tags                        Show moderator POI tags
 *   user-images <userId>            Show images by user for moderation
 *   rating-requests                 Show image rating requests
 *   ingestion-errors                Show images with ingestion errors
 *   resolve-ingestion <imageId>     Resolve an ingestion error
 *   downleveled                     Show downleveled images
 *   pending-ingestion               Show images pending ingestion
 *   toggle-flag <imageId>           Toggle a flag on an image
 *
 * Options:
 *   --json                Output raw JSON
 *   --dry-run             Preview without making changes
 *   --ids <id1,id2,...>   Comma-separated image IDs
 *   --user-id <id>        Filter by user ID
 *   --action <action>     Moderation action
 *   --review-type <type>  Review type filter
 *   --review-action <a>   Review action
 *   --flag <name>         Flag name for toggle-flag
 *   --cursor <n>          Cursor for pagination
 *   --page <n>            Page number
 *   --limit <n>           Page size
 *   --tag-review          Filter: tag review queue
 *   --report-review       Filter: report review queue
 *   --needs-review        Filter: needs review queue
 */

import {
  requireApiKey, trpcCall, parseArgs, output, parseIds, intOrUndef, run, API_URL,
} from './lib.mjs';

requireApiKey();

const { command, target, extra, flags } = parseArgs(process.argv);

function showUsage() {
  console.error(`Usage: node images.mjs <command> [target] [options]

Commands (READ):
  review-queue                    Show images pending moderator review
  review-counts                   Show counts for each review queue tab
  poi-tags                        Show moderator POI tags
  user-images <userId>            Show images by user for moderation
  rating-requests                 Show image rating requests
  ingestion-errors                Show images with ingestion errors
  downleveled                     Show downleveled images
  pending-ingestion               Show images pending ingestion

Commands (WRITE - support --dry-run):
  moderate <imageIds> <action>    Moderate images (imageIds comma-separated)
  tos-violation <imageId>         Mark image as ToS violation
  rescan <imageId>                Rescan an image
  report-csam <imageIds>          Report images as CSAM (imageIds comma-separated)
  resolve-ingestion <imageId>     Resolve an ingestion error
  toggle-flag <imageId>           Toggle a flag on an image

Options:
  --json                Output raw JSON
  --dry-run             Preview without making changes
  --ids <id1,id2,...>   Comma-separated image IDs (alternative to positional)
  --user-id <id>        Filter by user ID
  --action <action>     Moderation action (for moderate command)
  --review-type <type>  Review type filter
  --review-action <a>   Review action (for moderate command)
  --flag <name>         Flag name (for toggle-flag command)
  --cursor <n>          Cursor for pagination
  --page <n>            Page number
  --limit <n>           Page size
  --tag-review          Filter: tag review queue
  --report-review       Filter: report review queue
  --needs-review        Filter: needs review queue

Examples:
  node images.mjs review-queue
  node images.mjs review-queue --limit 10 --needs-review
  node images.mjs review-counts
  node images.mjs moderate 123,456 delete --dry-run
  node images.mjs moderate --ids 123,456 --action delete
  node images.mjs tos-violation 789
  node images.mjs rescan 789 --dry-run
  node images.mjs report-csam 100,200,300
  node images.mjs poi-tags
  node images.mjs user-images 42 --limit 20
  node images.mjs rating-requests --page 2 --limit 25
  node images.mjs ingestion-errors
  node images.mjs resolve-ingestion 555
  node images.mjs downleveled --cursor 10
  node images.mjs pending-ingestion --limit 50
  node images.mjs toggle-flag 789 --flag someFlag --json

Configuration:
  Set CIVITAI_API_KEY and CIVITAI_API_URL in .claude/skills/mod-actions/.env
  See .env-example for details.`);
  process.exit(1);
}

if (!command) showUsage();

const jsonMode = !!flags['json'];
const dryRun = !!flags['dry-run'];

function paginationInput() {
  const input = {};
  const cursor = intOrUndef(flags['cursor']);
  const page = intOrUndef(flags['page']);
  const limit = intOrUndef(flags['limit']);
  if (cursor !== undefined) input.cursor = cursor;
  if (page !== undefined) input.page = page;
  if (limit !== undefined) input.limit = limit;
  return input;
}

async function main() {
  console.error(`Using API: ${API_URL}`);

  switch (command) {
    // ── READ commands ──────────────────────────────────────────────

    case 'review-queue': {
      const input = { ...paginationInput() };
      if (flags['tag-review']) input.tagReview = true;
      if (flags['report-review']) input.reportReview = true;
      if (flags['needs-review']) input.needsReview = true;
      if (flags['review-type']) input.reviewType = flags['review-type'];

      const result = await trpcCall('image.getModeratorReviewQueue', input, 'GET');
      output(result, jsonMode, (data) => {
        const items = data.items || data;
        if (!Array.isArray(items) || items.length === 0) return 'No images in review queue.';
        let out = `Review Queue (${items.length} images):\n`;
        for (const img of items) {
          out += `  ID: ${img.id} | User: ${img.user?.username ?? img.userId ?? 'N/A'} | Status: ${img.status ?? 'N/A'}\n`;
        }
        if (data.nextCursor) out += `\nNext cursor: ${data.nextCursor}`;
        return out;
      });
      break;
    }

    case 'review-counts': {
      const result = await trpcCall('image.getModeratorReviewQueueCounts', undefined, 'GET');
      output(result, jsonMode, (data) => {
        let out = 'Review Queue Counts:\n';
        for (const [key, value] of Object.entries(data)) {
          out += `  ${key}: ${value}\n`;
        }
        return out;
      });
      break;
    }

    case 'poi-tags': {
      const result = await trpcCall('image.getModeratorPOITags', undefined, 'GET');
      output(result, jsonMode, (data) => {
        const items = Array.isArray(data) ? data : data.items || [];
        if (items.length === 0) return 'No POI tags found.';
        let out = `POI Tags (${items.length}):\n`;
        for (const tag of items) {
          out += `  ${tag.name ?? tag.id ?? JSON.stringify(tag)}\n`;
        }
        return out;
      });
      break;
    }

    case 'user-images': {
      const userId = intOrUndef(target) ?? intOrUndef(flags['user-id']);
      if (userId === undefined) {
        console.error('Error: userId required (positional or --user-id)');
        showUsage();
      }
      const input = { userId, ...paginationInput() };
      const result = await trpcCall('image.getImagesByUserIdForModeration', input, 'GET');
      output(result, jsonMode, (data) => {
        const items = data.items || data;
        if (!Array.isArray(items) || items.length === 0) return `No images found for user ${userId}.`;
        let out = `Images for user ${userId} (${items.length}):\n`;
        for (const img of items) {
          out += `  ID: ${img.id} | Status: ${img.status ?? 'N/A'} | NSFW: ${img.nsfw ?? 'N/A'}\n`;
        }
        if (data.nextCursor) out += `\nNext cursor: ${data.nextCursor}`;
        return out;
      });
      break;
    }

    case 'rating-requests': {
      const input = { ...paginationInput() };
      const result = await trpcCall('image.getImageRatingRequests', input, 'GET');
      output(result, jsonMode, (data) => {
        const items = data.items || data;
        if (!Array.isArray(items) || items.length === 0) return 'No rating requests found.';
        let out = `Rating Requests (${items.length}):\n`;
        for (const req of items) {
          out += `  Image ID: ${req.imageId ?? req.id ?? 'N/A'} | Status: ${req.status ?? 'N/A'}\n`;
        }
        if (data.nextCursor) out += `\nNext cursor: ${data.nextCursor}`;
        return out;
      });
      break;
    }

    case 'ingestion-errors': {
      const input = { ...paginationInput() };
      const result = await trpcCall('image.getIngestionErrorImages', input, 'GET');
      output(result, jsonMode, (data) => {
        const items = data.items || data;
        if (!Array.isArray(items) || items.length === 0) return 'No ingestion errors found.';
        let out = `Ingestion Errors (${items.length}):\n`;
        for (const img of items) {
          out += `  ID: ${img.id} | Error: ${img.error ?? img.ingestionStatus ?? 'N/A'}\n`;
        }
        if (data.nextCursor) out += `\nNext cursor: ${data.nextCursor}`;
        return out;
      });
      break;
    }

    case 'downleveled': {
      const input = { ...paginationInput() };
      const result = await trpcCall('image.getDownleveledImages', input, 'GET');
      output(result, jsonMode, (data) => {
        const items = data.items || data;
        if (!Array.isArray(items) || items.length === 0) return 'No downleveled images found.';
        let out = `Downleveled Images (${items.length}):\n`;
        for (const img of items) {
          out += `  ID: ${img.id} | User: ${img.user?.username ?? img.userId ?? 'N/A'}\n`;
        }
        if (data.nextCursor) out += `\nNext cursor: ${data.nextCursor}`;
        return out;
      });
      break;
    }

    case 'pending-ingestion': {
      const input = { ...paginationInput() };
      const result = await trpcCall('image.getAllImagesPendingIngestion', input, 'GET');
      output(result, jsonMode, (data) => {
        const items = data.items || data;
        if (!Array.isArray(items) || items.length === 0) return 'No images pending ingestion.';
        let out = `Pending Ingestion (${items.length}):\n`;
        for (const img of items) {
          out += `  ID: ${img.id} | Status: ${img.ingestionStatus ?? 'N/A'}\n`;
        }
        if (data.nextCursor) out += `\nNext cursor: ${data.nextCursor}`;
        return out;
      });
      break;
    }

    // ── WRITE commands ─────────────────────────────────────────────

    case 'moderate': {
      const ids = parseIds(target) || parseIds(flags['ids']);
      const action = extra[0] || flags['action'];
      if (!ids || ids.length === 0) {
        console.error('Error: imageIds required (positional comma-separated or --ids)');
        showUsage();
      }
      if (!action) {
        console.error('Error: action required (positional after IDs or --action)');
        showUsage();
      }

      const input = { ids, action };
      if (flags['review-type']) input.reviewType = flags['review-type'];
      if (flags['review-action']) input.reviewAction = flags['review-action'];

      if (dryRun) {
        console.log(`[DRY RUN] Would moderate images:`);
        console.log(`  Image IDs: ${ids.join(', ')}`);
        console.log(`  Action: ${action}`);
        if (input.reviewType) console.log(`  Review Type: ${input.reviewType}`);
        if (input.reviewAction) console.log(`  Review Action: ${input.reviewAction}`);
        break;
      }

      const result = await trpcCall('image.moderate', input, 'POST');
      output(result, jsonMode, () => {
        return `Action: MODERATE\nImage IDs: ${ids.join(', ')}\nAction: ${action}\nSuccess: Yes`;
      });
      break;
    }

    case 'tos-violation': {
      const id = intOrUndef(target) ?? intOrUndef(flags['ids']);
      if (id === undefined) {
        console.error('Error: imageId required');
        showUsage();
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would set ToS violation:`);
        console.log(`  Image ID: ${id}`);
        break;
      }

      const result = await trpcCall('image.setTosViolation', { id }, 'POST');
      output(result, jsonMode, () => {
        return `Action: TOS VIOLATION\nImage ID: ${id}\nSuccess: Yes`;
      });
      break;
    }

    case 'rescan': {
      const id = intOrUndef(target) ?? intOrUndef(flags['ids']);
      if (id === undefined) {
        console.error('Error: imageId required');
        showUsage();
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would rescan image:`);
        console.log(`  Image ID: ${id}`);
        break;
      }

      const result = await trpcCall('image.rescan', { id }, 'POST');
      output(result, jsonMode, () => {
        return `Action: RESCAN\nImage ID: ${id}\nSuccess: Yes`;
      });
      break;
    }

    case 'report-csam': {
      const imageIds = parseIds(target) || parseIds(flags['ids']);
      if (!imageIds || imageIds.length === 0) {
        console.error('Error: imageIds required (comma-separated)');
        showUsage();
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would report CSAM:`);
        console.log(`  Image IDs: ${imageIds.join(', ')}`);
        break;
      }

      const result = await trpcCall('image.reportCsamImages', { imageIds }, 'POST');
      output(result, jsonMode, () => {
        return `Action: REPORT CSAM\nImage IDs: ${imageIds.join(', ')}\nSuccess: Yes`;
      });
      break;
    }

    case 'resolve-ingestion': {
      const id = intOrUndef(target) ?? intOrUndef(flags['ids']);
      if (id === undefined) {
        console.error('Error: imageId required');
        showUsage();
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would resolve ingestion error:`);
        console.log(`  Image ID: ${id}`);
        break;
      }

      const result = await trpcCall('image.resolveIngestionError', { id }, 'POST');
      output(result, jsonMode, () => {
        return `Action: RESOLVE INGESTION\nImage ID: ${id}\nSuccess: Yes`;
      });
      break;
    }

    case 'toggle-flag': {
      const id = intOrUndef(target) ?? intOrUndef(flags['ids']);
      if (id === undefined) {
        console.error('Error: imageId required');
        showUsage();
      }

      const input = { id };
      if (flags['flag']) input.flag = flags['flag'];

      if (dryRun) {
        console.log(`[DRY RUN] Would toggle flag on image:`);
        console.log(`  Image ID: ${id}`);
        if (input.flag) console.log(`  Flag: ${input.flag}`);
        break;
      }

      const result = await trpcCall('image.toggleImageFlag', input, 'POST');
      output(result, jsonMode, () => {
        let out = `Action: TOGGLE FLAG\nImage ID: ${id}`;
        if (input.flag) out += `\nFlag: ${input.flag}`;
        out += `\nSuccess: Yes`;
        return out;
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

run(main);
