#!/usr/bin/env node

/**
 * Strike System Moderation - Manage user strikes via tRPC API
 *
 * Commands:
 *   get-user <userId>       View strike history for a user
 *   standings               View user strike standings
 *   list                    List all strikes
 *   create <userId>         Create a strike for a user
 *   void <strikeId>         Void a strike
 *
 * Options:
 *   --json                  Output raw JSON
 *   --dry-run               Preview without making changes (create, void)
 *   --reason <code>         Strike reason code / void reason
 *   --description <text>    Strike description
 *   --internal <text>       Internal notes
 *   --points <1-3>          Strike points (default 1)
 *   --entity-type <type>    Entity type
 *   --entity-id <id>        Entity ID
 *   --report-id <id>        Report ID
 *   --expires-days <n>      Days until expiry (default 30)
 *   --user-id <id>          Filter by user ID
 *   --username <name>       Filter by username
 *   --status <s1,s2>        Filter by status (comma-separated)
 *   --sort <field>          Sort field
 *   --sort-order <asc|desc> Sort direction
 *   --flagged-for-review    Boolean filter flag
 *   --has-active-strikes    Boolean filter flag
 *   --page <n>              Page number
 *   --limit <n>             Page size
 */

import {
  requireApiKey, trpcCall, parseArgs, output, parseIds, intOrUndef, run, API_URL,
} from './lib.mjs';

requireApiKey();

const STRIKE_REASONS = [
  'BlockedContent', 'RealisticMinorContent', 'CSAMContent', 'TOSViolation',
  'HarassmentContent', 'ProhibitedContent', 'ManualModAction',
];

const STRIKE_STATUSES = ['Active', 'Expired', 'Voided'];

const SORT_FIELDS = ['points', 'score', 'lastStrike', 'created'];

const { command, target, flags } = parseArgs(process.argv);

function showUsage() {
  console.error(`Usage: node strikes.mjs <command> [options]

Commands:
  get-user <userId>       View strike history for a user
  standings               View user strike standings
  list                    List all strikes
  create <userId>         Create a strike for a user
  void <strikeId>         Void a strike

Options:
  --json                  Output raw JSON
  --dry-run               Preview without making changes (create, void)
  --reason <code>         Strike reason code / void reason text
  --description <text>    Strike description
  --internal <text>       Internal notes
  --points <1-3>          Strike points (default 1)
  --entity-type <type>    Entity type
  --entity-id <id>        Entity ID
  --report-id <id>        Report ID
  --expires-days <n>      Days until expiry (default 30)
  --user-id <id>          Filter by user ID
  --username <name>       Filter by username
  --status <s1,s2>        Filter by status (comma-separated)
  --sort <field>          Sort field (points, score, lastStrike, created)
  --sort-order <asc|desc> Sort direction (default: desc)
  --flagged-for-review    Filter flagged for review
  --has-active-strikes    Filter users with active strikes
  --page <n>              Page number (default: 1)
  --limit <n>             Page size (default: 20)

Strike Reasons:
  ${STRIKE_REASONS.join(', ')}

Strike Statuses:
  ${STRIKE_STATUSES.join(', ')}

Examples:
  node strikes.mjs get-user 3879899
  node strikes.mjs standings --has-active-strikes --limit 10
  node strikes.mjs standings --username someuser --sort points
  node strikes.mjs list --status Active,Expired --limit 50
  node strikes.mjs list --user-id 3879899 --reason TOSViolation
  node strikes.mjs create 3879899 --reason TOSViolation --description "Violated terms" --points 2
  node strikes.mjs create 3879899 --reason BlockedContent --description "Blocked content" --entity-type Image --entity-id 12345 --dry-run
  node strikes.mjs void 42 --reason "Strike issued in error"

Configuration:
  Set CIVITAI_API_KEY and CIVITAI_API_URL in .claude/skills/mod-actions/.env
  See .env-example for details.`);
  process.exit(1);
}

if (!command) showUsage();

const jsonOutput = !!flags['json'];
const dryRun = !!flags['dry-run'];

// -- Formatters --

function formatStrike(s) {
  let out = `Strike #${s.id}\n`;
  if (s.userId) out += `  User ID: ${s.userId}\n`;
  if (s.username) out += `  Username: ${s.username}\n`;
  out += `  Reason: ${s.reason}\n`;
  out += `  Points: ${s.points}\n`;
  out += `  Status: ${s.status}\n`;
  if (s.description) out += `  Description: ${s.description}\n`;
  if (s.internalNotes) out += `  Internal Notes: ${s.internalNotes}\n`;
  if (s.entityType) out += `  Entity: ${s.entityType} #${s.entityId}\n`;
  if (s.reportId) out += `  Report ID: ${s.reportId}\n`;
  if (s.createdAt) out += `  Created: ${new Date(s.createdAt).toISOString().split('T')[0]}\n`;
  if (s.expiresAt) out += `  Expires: ${new Date(s.expiresAt).toISOString().split('T')[0]}\n`;
  if (s.voidedAt) out += `  Voided: ${new Date(s.voidedAt).toISOString().split('T')[0]}\n`;
  if (s.voidReason) out += `  Void Reason: ${s.voidReason}\n`;
  return out;
}

function formatUserHistory(data) {
  const strikes = data.strikes || data.items || (Array.isArray(data) ? data : [data]);
  if (!strikes.length) return 'No strikes found for this user.';
  let out = `Strike History (${strikes.length} strike${strikes.length !== 1 ? 's' : ''}):\n\n`;
  out += strikes.map(formatStrike).join('\n');
  return out.trimEnd();
}

function formatStandings(data) {
  const items = data.items || (Array.isArray(data) ? data : []);
  if (!items.length) return 'No standings found.';

  let out = 'User Strike Standings:\n\n';
  out += 'Username'.padEnd(25) +
    'Active Strikes'.padEnd(16) +
    'Total Points'.padEnd(14) +
    'Muted'.padEnd(8) +
    'Flagged\n';
  out += '-'.repeat(70) + '\n';

  for (const u of items) {
    const username = (u.username || `User#${u.userId}`).padEnd(25);
    const active = String(u.activeStrikes ?? u.activeStrikeCount ?? '-').padEnd(16);
    const points = String(u.totalPoints ?? u.points ?? '-').padEnd(14);
    const muted = (u.isMuted || u.muted ? 'Yes' : 'No').padEnd(8);
    const flagged = u.isFlaggedForReview || u.flaggedForReview ? 'Yes' : 'No';
    out += `${username}${active}${points}${muted}${flagged}\n`;
  }

  if (data.totalItems || data.total) {
    out += `\nTotal: ${data.totalItems ?? data.total}`;
    if (data.totalPages || data.pages) out += ` | Pages: ${data.totalPages ?? data.pages}`;
    out += '\n';
  }
  return out.trimEnd();
}

function formatStrikeList(data) {
  const items = data.items || (Array.isArray(data) ? data : []);
  if (!items.length) return 'No strikes found.';

  let out = `Strikes (${items.length} shown):\n\n`;
  out += items.map(formatStrike).join('\n');

  if (data.totalItems || data.total) {
    out += `\nTotal: ${data.totalItems ?? data.total}`;
    if (data.totalPages || data.pages) out += ` | Pages: ${data.totalPages ?? data.pages}`;
    out += '\n';
  }
  return out.trimEnd();
}

async function main() {
  console.error(`Using API: ${API_URL}`);

  switch (command) {
    case 'get-user': {
      if (!target) {
        console.error('Error: User ID required');
        showUsage();
      }
      const userId = parseInt(target);
      if (isNaN(userId)) {
        console.error('Error: User ID must be a number');
        process.exit(1);
      }

      const result = await trpcCall('strike.getUserHistory', { userId }, 'GET');
      output(result, jsonOutput, formatUserHistory);
      break;
    }

    case 'standings': {
      const input = {
        limit: intOrUndef(flags['limit']) ?? 20,
        page: intOrUndef(flags['page']) ?? 1,
        sort: flags['sort'] || 'points',
        sortOrder: flags['sort-order'] || 'desc',
      };
      if (flags['user-id']) input.userId = parseInt(flags['user-id']);
      if (flags['username']) input.username = flags['username'];
      if (flags['has-active-strikes']) input.hasActiveStrikes = true;
      if (flags['flagged-for-review']) input.isFlaggedForReview = true;
      if (flags['is-muted']) input.isMuted = true;

      if (input.sort && !SORT_FIELDS.includes(input.sort)) {
        console.error(`Error: Invalid sort field. Valid fields: ${SORT_FIELDS.join(', ')}`);
        process.exit(1);
      }

      const result = await trpcCall('strike.getUserStandings', input, 'GET');
      output(result, jsonOutput, formatStandings);
      break;
    }

    case 'list': {
      const input = {
        limit: intOrUndef(flags['limit']) ?? 20,
        page: intOrUndef(flags['page']) ?? 1,
      };
      if (flags['user-id']) input.userId = parseInt(flags['user-id']);
      if (flags['username']) input.username = flags['username'];
      if (flags['status']) {
        const statuses = flags['status'].split(',').map(s => s.trim());
        for (const s of statuses) {
          if (!STRIKE_STATUSES.includes(s)) {
            console.error(`Error: Invalid status "${s}". Valid statuses: ${STRIKE_STATUSES.join(', ')}`);
            process.exit(1);
          }
        }
        input.status = statuses;
      }
      if (flags['reason']) {
        const reasons = flags['reason'].split(',').map(s => s.trim());
        for (const r of reasons) {
          if (!STRIKE_REASONS.includes(r)) {
            console.error(`Error: Invalid reason "${r}". Valid reasons: ${STRIKE_REASONS.join(', ')}`);
            process.exit(1);
          }
        }
        input.reason = reasons;
      }

      const result = await trpcCall('strike.getAll', input, 'GET');
      output(result, jsonOutput, formatStrikeList);
      break;
    }

    case 'create': {
      if (!target) {
        console.error('Error: User ID required');
        showUsage();
      }
      const userId = parseInt(target);
      if (isNaN(userId)) {
        console.error('Error: User ID must be a number');
        process.exit(1);
      }
      if (!flags['reason']) {
        console.error('Error: --reason is required for create command');
        process.exit(1);
      }
      if (!STRIKE_REASONS.includes(flags['reason'])) {
        console.error(`Error: Invalid reason. Valid reasons: ${STRIKE_REASONS.join(', ')}`);
        process.exit(1);
      }
      if (!flags['description']) {
        console.error('Error: --description is required for create command');
        process.exit(1);
      }

      const points = intOrUndef(flags['points']) ?? 1;
      if (points < 1 || points > 3) {
        console.error('Error: --points must be between 1 and 3');
        process.exit(1);
      }

      const expiresInDays = intOrUndef(flags['expires-days']) ?? 30;
      if (expiresInDays < 1 || expiresInDays > 365) {
        console.error('Error: --expires-days must be between 1 and 365');
        process.exit(1);
      }

      const input = {
        userId,
        reason: flags['reason'],
        points,
        description: flags['description'],
        expiresInDays,
      };
      if (flags['internal']) input.internalNotes = flags['internal'];
      if (flags['entity-type']) input.entityType = flags['entity-type'];
      if (flags['entity-id']) input.entityId = parseInt(flags['entity-id']);
      if (flags['report-id']) input.reportId = parseInt(flags['report-id']);

      if (dryRun) {
        let out = '[DRY RUN] Would create strike:\n';
        out += `  User ID: ${userId}\n`;
        out += `  Reason: ${input.reason}\n`;
        out += `  Points: ${input.points}\n`;
        out += `  Description: ${input.description}\n`;
        out += `  Expires In: ${input.expiresInDays} days\n`;
        if (input.internalNotes) out += `  Internal Notes: ${input.internalNotes}\n`;
        if (input.entityType) out += `  Entity: ${input.entityType} #${input.entityId}\n`;
        if (input.reportId) out += `  Report ID: ${input.reportId}\n`;
        console.log(out.trimEnd());
        break;
      }

      const result = await trpcCall('strike.create', input, 'POST');
      output(result, jsonOutput, (data) => {
        let out = 'Strike created:\n';
        out += `  Strike ID: ${data.id ?? 'N/A'}\n`;
        out += `  User ID: ${userId}\n`;
        out += `  Reason: ${input.reason}\n`;
        out += `  Points: ${input.points}\n`;
        out += `  Description: ${input.description}\n`;
        out += `  Expires In: ${input.expiresInDays} days\n`;
        if (data.expiresAt) out += `  Expires At: ${new Date(data.expiresAt).toISOString().split('T')[0]}\n`;
        return out.trimEnd();
      });
      break;
    }

    case 'void': {
      if (!target) {
        console.error('Error: Strike ID required');
        showUsage();
      }
      const strikeId = parseInt(target);
      if (isNaN(strikeId)) {
        console.error('Error: Strike ID must be a number');
        process.exit(1);
      }
      if (!flags['reason']) {
        console.error('Error: --reason is required for void command (used as voidReason)');
        process.exit(1);
      }

      const input = {
        strikeId,
        voidReason: flags['reason'],
      };

      if (dryRun) {
        let out = '[DRY RUN] Would void strike:\n';
        out += `  Strike ID: ${strikeId}\n`;
        out += `  Void Reason: ${input.voidReason}\n`;
        console.log(out.trimEnd());
        break;
      }

      const result = await trpcCall('strike.void', input, 'POST');
      output(result, jsonOutput, (data) => {
        let out = 'Strike voided:\n';
        out += `  Strike ID: ${strikeId}\n`;
        out += `  Void Reason: ${input.voidReason}\n`;
        if (data.voidedAt) out += `  Voided At: ${new Date(data.voidedAt).toISOString().split('T')[0]}\n`;
        out += `  Status: Voided\n`;
        return out.trimEnd();
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

run(main);
