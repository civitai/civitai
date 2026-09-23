import { createLogger } from '~/utils/logging';
import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { deregisterFileLocationsBatch } from '~/utils/storage-resolver';
import { chunk } from 'lodash-es';

const log = createLogger('remove-old-drafts');

/**
 * The reaping schedule now lives in `src/server/common/draft-reaping.ts` and is
 * re-exported here so existing importers keep working.
 *
 * It had to move: the `old-draft` notification is the second consumer of these
 * numbers, and it cannot import THIS module — that would pull `src/server/db/`
 * and `src/utils/logging.ts` into a graph `no-server-infra-in-app-graph.test.ts`
 * forbids them from reaching. The constants module is dependency-free for that
 * reason.
 *
 * `ACTIVITY_WINDOW_DAYS` is read at runtime by `filterModelsWithRecentActivity`.
 * `REAP_AGE_DAYS` still has no runtime reader HERE — the SELECT below spells the
 * threshold as a SQL literal, and `remove-old-drafts.test.ts` pins the literal
 * against the constant — but it is now genuinely load-bearing elsewhere, since
 * the notification derives its own lead time from it.
 */
export { ACTIVITY_WINDOW_DAYS, REAP_AGE_DAYS } from '~/server/common/draft-reaping';
import { ACTIVITY_WINDOW_DAYS } from '~/server/common/draft-reaping';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One `ModelVersion` of a delete candidate, plus the newest `ModelFile` hanging
 * off it. `latestFileAt` is legitimately `null` for a version that carries no
 * files; `createdAt` / `updatedAt` are NOT NULL in the schema, so a missing
 * value there means the query shape drifted, not that the row is quiet.
 */
export type ModelVersionActivityRow = {
  id: number;
  modelId: number;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  latestFileAt: Date | string | null;
};

/** Milliseconds, or `undefined` when the value is absent or unparseable. */
function stampTime(value: unknown): number | undefined {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * Second, independent activity fence, evaluated on the PRIMARY immediately
 * before the cascade delete.
 *
 * The SQL fence in the job runs against the read replica minutes earlier, so it
 * cannot see a version or file written during replica lag or in the window
 * between the SELECT and the DELETE. This re-checks the same rule on rows the
 * write database just handed back. Deleting a model cascades to every
 * ModelVersion and ModelFile under it and is irreversible; sparing one costs a
 * single night, so every ambiguous case resolves toward sparing it.
 *
 * Fails CLOSED, in both directions the shape can go wrong:
 *  - a row whose `createdAt`/`updatedAt` cannot be read protects its model;
 *  - a row whose `modelId` cannot be read cannot be attributed to any model, so
 *    it protects the whole candidate set rather than silently protecting none.
 */
export function filterModelsWithRecentActivity(
  candidateModelIds: number[],
  rows: ModelVersionActivityRow[],
  now: Date = new Date()
): { deletable: number[]; skipped: number[] } {
  const cutoff = now.getTime() - ACTIVITY_WINDOW_DAYS * MS_PER_DAY;
  const active = new Set<number>();

  for (const row of rows) {
    const modelId = row?.modelId;
    if (typeof modelId !== 'number' || !Number.isFinite(modelId)) {
      // Unattributable activity. `active.add(undefined)` would quietly protect
      // nothing, so refuse the entire batch instead.
      return { deletable: [], skipped: [...candidateModelIds] };
    }

    const created = stampTime(row.createdAt);
    const updated = stampTime(row.updatedAt);
    if (created === undefined || updated === undefined) {
      active.add(modelId);
      continue;
    }
    if (created > cutoff || updated > cutoff) {
      active.add(modelId);
      continue;
    }

    // A null here means "this version has no files", which is quiet, not
    // malformed — so it must not protect the model. A non-null value that will
    // not parse is malformed and does.
    if (row.latestFileAt !== null && row.latestFileAt !== undefined) {
      const fileAt = stampTime(row.latestFileAt);
      if (fileAt === undefined || fileAt > cutoff) active.add(modelId);
    }
  }

  const deletable: number[] = [];
  const skipped: number[] = [];
  for (const id of candidateModelIds) (active.has(id) ? skipped : deletable).push(id);
  return { deletable, skipped };
}

export const removeOldDrafts = createJob('remove-old-drafts', '43 2 * * *', async () => {
  // Step 1: Query replica (dbRead) for model IDs to delete
  // This offloads the read operation from the write database and prevents lock contention
  // Uses Model.status (indexed) instead of ModelMetric.status for faster lookups
  //
  // `Model."updatedAt"` is a Prisma `@updatedAt` column: it moves only when a
  // client writes the Model ROW. Creating a version, finishing a training run
  // and uploading a file all write ModelVersion/ModelFile and leave the Model
  // row alone, so on a draft the clock freezes at "creator last edited the
  // model's metadata" while the finished resource lands hours or weeks later.
  // On its own the age test therefore reaps models that are actively being
  // worked on, together with their training datasets. The two NOT EXISTS
  // clauses below are the fence: a model is only quiet if nothing underneath it
  // has moved either.
  const rows = await dbRead.$queryRaw<{ id: number; userId: number }[]>`
    SELECT DISTINCT m.id, m."userId"
    FROM "Model" m
    JOIN "ModelMetric" mm ON mm."modelId" = m.id
    WHERE m.status IN ('Draft', 'Deleted')
      -- REAP_AGE_DAYS. Abandonment threshold: lowering this WIDENS what is
      -- destroyed. Not part of the fence below, and not tied to its window.
      AND m."updatedAt" < now() - INTERVAL '30 days'
      AND mm."downloadCount" < 10
      -- Private models are a creator's own workspace rather than an abandoned
      -- publish attempt, and are never publicly discoverable, so the abandoned-
      -- draft rationale does not apply to them at all.
      --
      -- CONSEQUENCE, decided deliberately rather than overlooked: this job is the
      -- ONLY reaper of Deleted models anywhere in src/server/jobs, so a model that
      -- is BOTH Deleted AND Private is reapable by NOTHING. Those rows, their
      -- ModelVersion/ModelFile children, their storage-resolver file_locations
      -- entries, and the S3 objects those keep whitelisted against the
      -- dereference-quarantine sweep all persist indefinitely. deleteModelById
      -- sets status/deletedAt and never touches availability, while
      -- privateModelFromTraining sets availability to Private permanently, so the
      -- combination is reachable by ordinary use.
      --
      -- Measured 2026-09-06: 179 Private models across Draft and Deleted (117
      -- Deleted+Private, 62 Draft+Private), of which 24 would become reapable if
      -- this term were narrowed to exclude only Private Drafts.
      --
      -- That narrowing was proposed and REJECTED: this job's recent history is
      -- about having destroyed too much (it reaped models whose weights and
      -- training data were days old, because Model.updatedAt is the reap clock and
      -- almost nothing bumps it), and re-enabling an irreversible cascade for 24
      -- abandoned private models is not worth it. Treat Deleted+Private as an
      -- accepted permanent retention class. If that ever changes, the population is
      -- the query above, not a guess.
      --
      -- NOTE: this comment lives inside a tagged template, so it must never contain
      -- a backtick. An earlier draft used markdown-style backticks and terminated
      -- the template, which tsc reported as a cascade of unrelated syntax errors.
      AND m."availability" != 'Private'::"Availability"
      AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv
                       WHERE mv."modelId" = m.id
                         AND (mv."createdAt" > now() - INTERVAL '30 days'
                           OR mv."updatedAt" > now() - INTERVAL '30 days'))
      AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv2
                       JOIN "ModelFile" mf ON mf."modelVersionId" = mv2.id
                       WHERE mv2."modelId" = m.id
                         AND mf."createdAt" > now() - INTERVAL '30 days')
    ORDER BY m.id  -- Consistent lock ordering to prevent deadlocks
  `;

  if (rows.length === 0) {
    log('No old draft models found for removal');
    logToAxiom({ type: 'info', name: 'remove-old-drafts', message: 'No old draft models found' });
    return;
  }

  // Step 2: Delete in batches using dbWrite to minimize lock duration
  // Small batch size (10) because each Model delete cascades to 20+ related tables
  const modelIds = rows.map((r) => r.id);
  const userByModelId = new Map(rows.map((r) => [r.id, r.userId] as const));
  const BATCH_SIZE = 10;
  let deletedCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  log(`Found ${modelIds.length} old draft models to remove`);

  const batches = chunk(modelIds, BATCH_SIZE);
  for (const batch of batches) {
    try {
      // Collect the version ids BEFORE the cascade nukes the ModelVersion rows —
      // once the Model delete cascades, this lookup returns nothing. These feed
      // the post-delete storage-resolver deregister below, and the same rows
      // carry the timestamps the primary-side activity fence re-checks.
      const versionRows = await dbWrite.$queryRaw<ModelVersionActivityRow[]>`
        SELECT mv.id,
               mv."modelId",
               mv."createdAt",
               mv."updatedAt",
               (SELECT max(mf."createdAt") FROM "ModelFile" mf
                 WHERE mf."modelVersionId" = mv.id) AS "latestFileAt"
        FROM "ModelVersion" mv
        WHERE mv."modelId" = ANY(${batch})
      `;

      const { deletable, skipped } = filterModelsWithRecentActivity(batch, versionRows, new Date());

      if (skipped.length > 0) {
        // The replica fence and the primary fence disagreed. Either replica lag
        // or a write that landed between the SELECT and here — both mean this
        // model was still in use and would have been destroyed.
        skippedCount += skipped.length;
        logToAxiom({
          type: 'warning',
          name: 'remove-old-drafts',
          message: 'Skipped old draft models with recent version or file activity',
          modelIds: skipped,
          userIds: skipped.map((id) => userByModelId.get(id) ?? null),
        });
      }

      if (deletable.length === 0) continue;

      const deletableSet = new Set(deletable);
      // Only the versions of models we are actually about to delete. Deregistering
      // a spared model's file_locations would drop its objects out of the
      // dereference-quarantine allowlist — the same data loss by another route.
      const versionIds = versionRows.filter((v) => deletableSet.has(v.modelId)).map((v) => v.id);

      await dbWrite.$executeRaw`
        DELETE FROM "Model"
        WHERE id = ANY(${deletable})
      `;
      deletedCount += deletable.length;

      // Identify what was destroyed. The delete is irreversible and cascades, so
      // without the ids a later "my model vanished" report is unanswerable.
      // Bounded by construction: one event per batch, so at most BATCH_SIZE ids.
      logToAxiom({
        type: 'info',
        name: 'remove-old-drafts',
        message: 'Removed old draft models',
        modelIds: deletable,
        userIds: deletable.map((id) => userByModelId.get(id) ?? null),
      });

      // Post-delete: deregister storage-resolver file_locations for the reaped
      // versions. The FK cascade removes ModelVersion/ModelFile rows but leaves
      // file_locations behind — every leaked row keeps its backend object
      // whitelisted against the dereference-quarantine sweep, a permanent orphan.
      // Best-effort by contract (never throws); guard anyway so a future change
      // can't turn a registry blip into a failed batch.
      if (versionIds.length > 0) {
        try {
          await deregisterFileLocationsBatch(versionIds);
        } catch (error) {
          const e = error as Error;
          logToAxiom({
            type: 'error',
            name: 'remove-old-drafts',
            message: 'Failed to deregister file locations for removed draft versions',
            error: e.message,
            stack: e.stack,
          });
        }
      }
    } catch (error) {
      const e = error as Error;
      errorCount += batch.length;
      logToAxiom({
        type: 'error',
        name: 'remove-old-drafts',
        message: `Failed to remove batch of old draft models`,
        error: e.message,
        stack: e.stack,
        modelIds: batch,
      });
      // Continue with remaining batches even if one fails
    }
  }

  log(
    `Removed ${deletedCount} old draft models` +
      `${skippedCount > 0 ? `, ${skippedCount} skipped for recent activity` : ''}` +
      `${errorCount > 0 ? `, ${errorCount} failed` : ''}`
  );
});
