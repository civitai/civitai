#!/usr/bin/env node

/**
 * Report Handling Moderation - CLI script for managing reports and appeals
 *
 * Commands:
 *   list                             List reports by type
 *   set-status <reportId> <status>   Set a single report's status
 *   bulk-status <status>             Bulk update report statuses
 *   update <reportId>                Update a report (status + notes)
 *   appeals                          List recent appeals
 *   appeal-details <id>              Get appeal details
 *   resolve-appeal                   Resolve one or more appeals
 *
 * Options:
 *   --json                Output raw JSON
 *   --dry-run             Preview without making changes
 *   --type <ReportEntity>  Report entity type
 *   --status <Status>     Report or appeal status
 *   --ids <id1,id2,...>   Comma-separated IDs
 *   --entity-type <type>  Entity type for appeals
 *   --internal <text>     Internal notes
 *   --message <text>      Resolved message for appeals
 *   --user-id <id>        Filter by user ID
 *   --start-date <date>   Filter appeals by start date
 *   --page <n>            Page number
 *   --limit <n>           Page size
 *   --query <text>        Search query
 */

import {
  requireApiKey, trpcCall, parseArgs, output, parseIds, intOrUndef, run, API_URL,
} from './lib.mjs';

requireApiKey();

const REPORT_ENTITIES = [
  'model', 'comment', 'commentV2', 'image', 'resourceReview', 'article',
  'post', 'reportedUser', 'collection', 'bounty', 'bountyEntry', 'chat', 'comicProject',
];

const REPORT_STATUSES = ['Pending', 'Processing', 'Actioned', 'Unactioned'];
const APPEAL_STATUSES = ['Pending', 'Approved', 'Rejected'];

const { command, target, extra, flags } = parseArgs(process.argv);
const jsonMode = !!flags['json'];
const dryRun = !!flags['dry-run'];

function showUsage() {
  console.error(`Usage: node reports.mjs <command> [args] [options]

Commands:
  list                             List reports (requires --type)
  set-status <reportId> <status>   Set a report's status
  bulk-status <status>             Bulk update report statuses (requires --ids)
  update <reportId>                Update a report (status, notes)
  appeals                          List recent appeals
  appeal-details <id>              Get appeal details
  resolve-appeal                   Resolve appeals (requires --ids, --entity-type, --status)

Options:
  --json                Output raw JSON
  --dry-run             Preview without making changes
  --type <ReportEntity>  Report entity type
  --status <Status>     Report or appeal status
  --ids <id1,id2,...>   Comma-separated IDs
  --entity-type <type>  Entity type for appeals
  --internal <text>     Internal notes
  --message <text>      Resolved message for appeals
  --user-id <id>        Filter by user ID
  --start-date <date>   Filter appeals by start date
  --page <n>            Page number
  --limit <n>           Page size
  --query <text>        Search query

ReportEntity values:
  ${REPORT_ENTITIES.join(', ')}

ReportStatus values:
  ${REPORT_STATUSES.join(', ')}

AppealStatus values:
  ${APPEAL_STATUSES.join(', ')}

Examples:
  node reports.mjs list --type image --limit 20
  node reports.mjs list --type model --page 2 --query "stolen"
  node reports.mjs set-status 12345 Actioned
  node reports.mjs set-status 12345 Unactioned --dry-run
  node reports.mjs bulk-status Processing --ids 100,101,102
  node reports.mjs update 12345 --status Actioned --internal "Reviewed, confirmed violation"
  node reports.mjs appeals --user-id 999
  node reports.mjs appeals --start-date 2025-01-01
  node reports.mjs appeal-details 456
  node reports.mjs resolve-appeal --ids 10,11 --entity-type image --status Approved --message "Appeal granted"

Configuration:
  Set CIVITAI_API_KEY and CIVITAI_API_URL in .claude/skills/mod-actions/.env
  See .env-example for details.`);
  process.exit(1);
}

if (!command) showUsage();

function validateStatus(status, allowed, label) {
  if (!allowed.includes(status)) {
    console.error(`Error: Invalid ${label}. Valid values: ${allowed.join(', ')}`);
    process.exit(1);
  }
}

function validateEntity(type) {
  if (!REPORT_ENTITIES.includes(type)) {
    console.error(`Error: Invalid report entity type. Valid values: ${REPORT_ENTITIES.join(', ')}`);
    process.exit(1);
  }
}

function formatReport(r) {
  let out = `Report #${r.id}\n`;
  if (r.type) out += `  Type: ${r.type}\n`;
  if (r.status) out += `  Status: ${r.status}\n`;
  if (r.reason) out += `  Reason: ${r.reason}\n`;
  if (r.createdAt) out += `  Created: ${new Date(r.createdAt).toISOString().split('T')[0]}\n`;
  if (r.details) out += `  Details: ${typeof r.details === 'string' ? r.details : JSON.stringify(r.details)}\n`;
  return out;
}

function formatReportList(data) {
  const items = data.items || data;
  if (!items || (Array.isArray(items) && items.length === 0)) return 'No reports found.';
  let out = '';
  if (data.totalCount !== undefined) out += `Total: ${data.totalCount}\n\n`;
  if (Array.isArray(items)) {
    out += items.map(formatReport).join('\n');
  } else {
    out += JSON.stringify(data, null, 2);
  }
  return out;
}

function formatAppeal(a) {
  let out = `Appeal #${a.id}\n`;
  if (a.userId) out += `  User ID: ${a.userId}\n`;
  if (a.status) out += `  Status: ${a.status}\n`;
  if (a.entityType) out += `  Entity Type: ${a.entityType}\n`;
  if (a.entityId) out += `  Entity ID: ${a.entityId}\n`;
  if (a.appealMessage) out += `  Appeal Message: ${a.appealMessage}\n`;
  if (a.resolvedMessage) out += `  Resolved Message: ${a.resolvedMessage}\n`;
  if (a.createdAt) out += `  Created: ${new Date(a.createdAt).toISOString().split('T')[0]}\n`;
  return out;
}

function formatAppealList(data) {
  const items = Array.isArray(data) ? data : data.items || [];
  if (items.length === 0) return 'No appeals found.';
  return items.map(formatAppeal).join('\n');
}

async function main() {
  console.error(`Using API: ${API_URL}`);

  switch (command) {
    case 'list': {
      const type = flags['type'];
      if (!type) {
        console.error('Error: --type is required for list command');
        showUsage();
      }
      validateEntity(type);

      const input = {
        type,
        limit: intOrUndef(flags['limit']) ?? 20,
        page: intOrUndef(flags['page']) ?? 1,
      };
      if (flags['query']) input.query = flags['query'];

      const result = await trpcCall('report.getAll', input, 'GET');
      output(result, jsonMode, formatReportList);
      break;
    }

    case 'set-status': {
      const reportId = intOrUndef(target);
      const status = extra[0];
      if (!reportId || !status) {
        console.error('Error: reportId and status are required');
        console.error('Usage: node reports.mjs set-status <reportId> <status>');
        process.exit(1);
      }
      validateStatus(status, REPORT_STATUSES, 'ReportStatus');

      if (dryRun) {
        console.log(`[DRY RUN] Would set report #${reportId} status to: ${status}`);
        break;
      }

      const result = await trpcCall('report.setStatus', { id: reportId, status }, 'POST');
      output(result, jsonMode, () => `Report #${reportId} status set to: ${status}`);
      break;
    }

    case 'bulk-status': {
      const status = target;
      const ids = parseIds(flags['ids']);
      if (!status) {
        console.error('Error: status is required');
        console.error('Usage: node reports.mjs bulk-status <status> --ids 1,2,3');
        process.exit(1);
      }
      if (ids.length === 0) {
        console.error('Error: --ids is required (comma-separated report IDs)');
        process.exit(1);
      }
      validateStatus(status, REPORT_STATUSES, 'ReportStatus');

      if (dryRun) {
        console.log(`[DRY RUN] Would set status to ${status} for reports: ${ids.join(', ')}`);
        break;
      }

      const result = await trpcCall('report.bulkUpdateStatus', { ids, status }, 'POST');
      output(result, jsonMode, () => `Updated ${ids.length} report(s) to status: ${status}`);
      break;
    }

    case 'update': {
      const reportId = intOrUndef(target);
      if (!reportId) {
        console.error('Error: reportId is required');
        console.error('Usage: node reports.mjs update <reportId> --status <status> [--internal <notes>]');
        process.exit(1);
      }

      const input = { id: reportId };
      if (flags['status']) {
        validateStatus(flags['status'], REPORT_STATUSES, 'ReportStatus');
        input.status = flags['status'];
      }
      if (flags['internal']) {
        input.internalNotes = flags['internal'];
      }

      if (!input.status && !input.internalNotes) {
        console.error('Error: At least --status or --internal is required');
        process.exit(1);
      }

      if (dryRun) {
        let msg = `[DRY RUN] Would update report #${reportId}:`;
        if (input.status) msg += `\n  Status: ${input.status}`;
        if (input.internalNotes) msg += `\n  Internal Notes: ${input.internalNotes}`;
        console.log(msg);
        break;
      }

      const result = await trpcCall('report.update', input, 'POST');
      output(result, jsonMode, () => {
        let msg = `Report #${reportId} updated:`;
        if (input.status) msg += `\n  Status: ${input.status}`;
        if (input.internalNotes) msg += `\n  Internal Notes: ${input.internalNotes}`;
        return msg;
      });
      break;
    }

    case 'appeals': {
      const input = {};
      if (flags['user-id']) input.userId = intOrUndef(flags['user-id']);
      if (flags['start-date']) input.startDate = flags['start-date'];

      const result = await trpcCall('report.getRecentAppeals', input, 'GET');
      output(result, jsonMode, formatAppealList);
      break;
    }

    case 'appeal-details': {
      const id = intOrUndef(target);
      if (!id) {
        console.error('Error: appeal ID is required');
        console.error('Usage: node reports.mjs appeal-details <id>');
        process.exit(1);
      }

      const result = await trpcCall('report.getAppealDetails', { id }, 'GET');
      output(result, jsonMode, formatAppeal);
      break;
    }

    case 'resolve-appeal': {
      const ids = parseIds(flags['ids']);
      const entityType = flags['entity-type'];
      const status = flags['status'];

      if (ids.length === 0) {
        console.error('Error: --ids is required (comma-separated appeal IDs)');
        process.exit(1);
      }
      if (!entityType) {
        console.error('Error: --entity-type is required');
        process.exit(1);
      }
      if (!status) {
        console.error('Error: --status is required');
        process.exit(1);
      }
      validateStatus(status, APPEAL_STATUSES, 'AppealStatus');

      const input = { ids, entityType, status };
      if (flags['message']) input.resolvedMessage = flags['message'];
      if (flags['internal']) input.internalNotes = flags['internal'];

      if (dryRun) {
        let msg = `[DRY RUN] Would resolve ${ids.length} appeal(s):`;
        msg += `\n  IDs: ${ids.join(', ')}`;
        msg += `\n  Entity Type: ${entityType}`;
        msg += `\n  Status: ${status}`;
        if (input.resolvedMessage) msg += `\n  Message: ${input.resolvedMessage}`;
        if (input.internalNotes) msg += `\n  Internal Notes: ${input.internalNotes}`;
        console.log(msg);
        break;
      }

      const result = await trpcCall('report.resolveAppeal', input, 'POST');
      output(result, jsonMode, () => {
        let msg = `Resolved ${ids.length} appeal(s):`;
        msg += `\n  IDs: ${ids.join(', ')}`;
        msg += `\n  Status: ${status}`;
        return msg;
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

run(main);
