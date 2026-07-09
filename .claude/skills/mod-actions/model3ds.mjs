#!/usr/bin/env node

/**
 * Model3D Moderation - CLI script for managing 3D models.
 *
 * Commands:
 *   list                              List Model3Ds (mod sees all statuses)
 *   get <id>                          Get a Model3D by id
 *   files <id>                        List files for a Model3D
 *   unpublish <id>                    Unpublish (status -> Unpublished)
 *   delete <id>                       Soft-delete (status -> Deleted, sets deletedAt/deletedBy)
 *   restore <id>                      Restore: Deleted -> Unpublished, Unpublished -> Published
 *   set-nsfw-level <id>               Override nsfwLevel (use --level <n> [--lock])
 *   toggle-tos <id>                   Toggle tosViolation (locks the field)
 *   toggle-poi <id>                   Toggle poi (locks the field)
 *   toggle-minor <id>                 Toggle minor (locks the field)
 *   toggle-nsfw <id>                  Toggle nsfw (locks the field)
 *   toggle-unlisted <id>              Toggle unlisted (locks the field)
 *
 * Strikes
 *   Strikes work for EntityType.Model3D out of the box — file via the existing
 *   strikes.mjs:
 *     node strikes.mjs create <userId> --entity-type Model3D --entity-id <model3dId> ...
 *
 * Options:
 *   --json                Output raw JSON
 *   --dry-run             Preview without making changes (write commands)
 *   --status <s>          Filter `list` by status (Draft | Published | Unpublished | Deleted)
 *   --username <u>        Filter `list` by creator username
 *   --limit <n>           List limit (default: 50)
 *   --cursor <id>         List cursor for pagination (next cursor surfaces in JSON)
 *   --level <n>           NSFW level for set-nsfw-level (required)
 *   --lock                Lock the field after set-nsfw-level (recommended on overrides)
 */

import {
  requireApiKey, trpcCall, parseArgs, output, intOrUndef, run, API_URL,
} from './lib.mjs';

requireApiKey();

const { command, target, flags } = parseArgs(process.argv);
const jsonMode = !!flags['json'];
const dryRun = !!flags['dry-run'];

const VALID_STATUSES = ['Draft', 'Published', 'Unpublished', 'Deleted'];
const VALID_FLAG_FIELDS = ['tosViolation', 'poi', 'minor', 'nsfw', 'unlisted'];

function showUsage() {
  console.error(`Usage: node model3ds.mjs <command> [options]

Commands (READ):
  list [--status <s>] [--username <u>] [--limit <n>] [--cursor <id>]
  get <id>
  files <id>

Commands (WRITE):
  unpublish <id>
  delete <id>
  restore <id>
  set-nsfw-level <id> --level <n> [--lock]
  toggle-tos <id>
  toggle-poi <id>
  toggle-minor <id>
  toggle-nsfw <id>
  toggle-unlisted <id>

Options:
  --json                Output raw JSON
  --dry-run             Preview without making changes (write commands)
  --status <s>          Draft | Published | Unpublished | Deleted
  --username <u>        Filter list by creator username
  --limit <n>           Default 50
  --cursor <id>         Cursor for pagination
  --level <n>           NSFW level (required for set-nsfw-level)
  --lock                Lock the field after override

Strikes against a Model3D are filed via strikes.mjs:
  node strikes.mjs create <userId> --entity-type Model3D --entity-id <model3dId> ...

Examples:
  node model3ds.mjs list --status Draft --limit 100
  node model3ds.mjs get 42
  node model3ds.mjs unpublish 42
  node model3ds.mjs set-nsfw-level 42 --level 16 --lock
  node model3ds.mjs toggle-tos 42 --dry-run
`);
  process.exit(1);
}

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

    case 'list': {
      const status = flags['status'];
      if (status && !VALID_STATUSES.includes(status)) {
        console.error(`Error: --status must be one of ${VALID_STATUSES.join(', ')}`);
        showUsage();
      }
      const input = {
        limit: intOrUndef(flags['limit']) ?? 50,
        cursor: intOrUndef(flags['cursor']),
        statuses: status ? [status] : undefined,
        username: flags['username'] || undefined,
      };
      const result = await trpcCall('model3d.getInfinite', input, 'GET');
      output(result, jsonMode);
      break;
    }

    case 'get': {
      const id = requireId('Model3D ID');
      const result = await trpcCall('model3d.getById', { id }, 'GET');
      output(result, jsonMode);
      break;
    }

    case 'files': {
      const id = requireId('Model3D ID');
      const result = await trpcCall('model3d.getFiles', { id }, 'GET');
      output(result, jsonMode);
      break;
    }

    // ── WRITE commands ─────────────────────────────────────────

    case 'unpublish': {
      const id = requireId('Model3D ID');
      if (dryRun) {
        console.log(`[DRY RUN] Would unpublish Model3D ${id}`);
        break;
      }
      const result = await trpcCall('model3d.unpublish', { id }, 'POST');
      output(result, jsonMode, () => `Unpublished Model3D ${id}`);
      break;
    }

    case 'delete': {
      const id = requireId('Model3D ID');
      if (dryRun) {
        console.log(`[DRY RUN] Would delete Model3D ${id}`);
        break;
      }
      const result = await trpcCall('model3d.delete', { id }, 'POST');
      output(result, jsonMode, () => `Deleted Model3D ${id}`);
      break;
    }

    case 'restore': {
      const id = requireId('Model3D ID');
      if (dryRun) {
        console.log(`[DRY RUN] Would restore Model3D ${id}`);
        break;
      }
      const result = await trpcCall('model3d.moderation.restore', { id }, 'POST');
      output(result, jsonMode, () => `Restored Model3D ${id}`);
      break;
    }

    case 'set-nsfw-level': {
      const id = requireId('Model3D ID');
      const nsfwLevel = intOrUndef(flags['level']);
      if (nsfwLevel === undefined) {
        console.error('Error: --level <n> is required');
        showUsage();
      }
      const lock = !!flags['lock'];
      const payload = { id, nsfwLevel, lock };
      if (dryRun) {
        console.log(`[DRY RUN] Would set Model3D ${id} nsfwLevel=${nsfwLevel} lock=${lock}`);
        break;
      }
      const result = await trpcCall('model3d.moderation.setNsfwLevel', payload, 'POST');
      output(
        result,
        jsonMode,
        () => `Model3D ${id} nsfwLevel=${nsfwLevel}${lock ? ' (locked)' : ''}`
      );
      break;
    }

    case 'toggle-tos':
    case 'toggle-poi':
    case 'toggle-minor':
    case 'toggle-nsfw':
    case 'toggle-unlisted': {
      const id = requireId('Model3D ID');
      const field = {
        'toggle-tos': 'tosViolation',
        'toggle-poi': 'poi',
        'toggle-minor': 'minor',
        'toggle-nsfw': 'nsfw',
        'toggle-unlisted': 'unlisted',
      }[command];
      if (!VALID_FLAG_FIELDS.includes(field)) {
        console.error(`Internal error: unmapped field for ${command}`);
        process.exit(1);
      }
      if (dryRun) {
        console.log(`[DRY RUN] Would toggle ${field} on Model3D ${id}`);
        break;
      }
      const result = await trpcCall('model3d.moderation.toggleFlag', { id, field }, 'POST');
      output(result, jsonMode, () => `Toggled ${field} on Model3D ${id}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

run(main);
