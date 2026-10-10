import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from './moderator-db/types';

/**
 * Copies a stratified sample of Clavata "Automated" report hits into the moderator database before
 * `clear-automated-reports` deletes their text at 14 days. The unit is a (report, tag) pair.
 *
 * 🔴 Flagged text moves replica -> moderator DB in this process only. The summary is counts. A thrown
 * driver error CAN quote the row: print errors only through `describeSnapshotError`.
 */

export type ConfidenceBand = 'low' | 'mid' | 'high';
export type Visibility = 'public' | 'private';

export type SnapshotCandidate = {
  reportId: number;
  tag: string;
  confidence: number;
  flaggedAt: Date;
  authorId: number | null;
  entityType: string;
  entityId: number | null;
};

export type SnapshotPick = SnapshotCandidate & {
  wave: 1 | 2;
  band: ConfidenceBand;
  visibility: Visibility;
  stratumKey: string;
  cellPopulation: number;
};

/** Pairs kept in the pool per tag. `Infinity` keeps every pair the window holds. */
export const POOL_QUOTAS: Readonly<Record<string, number>> = {
  CSAM: Infinity,
  Grooming: 400,
  'Sex Trafficking': 250,
  Exploitation: 250,
  'Illegal Trade': 250,
  NSFW: 250,
  'Impersonating Civitai Staff': Infinity,
};

/** The first-labelled wave, weighted toward the tags where a miss costs most. `Infinity` takes the
 *  tag's whole pool. */
export const WAVE_ONE_QUOTAS: Readonly<Record<string, number>> = {
  CSAM: 50,
  Grooming: 50,
  'Sex Trafficking': 30,
  Exploitation: 25,
  'Illegal Trade': 25,
  NSFW: 20,
  'Impersonating Civitai Staff': Infinity,
};

export const DEFAULT_PURGE_DAYS = 90;

export const confidenceBand = (confidence: number): ConfidenceBand =>
  confidence >= 95 ? 'high' : confidence >= 80 ? 'mid' : 'low';

export const visibilityOf = (entityType: string): Visibility =>
  entityType === 'chat' ? 'private' : 'public';

const orderKey = (seed: string, c: SnapshotCandidate) =>
  createHash('sha256').update(`${seed}|${c.reportId}|${c.tag}`).digest('hex');

/**
 * Splits `quota` across cells as evenly as their sizes allow, handing a full cell's unused share to
 * the others. Equal rather than proportional, so a small stratum (low confidence, chat) still gets
 * enough pairs to say something; the recorded cell population re-weights it afterwards.
 */
export function waterFill(sizes: readonly number[], quota: number): number[] {
  const take = sizes.map(() => 0);
  let remaining = Math.min(
    quota,
    sizes.reduce((a, b) => a + b, 0)
  );
  while (remaining > 0) {
    const open = sizes.map((size, i) => i).filter((i) => take[i] < sizes[i]);
    const share = Math.max(1, Math.floor(remaining / open.length));
    for (const i of open) {
      if (remaining === 0) break;
      const n = Math.min(share, sizes[i] - take[i], remaining);
      take[i] += n;
      remaining -= n;
    }
  }
  return take;
}

export type Allocation = {
  picks: SnapshotPick[];
  /** Pairs whose tag has no quota: a label Clavata added after this was written. */
  unknownTags: Record<string, number>;
};

export function allocate(candidates: readonly SnapshotCandidate[], seed: string): Allocation {
  const unknownTags: Record<string, number> = {};
  const byTag = new Map<string, SnapshotCandidate[]>();
  for (const c of candidates) {
    if (!(c.tag in POOL_QUOTAS)) {
      unknownTags[c.tag] = (unknownTags[c.tag] ?? 0) + 1;
      continue;
    }
    const list = byTag.get(c.tag) ?? [];
    list.push(c);
    byTag.set(c.tag, list);
  }

  const picks: SnapshotPick[] = [];
  for (const [tag, list] of byTag) {
    const cells = new Map<string, { key: string; order: string; c: SnapshotCandidate }[]>();
    for (const c of list) {
      const cellKey = `${confidenceBand(c.confidence)}|${visibilityOf(c.entityType)}`;
      const cell = cells.get(cellKey) ?? [];
      cell.push({ key: cellKey, order: orderKey(seed, c), c });
      cells.set(cellKey, cell);
    }
    const keys = [...cells.keys()].sort();
    const ordered = keys.map((k) =>
      (cells.get(k) ?? []).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    );
    const poolTake = waterFill(
      ordered.map((cell) => cell.length),
      POOL_QUOTAS[tag]
    );
    const waveTake = waterFill(poolTake, WAVE_ONE_QUOTAS[tag] ?? 0);
    ordered.forEach((cell, i) => {
      for (let j = 0; j < poolTake[i]; j++) {
        const c = cell[j].c;
        picks.push({
          ...c,
          wave: j < waveTake[i] ? 1 : 2,
          band: confidenceBand(c.confidence),
          visibility: visibilityOf(c.entityType),
          stratumKey: `${tag}|${keys[i]}`,
          cellPopulation: cell.length,
        });
      }
    });
  }
  return { picks, unknownTags };
}

// [report table, fk, ReportEntity] for every report type. Not read from REPORT_ENTITIES: it imports
// through $lib, which tsx cannot resolve. A test holds the two equal; a type missing here arrives as
// 'unknown' and loses its report link.
export const ENTITY_JOINS = [
  ['ImageReport', 'imageId', 'image'],
  ['ModelReport', 'modelId', 'model'],
  ['PostReport', 'postId', 'post'],
  ['ArticleReport', 'articleId', 'article'],
  ['CommentReport', 'commentId', 'comment'],
  ['CommentV2Report', 'commentV2Id', 'commentV2'],
  ['BountyReport', 'bountyId', 'bounty'],
  ['BountyEntryReport', 'bountyEntryId', 'bountyEntry'],
  ['CollectionReport', 'collectionId', 'collection'],
  ['ResourceReviewReport', 'resourceReviewId', 'resourceReview'],
  ['ComicProjectReport', 'comicProjectId', 'comicProject'],
  ['Model3DReport', 'model3dId', 'model3d'],
  ['Model3DReviewReport', 'model3dReviewId', 'model3dReview'],
  ['AnnouncementReport', 'announcementId', 'announcement'],
  ['CrucibleReport', 'crucibleId', 'crucible'],
  ['ChallengeReport', 'challengeId', 'challenge'],
  ['GameFrameGameReport', 'gameFrameGameId', 'gameFrameGame'],
  ['ChatReport', 'chatId', 'chat'],
  ['UserReport', 'userId', 'reportedUser'],
] as const;

type CandidateRow = {
  reportId: number;
  tag: string;
  confidence: string | null;
  flaggedAt: Date;
  authorId: number | null;
  entityType: string;
  entityId: number | null;
};

/** Every (report, tag) pair still holding evidence. Reads no text. */
export async function fetchCandidates(
  replica: Kysely<MainDB>
): Promise<{ candidates: SnapshotCandidate[]; noConfidence: number }> {
  const joins = sql.join(
    ENTITY_JOINS.map(
      ([table], i) =>
        sql`LEFT JOIN ${sql.table(table)} ${sql.raw(`e${i}`)} ON ${sql.ref(
          `e${i}.reportId`
        )} = ra."reportId"`
    ),
    sql` `
  );
  const entityType = sql.join(
    ENTITY_JOINS.map(
      ([, col, type], i) => sql`WHEN ${sql.ref(`e${i}.${col}`)} IS NOT NULL THEN ${sql.lit(type)}`
    ),
    sql` `
  );
  const entityId = sql.join(
    ENTITY_JOINS.map(([, col], i) => sql.ref(`e${i}.${col}`)),
    sql`, `
  );

  const { rows } = await sql<CandidateRow>`
    SELECT ra."reportId" AS "reportId",
           t->>'tag' AS tag,
           max(CASE WHEN t->>'confidence' ~ '^[0-9]{1,3}([.][0-9]+)?$' THEN (t->>'confidence')::numeric END) AS confidence,
           min(ra."createdAt") AS "flaggedAt",
           min(CASE WHEN r.details->>'userId' ~ '^[0-9]{1,9}$' THEN (r.details->>'userId')::int END) AS "authorId",
           min(CASE ${entityType} ELSE 'unknown' END) AS "entityType",
           min(COALESCE(${entityId})) AS "entityId"
    FROM "ReportAutomated" ra
    JOIN "Report" r ON r.id = ra."reportId"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ra.metadata->'tags') = 'array' THEN ra.metadata->'tags' ELSE '[]'::jsonb END
    ) t
    ${joins}
    WHERE jsonb_typeof(t) = 'object' AND t->>'tag' IS NOT NULL
    GROUP BY ra."reportId", t->>'tag'
  `.execute(replica);

  let noConfidence = 0;
  const candidates: SnapshotCandidate[] = [];
  for (const row of rows) {
    if (row.confidence === null) {
      noConfidence++;
      continue;
    }
    candidates.push({
      reportId: Number(row.reportId),
      tag: row.tag,
      confidence: Number(row.confidence),
      flaggedAt: new Date(row.flaggedAt),
      authorId: row.authorId === null ? null : Number(row.authorId),
      entityType: row.entityType,
      entityId: row.entityId === null ? null : Number(row.entityId),
    });
  }
  return { candidates, noConfidence };
}

const INSERT_CHUNK = 500;

export type SnapshotSummary = {
  batch: string;
  dryRun: boolean;
  windowPairs: number;
  noConfidence: number;
  unknownTags: Record<string, number>;
  perTag: Record<string, { window: number; pool: number; waveOne: number }>;
  perStratum: Record<string, { population: number; pool: number; waveOne: number }>;
  /** Picked, but retention deleted its ReportAutomated row before the text was read. */
  textMissing: number;
  inserted: number;
  alreadyPresent: number;
};

export type SnapshotOptions = {
  batch: string;
  seed: string;
  dryRun: boolean;
  purgeDays?: number;
  now?: Date;
};

export async function snapshotAutomatedText(
  opts: SnapshotOptions,
  deps: { replica: Kysely<MainDB>; moderator: Kysely<ModeratorDB> }
): Promise<SnapshotSummary> {
  const { candidates, noConfidence } = await fetchCandidates(deps.replica);
  const { picks, unknownTags } = allocate(candidates, opts.seed);

  const perTag: SnapshotSummary['perTag'] = {};
  for (const c of candidates) {
    if (!(c.tag in POOL_QUOTAS)) continue;
    perTag[c.tag] ??= { window: 0, pool: 0, waveOne: 0 };
    perTag[c.tag].window++;
  }
  const perStratum: SnapshotSummary['perStratum'] = {};
  for (const p of picks) {
    perTag[p.tag].pool++;
    if (p.wave === 1) perTag[p.tag].waveOne++;
    perStratum[p.stratumKey] ??= { population: p.cellPopulation, pool: 0, waveOne: 0 };
    perStratum[p.stratumKey].pool++;
    if (p.wave === 1) perStratum[p.stratumKey].waveOne++;
  }

  const summary: SnapshotSummary = {
    batch: opts.batch,
    dryRun: opts.dryRun,
    windowPairs: candidates.length + noConfidence,
    noConfidence,
    unknownTags,
    perTag,
    perStratum,
    textMissing: 0,
    inserted: 0,
    alreadyPresent: 0,
  };
  if (opts.dryRun || !picks.length) return summary;

  const now = opts.now ?? new Date();
  const purgeAfter = new Date(
    now.getTime() + (opts.purgeDays ?? DEFAULT_PURGE_DAYS) * 24 * 60 * 60 * 1000
  );

  for (let i = 0; i < picks.length; i += INSERT_CHUNK) {
    const chunk = picks.slice(i, i + INSERT_CHUNK);
    const reportIds = [...new Set(chunk.map((p) => p.reportId))];
    const texts = await deps.replica
      .selectFrom('ReportAutomated')
      .select(['reportId', sql<string | null>`metadata->>'value'`.as('value')])
      .where('reportId', 'in', reportIds)
      .execute();
    const textByReport = new Map(texts.map((t) => [Number(t.reportId), t.value]));

    const values = [];
    for (const p of chunk) {
      const text = textByReport.get(p.reportId);
      if (!text) {
        summary.textMissing++;
        continue;
      }
      values.push({
        batch: opts.batch,
        report_id: p.reportId,
        tag: p.tag,
        wave: p.wave,
        entity_type: p.entityType,
        entity_id: p.entityId,
        author_id: p.authorId,
        visibility: p.visibility,
        confidence: Math.round(p.confidence),
        confidence_band: p.band,
        stratum_key: p.stratumKey,
        cell_population: p.cellPopulation,
        text_value: text,
        flagged_at: p.flaggedAt,
        purge_after: purgeAfter,
      });
    }
    if (!values.length) continue;
    // A re-run keeps the first snapshot of a pair: its labels were given against that text and wave.
    const result = await deps.moderator
      .insertInto('text_relabel_item')
      .values(values)
      .onConflict((oc) => oc.columns(['report_id', 'tag']).doNothing())
      .executeTakeFirst();
    const inserted = Number(result.numInsertedOrUpdatedRows ?? 0);
    summary.inserted += inserted;
    summary.alreadyPresent += values.length - inserted;
  }
  return summary;
}

/** Nulls the text only; rows and answers must survive so the counts do. */
export async function purgeExpiredText(moderator: Kysely<ModeratorDB>, now = new Date()) {
  const result = await moderator
    .updateTable('text_relabel_item')
    .set({ text_value: null })
    .where('purge_after', '<=', now)
    .where('text_value', 'is not', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/**
 * What the CLI may print about a failure. A Postgres error's message and detail can quote the row
 * it failed on, which here is flagged text, so only the error's identifiers survive.
 */
export function describeSnapshotError(err: unknown): string {
  if (err instanceof SnapshotUsageError) return `usage: ${err.message}`;
  const e = (err ?? {}) as Record<string, unknown>;
  const parts = ['code', 'table', 'column', 'constraint']
    .filter((k) => typeof e[k] === 'string' && e[k])
    .map((k) => `${k}=${String(e[k])}`);
  const name = err instanceof Error ? err.name : typeof err;
  return parts.length ? `${name} (${parts.join(', ')})` : `${name} (message withheld)`;
}

export class SnapshotUsageError extends Error {
  override name = 'SnapshotUsageError';
}
