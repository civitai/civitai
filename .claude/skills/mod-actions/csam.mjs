#!/usr/bin/env node

/**
 * CSAM/NCMEC Reporting - Critical compliance functionality
 *
 * SAFETY: The create-report command requires --confirm to actually submit.
 * This ensures NCMEC reports are NEVER submitted without explicit human approval.
 * Automated agents must use --dry-run to preview, then a human must re-run with --confirm.
 *
 * Commands:
 *   reports                          List CSAM reports (paginated)
 *   stats                            Show CSAM report statistics
 *   image-resources <imageIds>       Show resources for flagged images
 *   create-report <userId>           Create a CSAM report (requires --confirm)
 *
 * Options:
 *   --json                           Output raw JSON
 *   --dry-run                        Preview without submitting
 *   --confirm                        Required to actually submit a report
 *   --type <CsamReportType>          Report type (Image, TrainingData, GeneratedImage)
 *   --image-ids <id1,id2,...>        Comma-separated image IDs
 *   --minor-depiction <real|non-real> Minor depiction type
 *   --page <n>                       Page number (default: 1)
 *   --limit <n>                      Page size (default: 20)
 */

import {
  requireApiKey, trpcCall, parseArgs, output, parseIds, intOrUndef, run, API_URL,
} from './lib.mjs';

requireApiKey();

const CSAM_REPORT_TYPES = ['Image', 'TrainingData', 'GeneratedImage'];
const MINOR_DEPICTION_VALUES = ['real', 'non-real'];

const { command, target, flags } = parseArgs(process.argv);

function showUsage() {
  console.error(`Usage: node csam.mjs <command> [options]

Commands:
  reports                          List CSAM reports (paginated)
  stats                            Show CSAM report statistics
  image-resources <imageIds>       Show resources used to generate flagged images
  create-report <userId>           Create a CSAM/NCMEC report for a user

SAFETY: create-report requires --confirm to actually submit a report to NCMEC.
        Without --confirm, it behaves like --dry-run. This prevents accidental
        or automated submissions. A human must explicitly approve every report.

Options:
  --json                           Output raw JSON
  --dry-run                        Preview report without submitting
  --confirm                        Required to actually submit (create-report only)
  --type <CsamReportType>          Report type: ${CSAM_REPORT_TYPES.join(', ')}
  --image-ids <id1,id2,...>        Comma-separated image IDs to include
  --minor-depiction <real|non-real> Minor depiction classification
  --page <n>                       Page number (default: 1)
  --limit <n>                      Page size (default: 20)

Examples:
  node csam.mjs reports
  node csam.mjs reports --page 2 --limit 50
  node csam.mjs stats
  node csam.mjs image-resources 123,456,789
  node csam.mjs create-report 12345 --type Image --dry-run
  node csam.mjs create-report 12345 --type GeneratedImage --image-ids 100,200 --confirm
  node csam.mjs create-report 12345 --type TrainingData --confirm --json

Configuration:
  Set CIVITAI_API_KEY and CIVITAI_API_URL in .claude/skills/mod-actions/.env
  See .env-example for details.`);
  process.exit(1);
}

if (!command) showUsage();

// --- Formatters ---

function formatReport(report) {
  const lines = [
    `Report #${report.id}`,
    `  User ID:    ${report.userId}`,
    `  Type:       ${report.type ?? 'N/A'}`,
    `  Status:     ${report.status ?? 'N/A'}`,
  ];
  if (report.createdAt) lines.push(`  Created:    ${new Date(report.createdAt).toISOString()}`);
  if (report.completedAt) lines.push(`  Completed:  ${new Date(report.completedAt).toISOString()}`);
  if (report.reportSentAt) lines.push(`  Reported:   ${new Date(report.reportSentAt).toISOString()}`);
  if (report.archivedAt) lines.push(`  Archived:   ${new Date(report.archivedAt).toISOString()}`);
  return lines.join('\n');
}

function formatReports(data) {
  const items = data.items ?? data;
  if (!items || items.length === 0) return 'No CSAM reports found.';

  const lines = [];
  if (data.totalItems !== undefined) {
    lines.push(`CSAM Reports (page ${data.currentPage ?? '?'} of ${Math.ceil(data.totalItems / (data.limit || 20))}, ${data.totalItems} total)`);
    lines.push('');
  }
  for (const report of items) {
    lines.push(formatReport(report));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatStats(data) {
  if (!data || typeof data !== 'object') return 'No statistics available.';

  const lines = ['CSAM Report Statistics', ''];

  // Handle various shapes the stats response might have
  if (data.byType) {
    lines.push('By Type:');
    for (const [type, count] of Object.entries(data.byType)) {
      lines.push(`  ${type}: ${count}`);
    }
    lines.push('');
  }

  if (data.byStatus) {
    lines.push('By Status:');
    for (const [status, count] of Object.entries(data.byStatus)) {
      lines.push(`  ${status}: ${count}`);
    }
    lines.push('');
  }

  // If it's a flat object with counts, display them directly
  if (!data.byType && !data.byStatus) {
    for (const [key, value] of Object.entries(data)) {
      lines.push(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
    lines.push('');
  }

  if (data.total !== undefined) {
    lines.push(`Total: ${data.total}`);
  }

  return lines.join('\n').trimEnd();
}

function formatImageResources(data) {
  const items = Array.isArray(data) ? data : data.items ?? [];
  if (items.length === 0) return 'No image resources found.';

  const lines = ['Image Resources', ''];
  for (const item of items) {
    const imageId = item.imageId ?? item.id;
    lines.push(`Image #${imageId}:`);
    const resources = item.resources ?? item.modelVersions ?? [];
    if (resources.length === 0) {
      lines.push('  No resources found');
    } else {
      for (const res of resources) {
        const name = res.modelName ?? res.name ?? 'Unknown';
        const version = res.modelVersionName ?? res.versionName ?? '';
        const type = res.modelType ?? res.type ?? '';
        lines.push(`  - ${name}${version ? ` (${version})` : ''}${type ? ` [${type}]` : ''}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatCreateResult(data, options) {
  const lines = [
    'CSAM Report Created',
    `  Report ID:  ${data.id ?? 'N/A'}`,
    `  User ID:    ${options.userId}`,
    `  Type:       ${options.type}`,
  ];
  if (options.imageIds?.length) {
    lines.push(`  Image IDs:  ${options.imageIds.join(', ')}`);
  }
  if (options.minorDepiction) {
    lines.push(`  Depiction:  ${options.minorDepiction}`);
  }
  lines.push(`  Status:     ${data.status ?? 'Submitted'}`);
  return lines.join('\n');
}

// --- Main ---

async function main() {
  console.error(`Using API: ${API_URL}`);

  const jsonMode = flags.json;

  switch (command) {
    case 'reports': {
      const input = {
        limit: intOrUndef(flags.limit) ?? 20,
        page: intOrUndef(flags.page) ?? 1,
      };
      const data = await trpcCall('csam.getCsamReports', input, 'GET');
      output(data, jsonMode, formatReports);
      break;
    }

    case 'stats': {
      const data = await trpcCall('csam.getCsamReportsStats', undefined, 'GET');
      output(data, jsonMode, formatStats);
      break;
    }

    case 'image-resources': {
      if (!target) {
        console.error('Error: Image IDs required (comma-separated)');
        console.error('Usage: node csam.mjs image-resources <id1,id2,...>');
        process.exit(1);
      }
      const ids = parseIds(target);
      if (ids.length === 0) {
        console.error('Error: No valid image IDs provided');
        process.exit(1);
      }
      const data = await trpcCall('csam.getImageResources', { ids }, 'GET');
      output(data, jsonMode, formatImageResources);
      break;
    }

    case 'create-report': {
      if (!target) {
        console.error('Error: User ID required');
        console.error('Usage: node csam.mjs create-report <userId> --type <type> [options]');
        process.exit(1);
      }

      const userId = parseInt(target);
      if (isNaN(userId)) {
        console.error('Error: User ID must be a number');
        process.exit(1);
      }

      const type = flags.type;
      if (!type) {
        console.error('Error: --type is required');
        console.error(`Valid types: ${CSAM_REPORT_TYPES.join(', ')}`);
        process.exit(1);
      }
      if (!CSAM_REPORT_TYPES.includes(type)) {
        console.error(`Error: Invalid report type "${type}"`);
        console.error(`Valid types: ${CSAM_REPORT_TYPES.join(', ')}`);
        process.exit(1);
      }

      const imageIds = parseIds(flags['image-ids']);
      const minorDepiction = flags['minor-depiction'];

      if (minorDepiction && !MINOR_DEPICTION_VALUES.includes(minorDepiction)) {
        console.error(`Error: Invalid minor depiction value "${minorDepiction}"`);
        console.error(`Valid values: ${MINOR_DEPICTION_VALUES.join(', ')}`);
        process.exit(1);
      }

      const input = { userId, type };
      if (imageIds.length > 0) input.imageIds = imageIds;
      if (minorDepiction) input.details = { minorDepiction };

      // SAFETY: Always show preview first. Only submit if --confirm is explicitly passed.
      // This ensures NCMEC reports are NEVER submitted without explicit human approval.
      const preview = [
        `${flags.confirm ? '' : '[PREVIEW] '}CSAM Report:`,
        `  User ID:          ${userId}`,
        `  Type:             ${type}`,
      ];
      if (imageIds.length > 0) {
        preview.push(`  Image IDs:        ${imageIds.join(', ')}`);
      }
      if (minorDepiction) {
        preview.push(`  Minor Depiction:  ${minorDepiction}`);
      }

      if (!flags.confirm) {
        preview.push('');
        preview.push('  *** REPORT NOT SUBMITTED ***');
        preview.push('  NCMEC reports require explicit human approval.');
        preview.push('  To submit, re-run with --confirm flag.');

        if (jsonMode) {
          console.log(JSON.stringify({ submitted: false, requiresConfirm: true, input }, null, 2));
        } else {
          console.log(preview.join('\n'));
        }
        process.exit(0);
        break;
      }

      // --confirm was passed — submit the report
      console.error('Submitting NCMEC report (--confirm flag present)...');
      const data = await trpcCall('csam.createReport', input, 'POST');
      output(data, jsonMode, (d) => formatCreateResult(d, { userId, type, imageIds, minorDepiction }));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showUsage();
  }
}

run(main);
