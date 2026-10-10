import { CompiledQuery, sql, type Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import { relabelSummaryShortfall, type RelabelBuildSummary } from '@civitai/moderation';
import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import type { DB as ModeratorDB } from './moderator-db/types';
import { csamExcludedImageIds } from './relabel-csam-exclusion';
import { UPSERT_RELABEL_ITEM_SQL } from './relabel-item-upsert';
import { deprecatedNsfwName } from '../nsfw-levels';
import { MINOR_BUCKETS } from '../removal-label/compose';
import { allocate, isMinorBucket, scoreBand, type Candidate } from '../removal-label/sampling';

export type ClickhouseQuery = <T extends object>(query: string) => Promise<T[]>;

type BandsSkipped = NonNullable<RelabelBuildSummary['notRemovedSkipped']>;

export type RelabelBuildOptions = {
  batch: string;
  removed: number;
  notRemoved: number;
  days: number;
  /** Ascending scanner minor-score edges. `null` skips the not-removed stratum entirely. */
  bands: number[] | null;
  /** Why `bands` is null, for the summary. */
  bandsSkipped?: BandsSkipped;
  seed?: string;
  dryRun: boolean;
  /** Items the model arms run on but labelers never see. */
  modelOnly?: boolean;
};

export const MAX_RELABEL_DAYS = BLOCKED_IMAGE_RETENTION_DAYS - 1;

/** Keeps each exclusion statement small enough to finish well inside its timeout. */
export const CSAM_EXCLUSION_CHUNK = 250;
const CSAM_EXCLUSION_TIMEOUT_MS = 60_000;
/**
 * Measured from the start of the run: no exclusion chunk starts after it. The ClickHouse reads
 * before it spend it but are not bounded by it, and the writes after it are outside it.
 */
export const CSAM_EXCLUSION_BUDGET_MS = 3 * 60_000;
/** The scanner pool fetched for the not-removed stratum, whatever the bands and caps ask for. */
export const MAX_SCANNED_IDS = 50_000;

/** `RELABEL_NOT_REMOVED_BANDS` / `--bands`: comma-separated edges in (0, 1). Empty is `null`. */
export function parseBands(raw: string | undefined): number[] | null {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const bands = parts.map(Number).sort((a, b) => a - b);
  if (bands.some((b) => !(b > 0 && b < 1))) throw new Error('bands must be scores in (0, 1)');
  return bands;
}

/**
 * The scheduled build's bands, from the environment only. A malformed value builds the removed
 * stratum alone rather than failing the run: removed items age out of the window within days, and
 * the bands only shape the other stratum.
 */
export function bandsFromEnv(raw: string | undefined): {
  bands: number[] | null;
  bandsSkipped?: BandsSkipped;
  error?: string;
} {
  try {
    const bands = parseBands(raw);
    return bands ? { bands } : { bands: null, bandsSkipped: 'bands unset' };
  } catch (e) {
    return { bands: null, bandsSkipped: 'bands invalid', error: (e as Error).message };
  }
}

type RemovalRow = {
  imageId: number;
  bucket: string;
  removedAt: number;
  removedBy: number;
  nsfw: string;
};

async function fetchRemovals(ch: ClickhouseQuery, days: number): Promise<RemovalRow[]> {
  const bucketList = MINOR_BUCKETS.map((b) => `'${b}'`).join(',');
  // First removal per image: a re-removal must not move the clock or the label.
  const rows = await ch<RemovalRow>(`
    SELECT imageId,
           argMin(violationType, time) AS bucket,
           toUnixTimestamp(min(time)) AS removedAt,
           argMin(userId, time) AS removedBy,
           toString(argMin(nsfw, time)) AS nsfw
    FROM images
    WHERE type = 'DeleteTOS' AND mediaType = 'image'
      AND violationType IN (${bucketList})
      AND time > now() - INTERVAL ${days} DAY
    GROUP BY imageId
  `);
  // A 64-bit column can arrive quoted; a string id would miss every numeric Set and Map below,
  // the CSAM exclusion among them.
  return rows.map((r) => ({
    ...r,
    imageId: Number(r.imageId),
    removedAt: Number(r.removedAt),
    removedBy: Number(r.removedBy),
  }));
}

async function fetchMinorScores(
  ch: ClickhouseQuery,
  days: number,
  limit: number,
  seed: string
): Promise<Map<number, number>> {
  const seedLiteral = seed.replace(/[^A-Za-z0-9_-]/g, '');
  // An image row's contentHash is derived from its image id (`scanner-audit.service.ts`), so a group
  // holds one image; GROUP BY only folds parts the merge has not collapsed yet, and the latest score
  // wins so two age-model versions never blend. The CSAM label in this table is never read.
  const rows = await ch<{ ids: (string | number)[]; score: number }>(`
    SELECT groupUniqArrayArray(entityIds) AS ids, argMax(score, lastSeenAt) AS score
    FROM scanner_label_results
    WHERE scanner = 'image_ingestion' AND entityType = 'image' AND label = 'minor'
    GROUP BY contentHash
    HAVING min(firstSeenAt) > now() - INTERVAL ${days} DAY
    ORDER BY cityHash64(contentHash, '${seedLiteral}')
    LIMIT ${limit}
  `);
  return new Map(
    rows.filter((r) => r.ids.length > 0).map((r) => [Number(r.ids[0]), Number(r.score)])
  );
}

// 57014 is also what a manual `pg_cancel_backend` or a client abort raises; only the timeout's
// message means the exclusion was too slow, and anything else must fail the run loudly.
const isStatementTimeout = (e: unknown) =>
  (e as { code?: string }).code === '57014' &&
  ((e as { message?: string }).message ?? '').includes('statement timeout');

/** `null` when the exclusion ran out of time: the caller must then write nothing. */
async function csamExcluded(
  replica: Kysely<MainDB>,
  ids: number[],
  now: () => number,
  deadline: number
): Promise<Set<number> | null> {
  const excluded = new Set<number>();
  try {
    for (let i = 0; i < ids.length; i += CSAM_EXCLUSION_CHUNK) {
      if (now() > deadline) return null;
      const chunk = ids.slice(i, i + CSAM_EXCLUSION_CHUNK);
      // In a transaction so the timeout applies to this query only, and cancels it server-side
      // rather than leaving it running after the caller has given up.
      const rows = await replica
        .transaction()
        .setAccessMode('read only')
        .execute(async (trx) => {
          await sql.raw(`SET LOCAL statement_timeout = ${CSAM_EXCLUSION_TIMEOUT_MS}`).execute(trx);
          return (await csamExcludedImageIds(chunk).execute(trx)).rows;
        });
      for (const r of rows) excluded.add(r.id);
    }
  } catch (e) {
    if (isStatementTimeout(e)) return null;
    throw e;
  }
  return excluded;
}

/**
 * `column = ANY($1)`: one bind parameter however many ids. An `in` list takes one per id, and the
 * scanned and removed ids together can pass Postgres's 65,535.
 */
const anyOf = (column: string, ids: number[]) =>
  sql<boolean>`${sql.ref(column)} = ANY(${ids}::int[])`;

const countBy = (cs: Candidate[]) => ({
  removed: cs.filter((c) => c.stratum === 'removed').length,
  notRemoved: cs.filter((c) => c.stratum === 'not_removed').length,
});

/**
 * Builds one batch of the removal-label relabel set. Called daily by the main app's
 * `relabel-build-batch` job through the `relabel-build-batch` mod-action, and by
 * `removal-label-eval/build-set.ts` by hand.
 *
 * Removed images are hard-deleted `BLOCKED_IMAGE_RETENTION_DAYS` after the block, so removed items
 * are drawn from the last `days` and carry `purge_after`.
 *
 * `removed` and `notRemoved` cap what the batch holds, not what one run adds: a run fills only what
 * the batch is still short of, so a re-run after a complete run adds nothing and a re-run after a
 * crashed one finishes it.
 */
export async function buildRelabelBatch(
  opts: RelabelBuildOptions,
  deps: {
    clickhouse: ClickhouseQuery;
    replica: Kysely<MainDB>;
    moderator: Kysely<ModeratorDB>;
    now?: () => number;
  }
): Promise<RelabelBuildSummary> {
  if (!(opts.days >= 1 && opts.days <= MAX_RELABEL_DAYS))
    throw new Error(`days must be 1-${MAX_RELABEL_DAYS}: older removals are purged`);
  const now = deps.now ?? Date.now;
  const deadline = now() + CSAM_EXCLUSION_BUDGET_MS;
  const seed = opts.seed ?? opts.batch;
  const modelOnly = opts.modelOnly ?? false;
  const { replica, moderator } = deps;

  const removals = await fetchRemovals(deps.clickhouse, opts.days);
  const scoreById = opts.bands
    ? await fetchMinorScores(
        deps.clickhouse,
        opts.days,
        Math.min(MAX_SCANNED_IDS, Math.max(200, opts.notRemoved * 20) * (opts.bands.length + 1)),
        seed
      )
    : new Map<number, number>();

  const ids = [...new Set([...removals.map((r) => r.imageId), ...scoreById.keys()])];
  const images = ids.length
    ? await replica
        .selectFrom('Image')
        .select(['id', 'userId', 'ingestion', 'needsReview', 'blockedFor', 'nsfwLevel', 'type'])
        .where(anyOf('id', ids))
        .execute()
    : [];
  const imageById = new Map(images.map((i) => [i.id, i]));

  let candidates: Candidate[] = [];
  for (const r of removals) {
    const img = imageById.get(r.imageId);
    if (!img || img.type !== 'image' || img.ingestion !== 'Blocked' || !isMinorBucket(r.bucket))
      continue;
    candidates.push({
      imageId: r.imageId,
      ownerId: img.userId,
      stratum: 'removed',
      bucket: r.bucket,
      nsfwLevel: r.nsfw,
      stratumKey: `${r.bucket}:${r.nsfw}`,
    });
  }
  for (const [imageId, score] of scoreById) {
    const img = imageById.get(imageId);
    if (
      !img ||
      img.type !== 'image' ||
      img.ingestion !== 'Scanned' ||
      img.needsReview !== null ||
      img.blockedFor !== null
    )
      continue;
    const level = deprecatedNsfwName(img.nsfwLevel);
    candidates.push({
      imageId,
      ownerId: img.userId,
      stratum: 'not_removed',
      bucket: null,
      nsfwLevel: level,
      // `bands` is non-null here: the score map is empty without it.
      stratumKey: `band${scoreBand(score, opts.bands ?? [])}:${level}`,
    });
  }

  const before = countBy(candidates);
  const notRemovedSkipped = opts.bands ? null : opts.bandsSkipped ?? 'bands unset';
  const excluded = await csamExcluded(
    replica,
    candidates.map((c) => c.imageId),
    now,
    deadline
  );
  if (!excluded)
    return {
      batch: opts.batch,
      dryRun: opts.dryRun,
      modelOnly,
      skipped: 'csam exclusion timed out',
      notRemovedSkipped,
      candidates: before,
      csamExcluded: { removed: 0, notRemoved: 0 },
      alreadyInSet: 0,
      alreadyInBatch: { removed: 0, notRemoved: 0 },
      picked: { removed: 0, notRemoved: 0 },
      strata: [],
      inserted: 0,
      promoted: 0,
      alreadyPresent: 0,
    };
  candidates = candidates.filter((c) => !excluded.has(c.imageId));
  const after = countBy(candidates);

  const removedIds = candidates.filter((c) => c.stratum === 'removed').map((c) => c.imageId);
  const appeals = new Map<number, { status: string; resolvedAt: Date | null }>();
  if (removedIds.length) {
    const rows = await replica
      .selectFrom('Appeal')
      .distinctOn('entityId')
      .select(['entityId', 'status', 'resolvedAt'])
      .where('entityType', '=', 'Image')
      .where(anyOf('entityId', removedIds))
      .orderBy('entityId')
      .orderBy('createdAt', 'desc')
      .execute();
    for (const a of rows) appeals.set(a.entityId, { status: a.status, resolvedAt: a.resolvedAt });
  }
  const removalById = new Map(removals.map((r) => [r.imageId, r]));

  return moderator.transaction().execute(async (trx) => {
    // Serialises two runs of one batch, which would otherwise each read the same shortfall and
    // together overshoot the cap. On `trx`: run anywhere else, the lock is released at once.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`relabel-batch:${opts.batch}`}))`.execute(
      trx
    );

    const present = candidates.length
      ? await trx
          .selectFrom('relabel_item')
          .select(['image_id', 'relabel'])
          .where(
            anyOf(
              'image_id',
              candidates.map((c) => c.imageId)
            )
          )
          .execute()
      : [];
    // A model-only build skips anything present; a labeler build skips only what labelers already
    // have, so a model-only row stays available to be promoted.
    const already = new Set(present.filter((r) => modelOnly || r.relabel).map((r) => r.image_id));
    const pool = candidates.filter((c) => !already.has(c.imageId));

    const held = await trx
      .selectFrom('relabel_item')
      .select(['stratum', sql<number>`count(*)::int`.as('n')])
      .where('batch', '=', opts.batch)
      .where('relabel', '=', !modelOnly)
      .groupBy('stratum')
      .execute();
    const inBatch = (stratum: string) => held.find((h) => h.stratum === stratum)?.n ?? 0;
    const alreadyInBatch = { removed: inBatch('removed'), notRemoved: inBatch('not_removed') };

    const picked = [
      ...allocate(
        pool.filter((c) => c.stratum === 'removed'),
        Math.max(0, opts.removed - alreadyInBatch.removed),
        seed
      ),
      ...allocate(
        pool.filter((c) => c.stratum === 'not_removed'),
        Math.max(0, opts.notRemoved - alreadyInBatch.notRemoved),
        seed
      ),
    ];

    const strataCounts = new Map<string, number>();
    for (const p of picked) {
      const key = `${p.stratum} ${p.stratumKey}`;
      strataCounts.set(key, (strataCounts.get(key) ?? 0) + 1);
    }

    let inserted = 0;
    let promoted = 0;
    if (!opts.dryRun) {
      for (const p of picked) {
        const removal = removalById.get(p.imageId);
        const removedAt = removal ? new Date(removal.removedAt * 1000) : null;
        const appeal = appeals.get(p.imageId);
        const res = await trx.executeQuery<{ inserted: boolean }>(
          CompiledQuery.raw(UPSERT_RELABEL_ITEM_SQL, [
            opts.batch,
            p.imageId,
            p.stratum,
            p.bucket,
            p.nsfwLevel,
            p.stratumKey,
            p.ownerId,
            removedAt,
            removal?.removedBy ?? null,
            removedAt
              ? new Date(removedAt.getTime() + BLOCKED_IMAGE_RETENTION_DAYS * 24 * 3600 * 1000)
              : null,
            appeal?.status ?? null,
            appeal?.resolvedAt ?? null,
            !modelOnly,
          ])
        );
        for (const r of res.rows) {
          if (r.inserted) inserted++;
          else promoted++;
        }
      }
    }

    return {
      batch: opts.batch,
      dryRun: opts.dryRun,
      modelOnly,
      skipped: null,
      notRemovedSkipped,
      candidates: before,
      csamExcluded: {
        removed: before.removed - after.removed,
        notRemoved: before.notRemoved - after.notRemoved,
      },
      alreadyInSet: already.size,
      alreadyInBatch,
      picked: countBy(picked),
      strata: [...strataCounts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, n]) => ({ key, n })),
      inserted,
      promoted,
      alreadyPresent: opts.dryRun ? 0 : picked.length - inserted - promoted,
    };
  });
}

type Log = (data: Record<string, unknown>) => void;

/** The `relabel-build-batch` mod-action, given the raw `RELABEL_NOT_REMOVED_BANDS`. */
export async function relabelBuildBatchAction(
  input: Omit<RelabelBuildOptions, 'bands' | 'bandsSkipped' | 'seed' | 'modelOnly'>,
  rawBands: string | undefined,
  deps: Parameters<typeof buildRelabelBatch>[1],
  log: Log
): Promise<RelabelBuildSummary> {
  const { bands, bandsSkipped, error } = bandsFromEnv(rawBands);
  if (error)
    log({ type: 'error', name: 'relabel-build-batch-bands-invalid', batch: input.batch, error });
  const summary = await buildRelabelBatch({ ...input, bands, bandsSkipped }, deps);
  log({
    type: relabelSummaryShortfall(summary) ? 'error' : 'info',
    name: 'relabel-build-batch',
    ...summary,
  });
  return summary;
}
