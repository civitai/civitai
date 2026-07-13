import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listScans, type QueueRow } from '$lib/server/scanner-review.service';
import { isValidMode, modeToScanner } from '$lib/scanner-audit';

const EXPORT_LIMIT = 10000;

export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!isValidMode(params.mode)) error(404, 'Unknown scanner mode');
  const scanner = modeToScanner(params.mode);
  const view = url.searchParams.get('view') === 'near-miss' ? 'near-miss' : 'triggered';
  const label = url.searchParams.get('label')?.trim() || undefined;
  const version = url.searchParams.get('version')?.trim() || undefined;

  const { rows } = await listScans(
    { scanner, view, label, version, nearMissGap: 0.05, limit: EXPORT_LIMIT, offset: 0, latestVersionOnly: true },
    locals.user.id
  );

  return new Response(toCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="scanner-audit-${params.mode}-${view}.csv"`,
    },
  });
};

const HEADERS = [
  'contentHash', 'version', 'label', 'scanner', 'entityType', 'labelValue', 'modelVersion',
  'score', 'threshold', 'triggered', 'occurrences', 'firstSeenAt', 'lastSeenAt', 'durationMs',
  'workflowIds', 'entityIds', 'matchedText', 'matchedPositivePrompt', 'matchedNegativePrompt',
  'myVerdict', 'anyVerdict',
] as const;

function toCsv(rows: QueueRow[]): string {
  if (rows.length === 0) return HEADERS.join(',');
  const lines = [HEADERS.join(',')];
  for (const r of rows) {
    const cells: (string | number | null)[] = [
      r.contentHash, r.version, r.label, r.scanner, r.entityType, r.labelValue, r.modelVersion,
      r.score, r.threshold, r.triggered, r.occurrences, r.firstSeenAt, r.lastSeenAt, r.durationMs,
      r.workflowIds.join('|'), r.entityIds.join('|'), r.matchedText.join('|'),
      r.matchedPositivePrompt.join('|'), r.matchedNegativePrompt.join('|'),
      r.myVerdict ?? '', r.anyVerdict ?? '',
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\n');
}

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
