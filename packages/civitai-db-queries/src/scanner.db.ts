import { sql, type Kysely } from 'kysely';
import type { Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { toJson } from './infra/helpers';

// `ScannerLabelReview.verdict` enum, derived from the schema so this module needs no separate enum import.
type ReviewVerdictValue = Selectable<DB['ScannerLabelReview']>['verdict'];

// --- Label review stats (PG part of getLabelReviewStats) ---

export type ScannerLabelReviewStatRow = {
  label: string;
  total: number;
  reviewers: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  unsure: number;
  lastReviewedAt: Date | null;
};

// Per-label verdict tallies for one scanner: join each review to its content snapshot (which carries the
// scanner), then COUNT FILTER by verdict. Raw SQL to preserve the FILTER clauses and verdict literals
// exactly. The caller splits the returned labels into active/retired using a ClickHouse lookup (dropped here).
export async function getScannerLabelReviewStats(
  db: Kysely<DB>,
  input: {
    scanner: string;
  }
): Promise<ScannerLabelReviewStatRow[]> {
  const result = await sql<ScannerLabelReviewStatRow>`
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
  `.execute(db);

  return result.rows;
}

// --- Verdict enrichment (PG part of listScans) ---

export type ScannerLabelReviewKey = { contentHash: string; version: string; label: string };

export type ScannerLabelReviewVerdictRow = {
  contentHash: string;
  version: string;
  label: string;
  reviewedBy: number;
  verdict: ReviewVerdictValue;
};

// Existing verdicts for a set of (contentHash, version, label) keys — used to overlay my/any verdict onto a
// ClickHouse-sourced scan page. Guards the empty-key case (no `OR ()`).
export async function getScannerLabelReviewVerdicts(
  db: Kysely<DB>,
  keys: ScannerLabelReviewKey[]
): Promise<ScannerLabelReviewVerdictRow[]> {
  if (!keys.length) return [];
  return db
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
}

// --- Focused review (PG parts of focusedRun) ---

// How many verdicts a reviewer has recorded for one label since the lookback cutoff (progress counter).
export async function countScannerLabelReviewsByUser(
  db: Kysely<DB>,
  input: {
    userId: number;
    label: string;
    since: Date;
  }
): Promise<number> {
  const row = await db
    .selectFrom('ScannerLabelReview')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('reviewedBy', '=', input.userId)
    .where('label', '=', input.label)
    .where('reviewedAt', '>', input.since)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

// The (contentHash, version) keys a reviewer has already verdicted for one label, restricted to a candidate
// set of content hashes — used to filter already-reviewed items out of a focused page. Guards the empty set.
export async function getScannerLabelReviewsByUser(
  db: Kysely<DB>,
  input: {
    userId: number;
    label: string;
    contentHashes: string[];
  }
): Promise<{ contentHash: string; version: string }[]> {
  if (!input.contentHashes.length) return [];
  return db
    .selectFrom('ScannerLabelReview')
    .select(['contentHash', 'version'])
    .where('reviewedBy', '=', input.userId)
    .where('label', '=', input.label)
    .where('contentHash', 'in', input.contentHashes)
    .execute();
}

// --- Verdict write (PG part of upsertLabelVerdict) ---

// Record (or overwrite) one reviewer's verdict for a (contentHash, version, label). On conflict it re-stamps
// verdict/note/reviewedAt. The content-snapshot precondition (insertScannerContentSnapshot) is a separate
// call; the ClickHouse-facing orchestration stays with the caller.
export function upsertScannerLabelVerdict(
  db: Kysely<DB>,
  input: {
    contentHash: string;
    version: string;
    label: string;
    verdict: ReviewVerdictValue;
    note?: string;
    userId: number;
  }
) {
  return db
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

// --- Content snapshot write (snapshotScanContent) ---

export type ScanContentBody = {
  text?: string;
  positivePrompt?: string;
  negativePrompt?: string;
  instructions?: string;
  imageId?: number;
  labelReasons?: Record<string, string>;
  userId?: number;
};

// Persist the reviewed content for a contentHash so a verdict can't leave content dangling once the
// orchestrator's ~30-day copy expires. First writer wins (onConflict doNothing). Nulls and empty arrays are
// stripped before the jsonb write.
export function insertScannerContentSnapshot(
  db: Kysely<DB>,
  input: {
    contentHash: string;
    scanner: string;
    body: ScanContentBody;
  }
) {
  const compact: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.body)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    compact[k] = v;
  }

  return db
    .insertInto('ScannerContentSnapshot')
    .values({
      contentHash: input.contentHash,
      scanner: input.scanner,
      content: toJson(compact),
    })
    .onConflict((oc) => oc.column('contentHash').doNothing())
    .execute();
}

// --- Content snapshot reads (PG parts of getScanContents) ---

export type ScannerContentSnapshotRow = {
  contentHash: string;
  scanner: string;
  content: unknown;
};

// Stored snapshots for a batch of content hashes — the first resolution source for scan content (the
// orchestrator fallback is dropped). Guards the empty batch.
export async function getScannerContentSnapshots(
  db: Kysely<DB>,
  contentHashes: string[]
): Promise<ScannerContentSnapshotRow[]> {
  if (!contentHashes.length) return [];
  return db
    .selectFrom('ScannerContentSnapshot')
    .select(['contentHash', 'scanner', 'content'])
    .where('contentHash', 'in', contentHashes)
    .execute();
}

// Resolve image URLs for image-backed scan content in one round trip. Guards the empty batch.
export async function getScannerContentImages(
  db: Kysely<DB>,
  imageIds: number[]
): Promise<{ id: number; url: string }[]> {
  if (!imageIds.length) return [];
  return db.selectFrom('Image').select(['id', 'url']).where('id', 'in', imageIds).execute();
}
