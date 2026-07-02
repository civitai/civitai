import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { getClickhouse } from './clickhouse';
import {
  getScanContents,
  snapshotScanContent,
  type ScanContent,
  type ScanContentBody,
  type ScanContentItem,
} from './scanner-content.service';
import type { QueueView, ReviewVerdict, Scanner } from '$lib/scanner-audit';

// Reads ClickHouse `scanner_label_results` (AggregatingMergeTree) + Postgres `ScannerLabelReview`
// (moderator verdicts) for the scanner-audit table. Dedup unit is (contentHash, version, label). Ported
// from the main app's scanner-review.service; read-only (verdict writes are the Wave-6 focused page).

const DEFAULT_LOOKBACK_DAYS = 30;
const ACTIVE_LABEL_WINDOW_DAYS = 7;

export type AggregatedScanRow = {
  contentHash: string;
  version: string;
  label: string;
  scanner: string;
  entityType: string;
  labelValue: string;
  modelVersion: string;
  score: number;
  threshold: number | null;
  triggered: 0 | 1;
  matchedText: string[];
  matchedPositivePrompt: string[];
  matchedNegativePrompt: string[];
  durationMs: number;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  workflowIds: string[];
  entityIds: string[];
};

export type QueueRow = AggregatedScanRow & {
  myVerdict: ReviewVerdict | null;
  anyVerdict: ReviewVerdict | null;
};

export type LabelReviewStat = {
  label: string;
  total: number;
  reviewers: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  unsure: number;
  lastReviewedAt: string | null;
};

const AGGREGATE_SELECT = `
  contentHash,
  version,
  label,
  any(scanner) AS scanner,
  any(entityType) AS entityType,
  any(labelValue) AS labelValue,
  any(modelVersion) AS modelVersion,
  anyLast(score) AS score,
  anyLast(threshold) AS threshold,
  max(triggered) AS triggered,
  anyLast(matchedText) AS matchedText,
  anyLast(matchedPositivePrompt) AS matchedPositivePrompt,
  anyLast(matchedNegativePrompt) AS matchedNegativePrompt,
  anyLast(durationMs) AS durationMs,
  min(firstSeenAt) AS firstSeenAt,
  max(lastSeenAt) AS lastSeenAt,
  sum(occurrences) AS occurrences,
  groupUniqArrayArray(workflowIds) AS workflowIds,
  groupUniqArrayArray(entityIds) AS entityIds
`;

export type ListScansInput = {
  scanner?: Scanner;
  view: QueueView;
  label?: string;
  version?: string;
  nearMissGap: number;
  lookbackDays?: number;
  limit: number;
  offset: number;
  latestVersionOnly: boolean;
};

export async function listScans(
  input: ListScansInput,
  userId: number
): Promise<{ rows: QueueRow[]; total: number }> {
  const ch = getClickhouse();
  const lookback = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  const conditions: string[] = [`lastSeenAt > now() - INTERVAL ${lookback} DAY`];
  const params: Record<string, unknown> = { limit: input.limit, offset: input.offset };

  if (input.scanner) {
    conditions.push('scanner = {scanner:String}');
    params.scanner = input.scanner;
  }
  if (input.label) {
    conditions.push('label = {label:String}');
    params.label = input.label;
  }
  if (input.version) {
    conditions.push('version = {version:String}');
    params.version = input.version;
  } else if (input.latestVersionOnly) {
    conditions.push(`
      (scanner, label, version) IN (
        SELECT scanner, label, argMax(version, lastSeenAt) AS version
        FROM scanner_label_results
        WHERE lastSeenAt > now() - INTERVAL ${lookback} DAY
        GROUP BY scanner, label
      )
    `);
  }

  const havingClause =
    input.view === 'triggered'
      ? 'max(triggered) = 1'
      : `max(triggered) = 0 AND anyLast(threshold) IS NOT NULL AND anyLast(threshold) - anyLast(score) <= {nearMissGap:Float32}`;
  if (input.view === 'near-miss') params.nearMissGap = input.nearMissGap;

  const orderBy = input.view === 'triggered' ? 'max(lastSeenAt) DESC' : 'anyLast(score) DESC';
  const where = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT ${AGGREGATE_SELECT}
    FROM scanner_label_results
    ${where}
    GROUP BY contentHash, version, label
    HAVING ${havingClause}
    ORDER BY ${orderBy}
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    SETTINGS prefer_column_name_to_alias = 1
  `;
  const countQuery = `
    SELECT count() AS total FROM (
      SELECT contentHash, version, label,
             max(triggered) AS triggered,
             anyLast(score) AS score,
             anyLast(threshold) AS threshold
      FROM scanner_label_results
      ${where}
      GROUP BY contentHash, version, label
      HAVING ${havingClause}
    )
    SETTINGS prefer_column_name_to_alias = 1
  `;

  const [dataResp, countResp] = await Promise.all([
    ch.query({ query: dataQuery, query_params: params, format: 'JSONEachRow' }),
    ch.query({ query: countQuery, query_params: params, format: 'JSONEachRow' }),
  ]);

  const rows = await dataResp.json<AggregatedScanRow[]>();
  const countRows = await countResp.json<Array<{ total: string }>>();
  const total = Number(countRows[0]?.total ?? 0);

  if (rows.length === 0) return { rows: [], total };

  // Enrich with Postgres review state.
  const keys = rows.map((r) => ({ contentHash: r.contentHash, version: r.version, label: r.label }));
  const verdicts = await dbRead
    .selectFrom('ScannerLabelReview')
    .select(['contentHash', 'version', 'label', 'reviewedBy', 'verdict'])
    .where((eb) =>
      eb.or(
        keys.map((k) =>
          eb.and([
            eb('contentHash', '=', k.contentHash),
            eb('version', '=', k.version),
            eb('label', '=', k.label),
          ])
        )
      )
    )
    .execute();

  const myMap = new Map<string, ReviewVerdict>();
  const anyMap = new Map<string, ReviewVerdict>();
  for (const v of verdicts) {
    const key = `${v.contentHash}::${v.version}::${v.label}`;
    if (v.reviewedBy === userId) myMap.set(key, v.verdict);
    if (!anyMap.has(key)) anyMap.set(key, v.verdict);
  }

  return {
    rows: rows.map((r) => {
      const key = `${r.contentHash}::${r.version}::${r.label}`;
      return { ...r, myVerdict: myMap.get(key) ?? null, anyVerdict: anyMap.get(key) ?? null };
    }),
    total,
  };
}

async function getActiveLabels(scanner: Scanner): Promise<Set<string>> {
  const resp = await getClickhouse().query({
    query: `
      SELECT DISTINCT label
      FROM scanner_label_results
      WHERE scanner = {scanner:String}
        AND lastSeenAt > now() - INTERVAL ${ACTIVE_LABEL_WINDOW_DAYS} DAY
    `,
    query_params: { scanner },
    format: 'JSONEachRow',
  });
  const rows = await resp.json<Array<{ label: string }>>();
  return new Set(rows.map((r) => r.label));
}

export async function getLabelReviewStats(input: {
  scanner: Scanner;
}): Promise<{ active: LabelReviewStat[]; retired: LabelReviewStat[] }> {
  const [rowsResult, activeLabels] = await Promise.all([
    sql<{
      label: string;
      total: number;
      reviewers: number;
      truePositive: number;
      falsePositive: number;
      trueNegative: number;
      falseNegative: number;
      unsure: number;
      lastReviewedAt: Date | null;
    }>`
      SELECT
        r."label" AS label,
        COUNT(*) AS total,
        COUNT(DISTINCT r."reviewedBy") AS reviewers,
        COUNT(*) FILTER (WHERE r."verdict" = 'TruePositive') AS "truePositive",
        COUNT(*) FILTER (WHERE r."verdict" = 'FalsePositive') AS "falsePositive",
        COUNT(*) FILTER (WHERE r."verdict" = 'TrueNegative') AS "trueNegative",
        COUNT(*) FILTER (WHERE r."verdict" = 'FalseNegative') AS "falseNegative",
        COUNT(*) FILTER (WHERE r."verdict" = 'Unsure') AS unsure,
        MAX(r."reviewedAt") AS "lastReviewedAt"
      FROM "ScannerLabelReview" r
      JOIN "ScannerContentSnapshot" s ON s."contentHash" = r."contentHash"
      WHERE s."scanner" = ${input.scanner}
      GROUP BY r."label"
      ORDER BY COUNT(*) DESC
    `.execute(dbRead),
    getActiveLabels(input.scanner),
  ]);

  const stats: LabelReviewStat[] = rowsResult.rows.map((r) => ({
    label: r.label,
    total: Number(r.total),
    reviewers: Number(r.reviewers),
    truePositive: Number(r.truePositive),
    falsePositive: Number(r.falsePositive),
    trueNegative: Number(r.trueNegative),
    falseNegative: Number(r.falseNegative),
    unsure: Number(r.unsure),
    lastReviewedAt: r.lastReviewedAt ? new Date(r.lastReviewedAt).toISOString() : null,
  }));

  if (activeLabels.size === 0) return { active: stats, retired: [] };

  const active: LabelReviewStat[] = [];
  const retired: LabelReviewStat[] = [];
  for (const s of stats) (activeLabels.has(s.label) ? active : retired).push(s);
  return { active, retired };
}

// --- Focused review (one scanner+label) ---

export async function focusedRun(input: {
  scanner: Scanner;
  label: string;
  lookbackDays?: number;
  limit: number;
  nearMissGap: number;
  userId: number;
  latestVersionOnly: boolean;
}): Promise<{
  items: AggregatedScanRow[];
  totalAvailable: number;
  verdictedInLookback: number;
  lookbackDays: number;
}> {
  const ch = getClickhouse();
  const lookback = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  // Over-fetch so heavy reviewers still get a full page after their prior verdicts are filtered out.
  const chLimit = Math.min(input.limit * 5, 300);

  const havingClause = `
    max(triggered) = 1
    OR (anyLast(threshold) IS NOT NULL AND anyLast(threshold) - anyLast(score) <= {nearMissGap:Float32})
  `;
  const versionFilter = input.latestVersionOnly
    ? `AND version = (
         SELECT argMax(version, lastSeenAt)
         FROM scanner_label_results
         WHERE scanner = {scanner:String}
           AND label = {label:String}
           AND lastSeenAt > now() - INTERVAL ${lookback} DAY
       )`
    : '';

  const resp = await ch.query({
    query: `
      SELECT ${AGGREGATE_SELECT}
      FROM scanner_label_results
      WHERE scanner = {scanner:String}
        AND label = {label:String}
        AND lastSeenAt > now() - INTERVAL ${lookback} DAY
        ${versionFilter}
      GROUP BY contentHash, version, label
      HAVING ${havingClause}
      ORDER BY max(lastSeenAt) DESC
      LIMIT {limit:UInt32}
      SETTINGS prefer_column_name_to_alias = 1
    `,
    query_params: {
      scanner: input.scanner,
      label: input.label,
      limit: chLimit,
      nearMissGap: input.nearMissGap,
    },
    format: 'JSONEachRow',
  });
  const allRows = await resp.json<AggregatedScanRow[]>();

  const lookbackCutoff = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000);
  const verdictedInLookbackRow = await dbRead
    .selectFrom('ScannerLabelReview')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('reviewedBy', '=', input.userId)
    .where('label', '=', input.label)
    .where('reviewedAt', '>', lookbackCutoff)
    .executeTakeFirst();
  const verdictedInLookback = Number(verdictedInLookbackRow?.count ?? 0);

  if (allRows.length === 0)
    return { items: [], totalAvailable: 0, verdictedInLookback, lookbackDays: lookback };

  const verdicted = await dbRead
    .selectFrom('ScannerLabelReview')
    .select(['contentHash', 'version'])
    .where('reviewedBy', '=', input.userId)
    .where('label', '=', input.label)
    .where(
      'contentHash',
      'in',
      allRows.map((r) => r.contentHash)
    )
    .execute();
  const verdictedSet = new Set(verdicted.map((v) => `${v.contentHash}::${v.version}`));
  const items = allRows
    .filter((r) => !verdictedSet.has(`${r.contentHash}::${r.version}`))
    .slice(0, input.limit);

  return { items, totalAvailable: allRows.length, verdictedInLookback, lookbackDays: lookback };
}

export async function focusedItemContent(item: ScanContentItem): Promise<ScanContent> {
  const [content] = await getScanContents([item]);
  return content ?? { contentHash: item.contentHash, scanner: item.scanner, unavailable: true };
}

export async function upsertLabelVerdict(input: {
  contentHash: string;
  version: string;
  label: string;
  verdict: ReviewVerdict;
  note?: string;
  userId: number;
  contentSnapshot?: { scanner: string; body: ScanContentBody };
}): Promise<void> {
  // Snapshot content first so the verdict can't leave content dangling. Idempotent (first writer wins).
  if (input.contentSnapshot) {
    await snapshotScanContent({
      contentHash: input.contentHash,
      scanner: input.contentSnapshot.scanner,
      body: input.contentSnapshot.body,
    });
  }

  await dbWrite
    .insertInto('ScannerLabelReview')
    .values({
      contentHash: input.contentHash,
      version: input.version,
      label: input.label,
      reviewedBy: input.userId,
      verdict: input.verdict,
      note: input.note ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['contentHash', 'version', 'label', 'reviewedBy']).doUpdateSet({
        verdict: input.verdict,
        note: input.note ?? null,
        reviewedAt: new Date(),
      })
    )
    .execute();
}
