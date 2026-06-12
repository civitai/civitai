/**
 * One-time endpoint to clamp ModelVersion.publishedAt, Model.publishedAt,
 * Model.lastVersionAt, and Post.publishedAt where prior republishes bumped
 * them past their original publish date. Companion to the anti-bump guards
 * added at the publish write sites.
 *
 * Why an endpoint instead of a raw SQL migration:
 *   - clamping publishedAt changes the search-index sort keys
 *     (publishedAtUnix on Model + Image docs); without queueing index
 *     updates the Meilisearch entries stay stuck on the bumped values
 *   - dataForModelsCache + bustMvCache need refreshing so feed reads
 *     pick up the new sort order without waiting for TTL
 *   - the raw SQL would otherwise need to also write to the
 *     SearchIndexUpdateQueue table by hand, which is duplicative and
 *     misses cache invalidation entirely
 *
 * Actions:
 *   action=apply (default)
 *     Clamps publishedAt + lastVersionAt to their inferred original values
 *     AND stashes the pre-clamp value into meta/metadata under the key
 *     `clampPrev{Column}`. Reclass step 4 also stashes the pre-flip status.
 *     Stashes make the change reversible.
 *
 *   action=rollback
 *     Reads the stash keys back, writes the stashed values into the live
 *     columns, strips the stash. Idempotent — running rollback twice is a
 *     no-op (second pass finds no stash to restore).
 *
 * Run with:
 *   POST /api/admin/temp/clamp-publishedat-bumps?token=$WEBHOOK_TOKEN&dryRun=true
 *   POST /api/admin/temp/clamp-publishedat-bumps?token=$WEBHOOK_TOKEN&dryRun=false&action=apply
 *   POST /api/admin/temp/clamp-publishedat-bumps?token=$WEBHOOK_TOKEN&dryRun=false&action=rollback
 *
 * Optional `modelIds` query param (comma-delimited Model.id list) scopes
 * the run to a subset of models. When provided, every op is filtered to
 * those models' versions (op1a/op1b/op4_versions/rb_versions), the models
 * themselves (op4_models/rb_models), and posts attached to those models'
 * versions via Post.modelVersionId (op3_posts/rb_posts). Missing/empty
 * runs the original global migration.
 *
 *   POST /api/admin/temp/clamp-publishedat-bumps?token=$WEBHOOK_TOKEN&dryRun=true&modelIds=123,456,789
 *   POST /api/admin/temp/clamp-publishedat-bumps?token=$WEBHOOK_TOKEN&dryRun=false&action=rollback&modelIds=123,456
 *
 * `dryRun=true` (the default) runs the SQL inside a transaction then aborts
 * it via thrown sentinel — DB writes roll back, side-effects (search-index
 * queue, cache refresh) are skipped, response includes the same `ops` counts
 * the real run would produce.
 *
 * Known orphans (out of scope — hand-fix after deploy):
 *   Posts with `publishedAt` scheduled to a future date AND a
 *   `prevPublishedAt` stash are the symptom of the L1 loophole (fixed in
 *   updatePost). These rows are intentionally skipped by Op 3 (filter:
 *   `publishedAt <= NOW()`) so the migration doesn't surface them
 *   immediately. After the L1 fix is live, query the affected IDs:
 *     SELECT id FROM "Post"
 *      WHERE metadata->>'prevPublishedAt' IS NOT NULL
 *        AND "publishedAt" IS NOT NULL
 *        AND "publishedAt" > NOW();
 *   Then drop the dangling stash on each one:
 *     UPDATE "Post"
 *     SET metadata = metadata - 'prevPublishedAt'
 *                            - 'unpublishedAt'
 *                            - 'unpublishedBy'
 *     WHERE id = <orphan_post_id>;
 *   so a future reschedule doesn't trigger the CASE-restore path in
 *   updatePost.
 */

import type { NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import {
  imagesSearchIndex,
  imagesMetricsSearchIndex,
  modelsSearchIndex,
} from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dataForModelsCache } from '~/server/redis/caches';
import { bustMvCache } from '~/server/services/model-version.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { booleanString, commaDelimitedNumberArray } from '~/utils/zod-helpers';

// `modelIds` accepts a comma-delimited list of Model.id values. When
// provided, every clamp/rollback op is scoped to those models (and their
// owned versions + posts attached to those versions). Empty/missing =
// global migration, preserving the original behavior.
const schema = z.object({
  dryRun: booleanString().default(true),
  action: z.enum(['apply', 'rollback']).default('apply'),
  modelIds: commaDelimitedNumberArray(z.array(z.number().int().positive())).default([]),
});

// Stash keys live alongside the columns we mutate so a rollback can find
// them with a simple `meta->>'<key>' IS NOT NULL` filter. The `clampPrev*`
// naming distinguishes migration-scratch state from the live
// `prevPublishedAt` / `unpublishedAt` keys written by the regular
// unpublish flow.
const STASH = {
  prevPublishedAt: 'clampPrevPublishedAt',
  prevLastVersionAt: 'clampPrevLastVersionAt',
  prevStatus: 'clampPrevStatus',
} as const;

type Ops = {
  clampedVersionsByVersionMeta: number;
  clampedVersionsByPostEvidence: number;
  resyncedModelLastVersionAt: number;
  clampedModelPublishedAt: number;
  clampedPosts: number;
  reclassedVersionsToUnpublished: number;
  reclassedModelsToUnpublished: number;
};

type RollbackOps = {
  restoredVersionPublishedAt: number;
  restoredModelPublishedAt: number;
  restoredModelLastVersionAt: number;
  restoredPostPublishedAt: number;
  restoredVersionStatus: number;
  restoredModelStatus: number;
};

type AffectedIds = {
  modelIds: number[];
  versionIds: number[];
  postIds: number[];
};

class DryRunRollback extends Error {
  constructor(
    public readonly payload: {
      ops: Ops | RollbackOps;
      affected: AffectedIds;
    }
  ) {
    super('dry-run rollback');
  }
}

// SQL fragments that narrow each op to `modelIds` when provided. Each
// fragment is appended to the WHERE clause of its temp table; when no
// modelIds are passed, the fragments are `Prisma.empty` and the queries
// degenerate to the original global form.
function buildScope(modelIds: number[]) {
  const hasScope = modelIds.length > 0;
  return {
    hasScope,
    // ModelVersion temp tables (op1a, op4_versions) — direct column.
    versionScope: hasScope
      ? Prisma.sql`AND "modelId" = ANY(${modelIds}::int[])`
      : Prisma.empty,
    // op1b uses the `mv` alias.
    versionScopeMv: hasScope
      ? Prisma.sql`AND mv."modelId" = ANY(${modelIds}::int[])`
      : Prisma.empty,
    // Model temp tables (op4_models, rb_models) — direct column.
    modelScope: hasScope
      ? Prisma.sql`AND id = ANY(${modelIds}::int[])`
      : Prisma.empty,
    // Post temp tables need a join to ModelVersion to reach modelId.
    // LEFT JOIN keeps the global path identical (no row drops when
    // unscoped); when scoped, the filter `mv."modelId" = ANY(...)` drops
    // posts whose modelVersionId is NULL because `NULL = ANY(...)` is
    // NULL (excluded), which matches "this post isn't tied to one of the
    // requested models".
    postScopeJoin: hasScope
      ? Prisma.sql`LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"`
      : Prisma.empty,
    postScopeFilter: hasScope
      ? Prisma.sql`AND mv."modelId" = ANY(${modelIds}::int[])`
      : Prisma.empty,
  };
}

async function runApply(
  dryRun: boolean,
  scopeModelIds: number[]
): Promise<{ ops: Ops; affected: AffectedIds }> {
  const { versionScope, versionScopeMv, modelScope, postScopeJoin, postScopeFilter } =
    buildScope(scopeModelIds);

  return dbWrite.$transaction(
    async (tx) => {
      // ---- Snapshot bump-evidence rowsets BEFORE any clamp runs ----
      // Steps 2/2b filter by the same evidence (`meta.unpublishedAt <
      // publishedAt`, `post.publishedAt < mv.publishedAt`) that steps 1a/1b
      // *consume* by clamping. Snapshotting freezes the scope so downstream
      // steps survive the in-transaction mutations. Step 3 (post clamp) is
      // self-contained but we also snapshot its scope so we know which post
      // IDs to queue for image-search reindex after commit.
      await tx.$executeRaw`
        CREATE TEMP TABLE op1a_versions ON COMMIT DROP AS
        SELECT id, "modelId"
        FROM "ModelVersion"
        WHERE "publishedAt" IS NOT NULL
          AND "publishedAt" <= NOW()
          AND status = 'Published'
          AND meta->>'unpublishedAt' IS NOT NULL
          AND (meta->>'unpublishedAt')::timestamptz < "publishedAt"
          ${versionScope}
      `;

      await tx.$executeRaw`
        CREATE TEMP TABLE op1b_versions ON COMMIT DROP AS
        SELECT DISTINCT mv.id, mv."modelId"
        FROM "ModelVersion" mv
        JOIN "Post" p ON p."modelVersionId" = mv.id
        JOIN "Model" mm ON mm.id = mv."modelId" AND mm."userId" = p."userId"
        WHERE mv.status = 'Published'
          AND mv."publishedAt" IS NOT NULL
          AND mv."publishedAt" <= NOW()
          AND p.metadata->>'unpublishedAt' IS NOT NULL
          AND p."publishedAt" IS NOT NULL
          AND p."publishedAt" < mv."publishedAt"
          ${versionScopeMv}
      `;

      // Excludes scheduled-future posts: clamping a future `publishedAt`
      // back to a past `prevPublishedAt` would surface the post instantly,
      // overriding the author's schedule. Author-scheduled state is not the
      // republish bump pattern this migration targets.
      await tx.$executeRaw`
        CREATE TEMP TABLE op3_posts ON COMMIT DROP AS
        SELECT p.id
        FROM "Post" p
        ${postScopeJoin}
        WHERE p.metadata->>'prevPublishedAt' IS NOT NULL
          AND p."publishedAt" IS NOT NULL
          AND p."publishedAt" <= NOW()
          AND p."publishedAt" > (p.metadata->>'prevPublishedAt')::timestamptz
          ${postScopeFilter}
      `;

      // Op 4 reclass scope is captured upfront too. Without this the
      // post-commit side-effects (dataForModelsCache.refresh, bustMvCache)
      // would skip the reclassed Draft->Unpublished rows on apply, while
      // the rollback path picks them up via the `prevStatus IS NOT NULL`
      // filter and refreshes their caches — the asymmetry would mean
      // running apply→rollback touches a wider set of caches than apply
      // alone, masking any drift between the two paths.
      await tx.$executeRaw`
        CREATE TEMP TABLE op4_versions ON COMMIT DROP AS
        SELECT id, "modelId"
        FROM "ModelVersion"
        WHERE status = 'Draft'::"ModelStatus"
          AND meta->>'unpublishedAt'     IS NOT NULL
          AND meta->>'unpublishedReason' IN ('no-files', 'no-posts')
          ${versionScope}
      `;

      await tx.$executeRaw`
        CREATE TEMP TABLE op4_models ON COMMIT DROP AS
        SELECT id
        FROM "Model"
        WHERE status = 'Draft'::"ModelStatus"
          AND meta->>'unpublishedAt'     IS NOT NULL
          AND meta->>'unpublishedReason' = 'no-versions'
          ${modelScope}
      `;

      // ---- 1a) clamp ModelVersion.publishedAt via version meta breadcrumb ----
      const clampedVersionsByVersionMeta = await tx.$executeRaw`
        UPDATE "ModelVersion"
        SET
          meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(${STASH.prevPublishedAt}, "publishedAt"),
          "publishedAt" = GREATEST(
            "createdAt",
            LEAST(
              "publishedAt",
              (meta->>'unpublishedAt')::timestamptz
            )
          )
        WHERE id IN (SELECT id FROM op1a_versions)
      `;

      // ---- 1b) clamp ModelVersion.publishedAt via owner-post evidence ----
      const clampedVersionsByPostEvidence = await tx.$executeRaw`
        UPDATE "ModelVersion" mv
        SET
          meta = COALESCE(mv.meta, '{}'::jsonb) || jsonb_build_object(${STASH.prevPublishedAt}, mv."publishedAt"),
          "publishedAt" = GREATEST(
            mv."createdAt",
            LEAST(
              mv."publishedAt",
              (
                SELECT MIN(p."publishedAt")
                FROM "Post" p
                JOIN "Model" m ON m.id = mv."modelId"
                WHERE p."modelVersionId" = mv.id
                  AND p."userId" = m."userId"
                  AND p.metadata->>'unpublishedAt' IS NOT NULL
                  AND p."publishedAt" IS NOT NULL
              )
            )
          )
        WHERE mv.id IN (SELECT id FROM op1b_versions)
      `;

      // ---- 2) resync Model.lastVersionAt for 1a ∪ 1b modelIds ----
      const resyncedModelLastVersionAt = await tx.$executeRaw`
        UPDATE "Model" m
        SET
          meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(${STASH.prevLastVersionAt}, m."lastVersionAt"),
          "lastVersionAt" = sub.last_pub
        FROM (
          SELECT "modelId", MAX("publishedAt") AS last_pub
          FROM "ModelVersion"
          WHERE status = 'Published'
            AND "publishedAt" IS NOT NULL
            AND "publishedAt" <= NOW()
          GROUP BY "modelId"
        ) sub
        WHERE m.id = sub."modelId"
          AND m."lastVersionAt" IS DISTINCT FROM sub.last_pub
          AND m.id IN (
            SELECT "modelId" FROM op1a_versions
            UNION
            SELECT "modelId" FROM op1b_versions
          )
      `;

      // ---- 2b) clamp Model.publishedAt for 1b modelIds ----
      const clampedModelPublishedAt = await tx.$executeRaw`
        UPDATE "Model" m
        SET
          meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(${STASH.prevPublishedAt}, m."publishedAt"),
          "publishedAt" = sub.first_pub
        FROM (
          SELECT "modelId", MIN("publishedAt") AS first_pub
          FROM "ModelVersion"
          WHERE status = 'Published'
            AND "publishedAt" IS NOT NULL
            AND "publishedAt" <= NOW()
          GROUP BY "modelId"
        ) sub
        WHERE m.id = sub."modelId"
          AND m."publishedAt" IS NOT NULL
          AND m."publishedAt" > sub.first_pub
          AND m.id IN (SELECT "modelId" FROM op1b_versions)
      `;

      // ---- 3) clamp Post.publishedAt where bumped past prevPublishedAt ----
      const clampedPosts = await tx.$executeRaw`
        UPDATE "Post"
        SET
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(${STASH.prevPublishedAt}, "publishedAt"),
          "publishedAt" = GREATEST(
            "createdAt",
            LEAST(
              "publishedAt",
              (metadata->>'prevPublishedAt')::timestamptz
            )
          )
        WHERE id IN (SELECT id FROM op3_posts)
      `;

      // ---- 4) reclassify legacy cron-demoted Draft -> Unpublished ----
      // Driven off the op4_versions / op4_models snapshots so the affected
      // ID set used for side-effects below stays consistent with what we
      // actually wrote.
      const reclassedVersionsToUnpublished = await tx.$executeRaw`
        UPDATE "ModelVersion"
        SET
          meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(${STASH.prevStatus}, status::text),
          status = 'Unpublished'::"ModelStatus"
        WHERE id IN (SELECT id FROM op4_versions)
      `;

      const reclassedModelsToUnpublished = await tx.$executeRaw`
        UPDATE "Model"
        SET
          meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(${STASH.prevStatus}, status::text),
          status = 'Unpublished'::"ModelStatus"
        WHERE id IN (SELECT id FROM op4_models)
      `;

      // ---- collect affected IDs for side-effects ----
      // Union all four scopes (1a, 1b, op4 versions, op4 models) so the
      // cache + search-index sweep matches what rollback would touch in
      // reverse. Apply/rollback asymmetry would otherwise mask drift
      // because rollback's filter (`prevStatus IS NOT NULL`) catches the
      // op4 reclass rows but apply did not.
      const affectedVersionRows = await tx.$queryRaw<{ id: number; modelId: number }[]>`
        SELECT id, "modelId" FROM op1a_versions
        UNION
        SELECT id, "modelId" FROM op1b_versions
        UNION
        SELECT id, "modelId" FROM op4_versions
      `;
      const versionIds = affectedVersionRows.map((r) => r.id);
      const versionModelIds = affectedVersionRows.map((r) => r.modelId);

      const op4ModelRows = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM op4_models
      `;

      const postRows = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM op3_posts
      `;

      const modelIds = Array.from(
        new Set([...versionModelIds, ...op4ModelRows.map((r) => r.id)])
      );
      const postIds = postRows.map((r) => r.id);

      const result = {
        ops: {
          clampedVersionsByVersionMeta: Number(clampedVersionsByVersionMeta),
          clampedVersionsByPostEvidence: Number(clampedVersionsByPostEvidence),
          resyncedModelLastVersionAt: Number(resyncedModelLastVersionAt),
          clampedModelPublishedAt: Number(clampedModelPublishedAt),
          clampedPosts: Number(clampedPosts),
          reclassedVersionsToUnpublished: Number(reclassedVersionsToUnpublished),
          reclassedModelsToUnpublished: Number(reclassedModelsToUnpublished),
        },
        affected: { modelIds, versionIds, postIds },
      };

      if (dryRun) {
        throw new DryRunRollback(result);
      }

      return result;
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 }
  );
}

async function runRollback(
  dryRun: boolean,
  scopeModelIds: number[]
): Promise<{ ops: RollbackOps; affected: AffectedIds }> {
  const { versionScope, modelScope, postScopeJoin, postScopeFilter } = buildScope(scopeModelIds);

  return dbWrite.$transaction(
    async (tx) => {
      // Snapshot IDs that carry a stash BEFORE we strip the keys — we'll
      // need them post-commit to queue search-index updates and cache busts.
      await tx.$executeRaw`
        CREATE TEMP TABLE rb_versions ON COMMIT DROP AS
        SELECT id, "modelId"
        FROM "ModelVersion"
        WHERE (meta->>${STASH.prevPublishedAt} IS NOT NULL
            OR meta->>${STASH.prevStatus}      IS NOT NULL)
          ${versionScope}
      `;

      await tx.$executeRaw`
        CREATE TEMP TABLE rb_models ON COMMIT DROP AS
        SELECT id
        FROM "Model"
        WHERE (meta->>${STASH.prevPublishedAt}    IS NOT NULL
            OR meta->>${STASH.prevLastVersionAt}  IS NOT NULL
            OR meta->>${STASH.prevStatus}         IS NOT NULL)
          ${modelScope}
      `;

      await tx.$executeRaw`
        CREATE TEMP TABLE rb_posts ON COMMIT DROP AS
        SELECT p.id
        FROM "Post" p
        ${postScopeJoin}
        WHERE p.metadata->>${STASH.prevPublishedAt} IS NOT NULL
          ${postScopeFilter}
      `;

      // All UPDATEs below are scoped to the rb_* temp tables so that
      // passing `modelIds` narrows the rollback to only those models'
      // versions/posts (and Models themselves). Unscoped runs include
      // every stashed row, matching the original global behavior.

      // ---- Restore ModelVersion.publishedAt + strip stash ----
      const restoredVersionPublishedAt = await tx.$executeRaw`
        UPDATE "ModelVersion"
        SET
          "publishedAt" = (meta->>${STASH.prevPublishedAt})::timestamptz,
          meta = meta - ${STASH.prevPublishedAt}
        WHERE meta->>${STASH.prevPublishedAt} IS NOT NULL
          AND id IN (SELECT id FROM rb_versions)
      `;

      // ---- Restore ModelVersion.status (reclass step 4 reversal) ----
      const restoredVersionStatus = await tx.$executeRaw`
        UPDATE "ModelVersion"
        SET
          status = (meta->>${STASH.prevStatus})::"ModelStatus",
          meta = meta - ${STASH.prevStatus}
        WHERE meta->>${STASH.prevStatus} IS NOT NULL
          AND id IN (SELECT id FROM rb_versions)
      `;

      // ---- Restore Model.publishedAt + strip stash ----
      const restoredModelPublishedAt = await tx.$executeRaw`
        UPDATE "Model"
        SET
          "publishedAt" = (meta->>${STASH.prevPublishedAt})::timestamptz,
          meta = meta - ${STASH.prevPublishedAt}
        WHERE meta->>${STASH.prevPublishedAt} IS NOT NULL
          AND id IN (SELECT id FROM rb_models)
      `;

      // ---- Restore Model.lastVersionAt + strip stash ----
      const restoredModelLastVersionAt = await tx.$executeRaw`
        UPDATE "Model"
        SET
          "lastVersionAt" = (meta->>${STASH.prevLastVersionAt})::timestamptz,
          meta = meta - ${STASH.prevLastVersionAt}
        WHERE meta->>${STASH.prevLastVersionAt} IS NOT NULL
          AND id IN (SELECT id FROM rb_models)
      `;

      // ---- Restore Model.status (reclass step 4 reversal) ----
      const restoredModelStatus = await tx.$executeRaw`
        UPDATE "Model"
        SET
          status = (meta->>${STASH.prevStatus})::"ModelStatus",
          meta = meta - ${STASH.prevStatus}
        WHERE meta->>${STASH.prevStatus} IS NOT NULL
          AND id IN (SELECT id FROM rb_models)
      `;

      // ---- Restore Post.publishedAt + strip stash ----
      const restoredPostPublishedAt = await tx.$executeRaw`
        UPDATE "Post"
        SET
          "publishedAt" = (metadata->>${STASH.prevPublishedAt})::timestamptz,
          metadata = metadata - ${STASH.prevPublishedAt}
        WHERE metadata->>${STASH.prevPublishedAt} IS NOT NULL
          AND id IN (SELECT id FROM rb_posts)
      `;

      // ---- collect affected IDs for side-effects ----
      const versionRows = await tx.$queryRaw<{ id: number; modelId: number }[]>`
        SELECT id, "modelId" FROM rb_versions
      `;
      const modelRows = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM rb_models
      `;
      const postRows = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM rb_posts
      `;

      const modelIds = Array.from(
        new Set([...versionRows.map((v) => v.modelId), ...modelRows.map((m) => m.id)])
      );
      const versionIds = versionRows.map((v) => v.id);
      const postIds = postRows.map((p) => p.id);

      const result = {
        ops: {
          restoredVersionPublishedAt: Number(restoredVersionPublishedAt),
          restoredModelPublishedAt: Number(restoredModelPublishedAt),
          restoredModelLastVersionAt: Number(restoredModelLastVersionAt),
          restoredPostPublishedAt: Number(restoredPostPublishedAt),
          restoredVersionStatus: Number(restoredVersionStatus),
          restoredModelStatus: Number(restoredModelStatus),
        },
        affected: { modelIds, versionIds, postIds },
      };

      if (dryRun) {
        throw new DryRunRollback(result);
      }

      return result;
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 }
  );
}

async function queueSearchIndexUpdates(affected: AffectedIds) {
  const { modelIds, postIds } = affected;

  if (modelIds.length > 0) {
    await modelsSearchIndex.queueUpdate(
      modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
  }

  let imagesReindexed = 0;
  if (postIds.length > 0) {
    // Reindex images on clamped/restored posts — publishedAt feeds the
    // sort/filter keys on Image docs (publishedAtUnix). Chunk so a huge
    // posts table doesn't blow out a single search-index batch.
    for (const batch of chunk(postIds, 500)) {
      const images = await dbWrite.image.findMany({
        where: { postId: { in: batch } },
        select: { id: true },
      });
      if (images.length === 0) continue;
      const updates = images.map((i) => ({
        id: i.id,
        action: SearchIndexUpdateQueueAction.Update,
      }));
      await imagesSearchIndex.queueUpdate(updates);
      await imagesMetricsSearchIndex.queueUpdate(updates);
      imagesReindexed += images.length;
    }
  }

  return { modelsReindexed: modelIds.length, imagesReindexed };
}

async function refreshCaches(affected: AffectedIds) {
  const { modelIds, versionIds } = affected;

  // Version busts first so we can derive which parent modelIds already get
  // their dataForModelsCache refreshed transitively (bustMvCache calls
  // dataForModelsCache.refresh for each (version, parentModelId) pair it
  // receives).
  let modelsCoveredByVersionBust = new Set<number>();
  if (versionIds.length > 0) {
    const versionRows = await dbWrite.modelVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, modelId: true },
    });
    modelsCoveredByVersionBust = new Set(versionRows.map((v) => v.modelId));
    const tasks = versionRows.map((v) => async () => bustMvCache(v.id, v.modelId));
    await limitConcurrency(tasks, 10);
  }

  // Only refresh dataForModelsCache for models NOT already covered above.
  // In practice this is just op4_models (Draft models with no versions) —
  // the rest of the modelIds overlap with versionModelIds and would
  // duplicate the refreshes bustMvCache just did.
  const modelsToRefresh = modelIds.filter((id) => !modelsCoveredByVersionBust.has(id));
  if (modelsToRefresh.length > 0) {
    const tasks = modelsToRefresh.map((id) => async () => dataForModelsCache.refresh(id));
    await limitConcurrency(tasks, 10);
  }
}

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: z.treeifyError(parsed.error) });
  }
  const { dryRun, action, modelIds } = parsed.data;

  const scopeDesc = modelIds.length > 0 ? `modelIds=[${modelIds.join(',')}]` : 'scope=global';
  console.log(
    `[clamp-publishedat-bumps] action=${action} dryRun=${dryRun} ${scopeDesc} starting`
  );
  const startTime = Date.now();

  let ops: Ops | RollbackOps;
  let affected: AffectedIds;
  try {
    const result =
      action === 'apply'
        ? await runApply(dryRun, modelIds)
        : await runRollback(dryRun, modelIds);
    ops = result.ops;
    affected = result.affected;
  } catch (error) {
    if (error instanceof DryRunRollback) {
      const dbDurationSec = Number(((Date.now() - startTime) / 1000).toFixed(2));
      console.log(
        `[clamp-publishedat-bumps] action=${action} dry-run complete duration=${dbDurationSec}s`
      );
      return res.status(200).json({
        action,
        dryRun: true,
        dbDurationSec,
        ops: error.payload.ops,
        affectedCounts: {
          models: error.payload.affected.modelIds.length,
          versions: error.payload.affected.versionIds.length,
          posts: error.payload.affected.postIds.length,
        },
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[clamp-publishedat-bumps] action=${action} tx failed: ${message}`);
    return res.status(500).json({ error: message });
  }

  const dbDurationSec = Number(((Date.now() - startTime) / 1000).toFixed(2));
  console.log(
    `[clamp-publishedat-bumps] action=${action} tx committed duration=${dbDurationSec}s ` +
      `models=${affected.modelIds.length} versions=${affected.versionIds.length} ` +
      `posts=${affected.postIds.length}`
  );

  const sideEffectsStart = Date.now();
  const { modelsReindexed, imagesReindexed } = await queueSearchIndexUpdates(affected);
  await refreshCaches(affected);
  const sideEffectsDurationSec = Number(((Date.now() - sideEffectsStart) / 1000).toFixed(2));

  return res.status(200).json({
    action,
    dryRun: false,
    dbDurationSec,
    sideEffectsDurationSec,
    ops,
    sideEffects: {
      modelsReindexed,
      imagesReindexed,
      modelCachesRefreshed: affected.modelIds.length,
      versionCachesRefreshed: affected.versionIds.length,
      postsTouched: affected.postIds.length,
    },
  });
});
