import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonArrayFrom, jsonObjectFrom, toJson } from './infra/helpers';
import { keepUpdatedAt } from './infra/updated-at-plugin';

// Enum/column value types derived from the schema (Selectable unwraps the Generated<> wrappers) so this
// module needs no separate enum import and no main-app type import.
type ModelStatusValue = Selectable<DB['Model']>['status'];

// nsfwBrowsingLevelsArray = [R, X, XXX, Blocked] = 4 | 8 | 16 | 32. Inlined (was `nsfwBrowsingLevelsFlag`
// from the shared browsing-level constants) so this module carries no shared-enum runtime dependency.
const nsfwBrowsingLevelsFlag = 4 | 8 | 16 | 32;

// The version statuses a model→versions cascade transitions away from (publish-visible states).
const PUBLISH_VISIBLE_STATUSES: ModelStatusValue[] = ['Published', 'Scheduled'];

// Generic single-model update. The caller passes the id plus whichever columns to set; `updatedAt` is stamped
// automatically (Model is a Prisma `@updatedAt` column with no DB trigger). Prefer this over a narrow
// single-column setter (e.g. flipping `locked`); keep a named function only for a multi-column semantic
// transition or one that needs a jsonb/CASE/proc expression. Returns the updated row.
export function updateModel(db: Kysely<DB>, input: Updateable<DB['Model']> & { id: number }) {
  const { id, ...data } = input;
  return db
    .updateTable('Model')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

// ── Shared reads ─────────────────────────────────────────────────────────────────────────────────────────

// Every version's id + meta for a model — the non-moderator unpublish/delete guard reads this to reject a
// model that still has an early-access purchase (`meta.hadEarlyAccessPurchase`). The predicate stays with the
// caller; this is the pure read.
export function getModelVersionMetaForModel(db: Kysely<DB>, modelId: number) {
  return db
    .selectFrom('ModelVersion')
    .select(['id', 'meta'])
    .where('modelId', '=', modelId)
    .execute();
}

// All of a model's version ids (used to scope the post-unpublish cascade).
export async function getModelVersionIdsByModelId(
  db: Kysely<DB>,
  modelId: number
): Promise<number[]> {
  const rows = await db
    .selectFrom('ModelVersion')
    .select('id')
    .where('modelId', '=', modelId)
    .execute();
  return rows.map((r) => r.id);
}

// The model owner + nsfw flags, read before a version-unpublish / perma-delete cascade so the caller can scope
// the post/image queries and run its dropped side effects.
export function getModelOwner(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Model')
    .select(['id', 'userId', 'nsfw', 'nsfwLevel'])
    .where('id', '=', id)
    .executeTakeFirst();
}

// ── unpublishModelById cascade (model → versions → posts) ────────────────────────────────────────────────

// Flip the model to an unpublished status with the moderator-built meta. `updatedAt` is auto-stamped by the
// @updatedAt plugin (matching Prisma's client-side `@updatedAt`). RETURNs userId to scope the post cascade.
export function unpublishModel(
  db: Kysely<DB>,
  { id, status, meta }: { id: number; status: ModelStatusValue; meta: unknown }
) {
  return db
    .updateTable('Model')
    .set({ status, meta: toJson(meta) })
    .where('id', '=', id)
    .returning('userId')
    .executeTakeFirst();
}

// Cascade the model's publish-visible versions to an unpublished status, stamping the same meta. Mirrors the
// Prisma nested `modelVersions.updateMany`.
export function unpublishModelVersions(
  db: Kysely<DB>,
  { modelId, status, meta }: { modelId: number; status: ModelStatusValue; meta: unknown }
) {
  return db
    .updateTable('ModelVersion')
    .set({ status, meta: toJson(meta) })
    .where('modelId', '=', modelId)
    .where('status', 'in', PUBLISH_VISIBLE_STATUSES)
    .execute();
}

// Unpublish the model's published posts: merge unpublishedAt/unpublishedBy/prevPublishedAt into metadata and
// NULL out publishedAt. Guards the empty-version-array case (no `IN ()`). The source ran this as raw
// `$executeRaw` (no `@updatedAt` bump) — keepUpdatedAt preserves that.
export async function unpublishPostsForModel(
  db: Kysely<DB>,
  {
    userId,
    versionIds,
    unpublishedAt,
    unpublishedBy,
  }: { userId: number; versionIds: number[]; unpublishedAt: string; unpublishedBy: number }
) {
  if (!versionIds.length) return;
  return db
    .updateTable('Post')
    .set({
      metadata: sql`"metadata" || jsonb_build_object('unpublishedAt', ${unpublishedAt}::text, 'unpublishedBy', ${unpublishedBy}::int, 'prevPublishedAt', "publishedAt")`,
      publishedAt: null,
      updatedAt: keepUpdatedAt,
    })
    .where('publishedAt', 'is not', null)
    .where('userId', '=', userId)
    .where('modelVersionId', 'in', versionIds)
    .execute();
}

// Compose: unpublish a model and its versions/posts atomically. The reason→status mapping + meta build stay
// here; the caller owns the dropped search-index/cache/bid side effects.
export function unpublishModelById(
  db: Kysely<DB>,
  {
    id,
    reason,
    customMessage,
    meta,
    userId,
  }: {
    id: number;
    reason?: string | null;
    customMessage?: string | null;
    meta?: Record<string, unknown>;
    userId: number;
  }
) {
  return db.transaction().execute(async (trx) => {
    const unpublishedAt = new Date().toISOString();
    const updatedMeta = {
      ...meta,
      ...(reason ? { unpublishedReason: reason, customMessage } : {}),
      unpublishedAt,
      unpublishedBy: userId,
    };
    const status: ModelStatusValue = reason ? 'UnpublishedViolation' : 'Unpublished';

    const updatedModel = await unpublishModel(trx, { id, status, meta: updatedMeta });
    const ownerId = updatedModel?.userId ?? userId;
    await unpublishModelVersions(trx, { modelId: id, status: 'Unpublished', meta: updatedMeta });
    const versionIds = await getModelVersionIdsByModelId(trx, id);
    await unpublishPostsForModel(trx, {
      userId: ownerId,
      versionIds,
      unpublishedAt,
      unpublishedBy: userId,
    });

    return { id, userId: ownerId, versionIds };
  });
}

// ── deleteModelById cascade (soft delete: model → versions → posts) ──────────────────────────────────────

// Soft-delete the model: stamp deletedAt/deletedBy + Deleted status. RETURNs the fields the caller's dropped
// cache/search-index side effects use.
export function softDeleteModel(db: Kysely<DB>, { id, userId }: { id: number; userId: number }) {
  return db
    .updateTable('Model')
    .set({
      deletedAt: new Date(),
      status: 'Deleted',
      deletedBy: userId,
    })
    .where('id', '=', id)
    .returning(['id', 'userId', 'nsfwLevel'])
    .executeTakeFirst();
}

// Cascade the model's publish-visible versions to Deleted (Prisma nested `modelVersions.updateMany`).
export function softDeleteModelVersions(db: Kysely<DB>, { modelId }: { modelId: number }) {
  return db
    .updateTable('ModelVersion')
    .set({ status: 'Deleted' })
    .where('modelId', '=', modelId)
    .where('status', 'in', PUBLISH_VISIBLE_STATUSES)
    .execute();
}

// Stamp unpublishedAt/unpublishedBy into the metadata of the deleted model's published posts (leaves
// publishedAt intact, unlike the unpublish variant). Guards the empty-version-array case. Raw `$executeRaw`
// in the source (no `@updatedAt` bump) — keepUpdatedAt preserves that.
export async function unpublishPostsForDeletedModel(
  db: Kysely<DB>,
  {
    userId,
    versionIds,
    unpublishedAt,
    unpublishedBy,
  }: { userId: number; versionIds: number[]; unpublishedAt: string; unpublishedBy: number }
) {
  if (!versionIds.length) return;
  return db
    .updateTable('Post')
    .set({
      metadata: sql`"metadata" || jsonb_build_object('unpublishedAt', ${unpublishedAt}::text, 'unpublishedBy', ${unpublishedBy}::int)`,
      updatedAt: keepUpdatedAt,
    })
    .where('publishedAt', 'is not', null)
    .where('userId', '=', userId)
    .where('modelVersionId', 'in', versionIds)
    .execute();
}

// Compose: soft-delete a model + its versions and stamp its posts atomically. The caller owns the dropped
// cache/search-index/bid side effects.
export function deleteModelById(db: Kysely<DB>, { id, userId }: { id: number; userId: number }) {
  return db.transaction().execute(async (trx) => {
    const model = await softDeleteModel(trx, { id, userId });
    if (!model) return null;

    await softDeleteModelVersions(trx, { modelId: id });
    const versionIds = await getModelVersionIdsByModelId(trx, id);
    await unpublishPostsForDeletedModel(trx, {
      userId: model.userId,
      versionIds,
      unpublishedAt: new Date().toISOString(),
      unpublishedBy: userId,
    });

    return { ...model, versionIds };
  });
}

// ── restoreModelById cascade ─────────────────────────────────────────────────────────────────────────────

// Undo a soft delete on the model, deriving the restored status from publishedAt (NULL→Draft, future→
// Scheduled, else Unpublished). Ported verbatim from the raw SQL; RETURNs userId. Only affects a Deleted row.
export function restoreModel(db: Kysely<DB>, id: number) {
  return sql<{ userId: number }>`
    UPDATE "Model"
    SET "deletedAt" = NULL,
        "deletedBy" = NULL,
        "status" = CASE
          WHEN "publishedAt" IS NULL      THEN 'Draft'::"ModelStatus"
          WHEN "publishedAt" >  NOW()     THEN 'Scheduled'::"ModelStatus"
          ELSE 'Unpublished'::"ModelStatus"
        END
    WHERE id = ${id}
      AND "status" = 'Deleted'::"ModelStatus"
    RETURNING "userId"
  `.execute(db);
}

// Undo the soft delete on the model's Deleted versions, deriving each version's status the same way.
export function restoreModelVersions(db: Kysely<DB>, modelId: number) {
  return sql`
    UPDATE "ModelVersion"
    SET "status" = CASE
      WHEN "publishedAt" IS NULL  THEN 'Draft'::"ModelStatus"
      WHEN "publishedAt" >  NOW() THEN 'Scheduled'::"ModelStatus"
      ELSE 'Unpublished'::"ModelStatus"
    END
    WHERE "modelId" = ${modelId}
      AND "status" = 'Deleted'::"ModelStatus"
  `.execute(db);
}

// Compose: restore a soft-deleted model + its versions atomically. Returns null if the model was not Deleted.
export function restoreModelById(db: Kysely<DB>, id: number) {
  return db.transaction().execute(async (trx) => {
    const result = await restoreModel(trx, id);
    await restoreModelVersions(trx, id);
    const userId = result.rows[0]?.userId;
    if (userId == null) return null;
    return { id, userId };
  });
}

// ── permaDeleteModelById cascade (hard delete) ───────────────────────────────────────────────────────────

// The ModelFile URLs behind a model (via its versions), snapshotted inside the tx before the hard delete —
// the caller's dropped S3 cleanup uses them.
export async function getModelFileUrlsByModelId(
  db: Kysely<DB>,
  modelId: number
): Promise<string[]> {
  const rows = await db
    .selectFrom('ModelFile')
    .innerJoin('ModelVersion', 'ModelVersion.id', 'ModelFile.modelVersionId')
    .select('ModelFile.url')
    .where('ModelVersion.modelId', '=', modelId)
    .execute();
  return rows.map((r) => r.url);
}

// The post ids owned by `userId` for a model's versions (perma-delete scopes image/post deletes through
// these). Guards the empty-version-array case.
export async function getPostIdsForModelVersions(
  db: Kysely<DB>,
  { userId, versionIds }: { userId: number; versionIds: number[] }
): Promise<number[]> {
  if (!versionIds.length) return [];
  const rows = await db
    .selectFrom('Post')
    .select('id')
    .where('userId', '=', userId)
    .where('modelVersionId', 'in', versionIds)
    .execute();
  return rows.map((r) => r.id);
}

// The image ids under a set of posts (snapshotted before deletion for the caller's dropped image-search-index
// fan-out). Guards the empty-array case.
export async function getImageIdsByPostIds(db: Kysely<DB>, postIds: number[]): Promise<number[]> {
  if (!postIds.length) return [];
  const rows = await db.selectFrom('Image').select('id').where('postId', 'in', postIds).execute();
  return rows.map((r) => r.id);
}

// Delete the images under a set of posts. Guards the empty-array case.
export async function deleteImagesByPostIds(db: Kysely<DB>, postIds: number[]) {
  if (!postIds.length) return;
  return db.deleteFrom('Image').where('postId', 'in', postIds).execute();
}

// Delete a user's posts for a model's versions. Guards the empty-version-array case.
export async function deletePostsForModelVersions(
  db: Kysely<DB>,
  { userId, versionIds }: { userId: number; versionIds: number[] }
) {
  if (!versionIds.length) return;
  return db
    .deleteFrom('Post')
    .where('userId', '=', userId)
    .where('modelVersionId', 'in', versionIds)
    .execute();
}

// Hard-delete the model row (its versions/files/etc. cascade via FK). RETURNs id/userId for the caller.
export function deleteModel(db: Kysely<DB>, id: number) {
  return db.deleteFrom('Model').where('id', '=', id).returning(['id', 'userId']).executeTakeFirst();
}

// Compose: hard-delete a model and everything the app deletes first (its users' posts + those posts' images).
// Snapshots file urls + image ids inside the tx and returns them for the caller's dropped S3/search-index
// cleanup. Returns null (with the file-url snapshot) if the model is gone.
export function permaDeleteModelById(db: Kysely<DB>, id: number) {
  return db.transaction().execute(async (trx) => {
    const modelFileUrls = await getModelFileUrlsByModelId(trx, id);
    const model = await getModelOwner(trx, id);
    if (!model) return { deletedModel: null, imageIds: [] as number[], modelFileUrls };

    const versionIds = await getModelVersionIdsByModelId(trx, id);
    const postIds = await getPostIdsForModelVersions(trx, { userId: model.userId, versionIds });
    const imageIds = await getImageIdsByPostIds(trx, postIds);
    await deleteImagesByPostIds(trx, postIds);
    await deletePostsForModelVersions(trx, { userId: model.userId, versionIds });
    const deletedModel = await deleteModel(trx, id);

    return { deletedModel, imageIds, modelFileUrls };
  });
}

// ── Lock toggles ─────────────────────────────────────────────────────────────────────────────────────────

// Toggle the `commentsLocked` flag inside the model's jsonb meta (ported verbatim from the raw jsonb_set).
// Does NOT bump updatedAt — the source raw statement didn't; keepUpdatedAt opts out of the auto-stamp.
export function setModelCommentsLocked(
  db: Kysely<DB>,
  { id, locked }: { id: number; locked: boolean }
) {
  return db
    .updateTable('Model')
    .set({
      meta: sql`jsonb_set(meta, '{commentsLocked}', to_jsonb(${locked}::boolean))`,
      updatedAt: keepUpdatedAt,
    })
    .where('id', '=', id)
    .execute();
}

// ── Moderator model-property edits ───────────────────────────────────────────────────────────────────────

// The moderation UPDATE core behind moderator model edits (updateModelById): set only the provided
// moderation-relevant columns; `updatedAt` is auto-stamped by the @updatedAt plugin (Prisma `@updatedAt`
// parity), which also keeps the SET clause non-empty when no columns change. jsonb `meta` goes through toJson;
// `lockedProperties` is a text[] column set directly. The caller owns the dropped lag-flag / response-cache /
// count-cache side effects.
export function updateModelModerationById(
  db: Kysely<DB>,
  {
    id,
    ...fields
  }: {
    id: number;
    poi?: boolean;
    nsfw?: boolean;
    minor?: boolean;
    sfwOnly?: boolean;
    nsfwLevel?: number;
    tosViolation?: boolean;
    status?: ModelStatusValue;
    lockedProperties?: string[];
    meta?: unknown;
  }
) {
  const set: Record<string, unknown> = {};
  if (fields.poi !== undefined) set.poi = fields.poi;
  if (fields.nsfw !== undefined) set.nsfw = fields.nsfw;
  if (fields.minor !== undefined) set.minor = fields.minor;
  if (fields.sfwOnly !== undefined) set.sfwOnly = fields.sfwOnly;
  if (fields.nsfwLevel !== undefined) set.nsfwLevel = fields.nsfwLevel;
  if (fields.tosViolation !== undefined) set.tosViolation = fields.tosViolation;
  if (fields.status !== undefined) set.status = fields.status;
  if (fields.lockedProperties !== undefined) set.lockedProperties = fields.lockedProperties;
  if (fields.meta !== undefined) set.meta = toJson(fields.meta);

  return db.updateTable('Model').set(set).where('id', '=', id).executeTakeFirst();
}

// ── setModelsCategory ────────────────────────────────────────────────────────────────────────────────────

// Strip a user's models of every category tag (the DELETE half of setModelsCategory). Ported verbatim from
// the raw DELETE … USING. Guards both empty arrays (no `IN ()`).
export async function deleteModelCategories(
  db: Kysely<DB>,
  { userId, modelIds, categoryIds }: { userId: number; modelIds: number[]; categoryIds: number[] }
) {
  if (!modelIds.length || !categoryIds.length) return;
  return sql`
    DELETE
    FROM "TagsOnModels" tom
      USING "Model" m
    WHERE
        m.id = tom."modelId"
    AND m."userId" = ${userId}
    AND "modelId" IN (${sql.join(modelIds)})
    AND "tagId" IN (${sql.join(categoryIds)})
  `.execute(db);
}

// Add one category tag to a user's models (the INSERT half of setModelsCategory), ON CONFLICT DO NOTHING.
// Ported verbatim. Guards the empty-model-array case.
export async function insertModelCategory(
  db: Kysely<DB>,
  { userId, modelIds, categoryId }: { userId: number; modelIds: number[]; categoryId: number }
) {
  if (!modelIds.length) return;
  return sql`
    INSERT INTO "TagsOnModels" ("modelId", "tagId")
    SELECT
      m.id,
      ${categoryId}
    FROM "Model" m
    WHERE
        m."userId" = ${userId}
    AND m.id IN (${sql.join(modelIds)})
    ON CONFLICT ("modelId", "tagId") DO NOTHING
  `.execute(db);
}

// Compose: replace a user's models' category with `categoryId` atomically. `categoryIds` is the full set of
// category tag ids to clear (the caller resolves it from its category-tag cache — a dropped side effect).
export function setModelsCategory(
  db: Kysely<DB>,
  {
    userId,
    modelIds,
    categoryId,
    categoryIds,
  }: { userId: number; modelIds: number[]; categoryId: number; categoryIds: number[] }
) {
  return db.transaction().execute(async (trx) => {
    await deleteModelCategories(trx, { userId, modelIds, categoryIds });
    await insertModelCategory(trx, { userId, modelIds, categoryId });
  });
}

// ── unpublishModelVersionById cascade (version → posts) ──────────────────────────────────────────────────

// Flip a single version to an unpublished status with the moderator-built meta. `updatedAt` auto-stamped by
// the plugin. RETURNs id + modelId to resolve the owner + scope the post cascade.
export function unpublishModelVersion(
  db: Kysely<DB>,
  { id, status, meta }: { id: number; status: ModelStatusValue; meta: unknown }
) {
  return db
    .updateTable('ModelVersion')
    .set({ status, meta: toJson(meta) })
    .where('id', '=', id)
    .returning(['id', 'modelId'])
    .executeTakeFirst();
}

// Unpublish a single version's published posts (metadata merge + NULL publishedAt). Raw `$executeRaw` in the
// source (no `@updatedAt` bump) — keepUpdatedAt preserves that.
export function unpublishPostsForModelVersion(
  db: Kysely<DB>,
  {
    userId,
    versionId,
    unpublishedAt,
    unpublishedBy,
  }: { userId: number; versionId: number; unpublishedAt: string; unpublishedBy: number }
) {
  return db
    .updateTable('Post')
    .set({
      metadata: sql`"metadata" || jsonb_build_object('unpublishedAt', ${unpublishedAt}::text, 'unpublishedBy', ${unpublishedBy}::int, 'prevPublishedAt', "publishedAt")`,
      publishedAt: null,
      updatedAt: keepUpdatedAt,
    })
    .where('publishedAt', 'is not', null)
    .where('userId', '=', userId)
    .where('modelVersionId', '=', versionId)
    .execute();
}

// Compose: unpublish one version + its posts atomically. The caller owns the dropped search-index/cache side
// effects. Returns the version + owning model.
export function unpublishModelVersionById(
  db: Kysely<DB>,
  {
    id,
    reason,
    customMessage,
    meta,
    userId,
  }: {
    id: number;
    reason?: string | null;
    customMessage?: string | null;
    meta?: Record<string, unknown>;
    userId: number;
  }
) {
  return db.transaction().execute(async (trx) => {
    const unpublishedAt = new Date().toISOString();
    const updatedMeta = {
      ...meta,
      ...(reason ? { unpublishedReason: reason, customMessage } : {}),
      unpublishedAt,
      unpublishedBy: userId,
    };
    const status: ModelStatusValue = reason ? 'UnpublishedViolation' : 'Unpublished';

    const version = await unpublishModelVersion(trx, { id, status, meta: updatedMeta });
    if (!version) return null;

    const model = await getModelOwner(trx, version.modelId);
    if (model) {
      await unpublishPostsForModelVersion(trx, {
        userId: model.userId,
        versionId: version.id,
        unpublishedAt,
        unpublishedBy: userId,
      });
    }

    return { id: version.id, model };
  });
}

// ── nsfwLevels recompute (raw SQL) ───────────────────────────────────────────────────────────────────────

// Recompute Model.nsfwLevel from the bit_or of its Published versions' levels (or force the nsfw flag's
// browsing-level bits when the model is flagged nsfw). Only rewrites rows whose level actually changed.
// Ported from updateModelNsfwLevels; the search-index fan-out is the caller's. RETURNs affected ids.
export async function updateModelNsfwLevels(
  db: Kysely<DB>,
  modelIds: number[]
): Promise<{ id: number }[]> {
  if (!modelIds.length) return [];
  const result = await sql<{ id: number }>`
    WITH level AS (
      SELECT
        mv."modelId" as "id",
        bit_or(mv."nsfwLevel") "nsfwLevel"
      FROM "ModelVersion" mv
      WHERE mv."modelId" IN (${sql.join(modelIds)})
      AND mv.status = 'Published'
      GROUP BY mv."modelId"
    )
    UPDATE "Model" m
    SET "nsfwLevel" = (
      CASE
        WHEN m.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
        ELSE level."nsfwLevel"
      END
    )
    FROM level
    WHERE level.id = m.id AND (level."nsfwLevel" != m."nsfwLevel" OR m.nsfw = TRUE)
    RETURNING m.id
  `.execute(db);
  return result.rows;
}

// Recompute ModelVersion.nsfwLevel from the bit_or of its post images' levels (or force the nsfw flag's
// browsing-level bits). Ported from updateModelVersionNsfwLevels with the sysRedis kill-switch DROPPED — its
// only effect, gating the `m."userId" > 0` restriction, is now the `updateSystemNsfwLevel` param (default
// true = include system/user -1 rows). Only rewrites changed rows. RETURNs affected ids.
export async function updateModelVersionNsfwLevels(
  db: Kysely<DB>,
  {
    modelVersionIds,
    updateSystemNsfwLevel = true,
  }: { modelVersionIds: number[]; updateSystemNsfwLevel?: boolean }
): Promise<{ id: number }[]> {
  if (!modelVersionIds.length) return [];
  const result = await sql<{ id: number }>`
    WITH level as (
      SELECT
        mv.id,
        CASE
          WHEN m.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
          WHEN m."userId" != -1 THEN (
            SELECT COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
            FROM (
              SELECT
                i."nsfwLevel"
              FROM "Post" p
              JOIN "Image" i ON i."postId" = p.id
              WHERE p."modelVersionId" = mv.id
              AND p."userId" = m."userId"
              AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0 AND i."nsfwLevel" != 32
              ORDER BY p."id", i."index"
              LIMIT 20
            ) AS i
          )
        END AS "nsfwLevel"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE mv.id IN (${sql.join(modelVersionIds)})
      ${updateSystemNsfwLevel ? sql`` : sql`AND m."userId" > 0`}
    )
    UPDATE "ModelVersion" mv
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = mv.id AND level."nsfwLevel" != mv."nsfwLevel"
    RETURNING mv.id
  `.execute(db);
  return result.rows;
}

// ── getTrainingModelsForModerators ───────────────────────────────────────────────────────────────────────

export type GetTrainingModelsForModeratorsInput = {
  limit?: number;
  cursor?: number;
  username?: string;
  dateFrom?: Date;
  dateTo?: Date;
  cannotPublish?: boolean;
  workflowId?: string;
};

// The moderator training-moderation feed: trained, non-deleted models that have at least one non-purged
// "Training Data" file, newest-id first, with author + the matching versions and their training files nested
// as jsonb. Cursor-paginated by id. Ported from getTrainingModelsForModerators.
export async function getTrainingModelsForModerators(
  db: Kysely<DB>,
  input: GetTrainingModelsForModeratorsInput
) {
  const { limit = 20, cursor, username, dateFrom, dateTo, cannotPublish, workflowId } = input;

  // The per-version "has a matching Training Data file" predicate, reused by both the model-level EXISTS
  // filter and the nested version filter. `workflowId` narrows via the file metadata json path.
  const versionHasTrainingFile = (mvRef: string) =>
    sql`EXISTS (
      SELECT 1 FROM "ModelFile" mf
      WHERE mf."modelVersionId" = ${sql.ref(mvRef)}
        AND mf.type = 'Training Data'
        AND mf."dataPurged" = false
        ${
          workflowId
            ? sql`AND mf.metadata #>> '{trainingResults,workflowId}' = ${workflowId}`
            : sql``
        }
    )`;

  let query = db
    .selectFrom('Model')
    .where('Model.uploadType', '=', 'Trained')
    .where('Model.deletedAt', 'is', null)
    .where(
      sql<boolean>`EXISTS (
        SELECT 1 FROM "ModelVersion" mv
        WHERE mv."modelId" = "Model".id AND ${versionHasTrainingFile('mv.id')}
      )`
    );

  if (cursor) query = query.where('Model.id', '<', cursor);
  if (username)
    query = query.where(
      sql<boolean>`EXISTS (SELECT 1 FROM "User" u WHERE u.id = "Model"."userId" AND u.username = ${username})`
    );
  if (dateFrom) query = query.where('Model.createdAt', '>=', dateFrom);
  if (dateTo) query = query.where('Model.createdAt', '<=', dateTo);
  if (cannotPublish !== undefined)
    query = cannotPublish
      ? query.where(sql<boolean>`"Model".meta -> 'cannotPublish' = 'true'::jsonb`)
      : query.where(sql<boolean>`"Model".meta -> 'cannotPublish' IS DISTINCT FROM 'true'::jsonb`);

  const items = await query
    .select((eb) => [
      'Model.id',
      'Model.name',
      'Model.type',
      'Model.nsfw',
      'Model.poi',
      'Model.minor',
      'Model.tosViolation',
      'Model.status',
      'Model.createdAt',
      'Model.publishedAt',
      'Model.meta',
      jsonObjectFrom(
        eb
          .selectFrom('User')
          .select((eb2) => [
            'User.id',
            'User.username',
            'User.deletedAt',
            'User.image',
            jsonObjectFrom(
              eb2
                .selectFrom('Image as pp')
                .select([
                  'pp.id',
                  'pp.name',
                  'pp.url',
                  'pp.nsfwLevel',
                  'pp.hash',
                  'pp.userId',
                  'pp.ingestion',
                  'pp.type',
                  'pp.width',
                  'pp.height',
                  'pp.metadata',
                ])
                .whereRef('pp.id', '=', 'User.profilePictureId')
            ).as('profilePicture'),
          ])
          .whereRef('User.id', '=', 'Model.userId')
      ).as('user'),
      jsonArrayFrom(
        eb
          .selectFrom('ModelVersion as mv')
          .select((eb2) => [
            'mv.id',
            'mv.name',
            'mv.status',
            'mv.baseModel',
            'mv.trainingStatus',
            'mv.createdAt',
            jsonArrayFrom(
              eb2
                .selectFrom('ModelFile as mf')
                .select(['mf.id', 'mf.name', 'mf.url', 'mf.sizeKB', 'mf.createdAt', 'mf.metadata'])
                .whereRef('mf.modelVersionId', '=', 'mv.id')
                .where('mf.type', '=', 'Training Data')
                .where('mf.dataPurged', '=', false)
            ).as('files'),
          ])
          .whereRef('mv.modelId', '=', 'Model.id')
          .where(sql<boolean>`${versionHasTrainingFile('mv.id')}`)
          .orderBy('mv.createdAt', 'desc')
      ).as('modelVersions'),
    ])
    .orderBy('Model.id', 'desc')
    .limit(limit)
    .execute();

  const nextCursor = items.length > 0 ? items[items.length - 1].id : undefined;
  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// bulkUnpublishModelsForBannedUser — the raw Model/ModelVersion/Post updates, decomposed
// ---------------------------------------------------------------------------

// Read core: the user's Published/Scheduled models and their Published/Scheduled versions. The caller derives
// `modelIds` / `versionIds` from this and feeds the three write functions below.
export function getModelsToUnpublishForUser(db: Kysely<DB>, userId: number) {
  return db
    .selectFrom('Model')
    .where('Model.userId', '=', userId)
    .where('Model.status', 'in', ['Published', 'Scheduled'])
    .select((eb) => [
      'Model.id',
      jsonArrayFrom(
        eb
          .selectFrom('ModelVersion')
          .select('ModelVersion.id')
          .whereRef('ModelVersion.modelId', '=', 'Model.id')
          .where('ModelVersion.status', 'in', ['Published', 'Scheduled'])
      ).as('modelVersions'),
    ])
    .execute();
}

// The unpublished-marker object merged into Model/ModelVersion `meta` (and echoed into Post `metadata`).
export type UnpublishMeta = Record<string, unknown>;

// UPDATE the given models to UnpublishedViolation, merging `meta` (jsonb `||`). Faithful to the original raw
// SQL, which did NOT bump `updatedAt` (a raw UPDATE, not a Prisma write) — keepUpdatedAt opts out of the
// auto-stamp so we don't either.
export async function unpublishModelsForUser(
  db: Kysely<DB>,
  input: { modelIds: number[]; meta: UnpublishMeta }
) {
  if (!input.modelIds.length) return [];
  const metaJson = JSON.stringify(input.meta);
  return db
    .updateTable('Model')
    .set({
      status: 'UnpublishedViolation',
      meta: sql`COALESCE("meta", '{}'::jsonb) || ${metaJson}::jsonb`,
      updatedAt: keepUpdatedAt,
    })
    .where('id', 'in', input.modelIds)
    .execute();
}

// UPDATE the given versions to Unpublished, merging `meta` (jsonb `||`). No `updatedAt` bump (raw-SQL parity,
// via keepUpdatedAt).
export async function unpublishModelVersionsForUser(
  db: Kysely<DB>,
  input: { versionIds: number[]; meta: UnpublishMeta }
) {
  if (!input.versionIds.length) return [];
  const metaJson = JSON.stringify(input.meta);
  return db
    .updateTable('ModelVersion')
    .set({
      status: 'Unpublished',
      meta: sql`COALESCE("meta", '{}'::jsonb) || ${metaJson}::jsonb`,
      updatedAt: keepUpdatedAt,
    })
    .where('id', 'in', input.versionIds)
    .execute();
}

// Model disposition on account deletion: hard-remove (deletedAt + status=Deleted) when `removeModels`, else
// reassign to the system user (-1). Prisma `updateMany` bumps `@updatedAt` — auto-stamped here by the plugin.
export function purgeUserModels(db: Kysely<DB>, input: { userId: number; removeModels: boolean }) {
  const data = input.removeModels
    ? { deletedAt: new Date(), status: 'Deleted' as const }
    : { userId: -1 };
  return db.updateTable('Model').set(data).where('userId', '=', input.userId).execute();
}

export function deleteModelForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Model').where('userId', '=', userId).execute();
}
