import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonObjectFrom, toJson } from './infra/helpers';
import { keepUpdatedAt } from './infra/updated-at-plugin';

// Enums derived from the schema so this module needs no separate enum import.
type ModelFlagStatusValue = Selectable<DB['ModelFlag']>['status'];
type ModelStatusValue = Selectable<DB['Model']>['status'];

// The scan-result flag booleans that decide whether a model is flagged. `poiName` is a boolean flag here (the
// `ModelFlag.poiName` column is a boolean), distinct from the model's textual poi name. `sfwOnly` still
// participates in the flagged decision, but is NOT written: the live `ModelFlag` table has no `sfwOnly` column
// (the Prisma schema / generated kysely types declare it, but that migration isn't applied to the DB — the
// source's raw upsert also mis-referenced it via broken SQL). Add the column write back once the column exists.
export type ModelScanResultFlags = {
  poi: boolean;
  nsfw: boolean;
  minor: boolean;
  triggerWords: boolean;
  poiName: boolean;
  sfwOnly?: boolean;
};

// Upsert a model's flag row keyed by modelId: any true flag (re)opens it as Pending. Returns null WITHOUT
// touching the DB when nothing is flagged — the caller-side reward/notify logic stays out. Faithful port of the
// raw `INSERT … ON CONFLICT ("modelId") DO UPDATE` (the source's raw SQL had missing commas; corrected here so
// every scanned column round-trips).
export async function upsertModelFlag(
  db: Kysely<DB>,
  input: { modelId: number; scanResult?: ModelScanResultFlags; details?: object }
) {
  const { modelId, scanResult, details } = input;
  const isFlagged = scanResult && Object.values(scanResult).some((flag) => flag);
  if (!isFlagged) return null;

  return db
    .insertInto('ModelFlag')
    .values({
      modelId,
      poi: scanResult?.poi ?? false,
      nsfw: scanResult?.nsfw ?? false,
      minor: scanResult?.minor ?? false,
      triggerWords: scanResult?.triggerWords ?? false,
      poiName: scanResult?.poiName ?? false,
      status: 'Pending',
      details: details ? toJson(details) : null,
    })
    .onConflict((oc) =>
      oc.column('modelId').doUpdateSet((eb) => ({
        poi: eb.ref('excluded.poi'),
        nsfw: eb.ref('excluded.nsfw'),
        minor: eb.ref('excluded.minor'),
        triggerWords: eb.ref('excluded.triggerWords'),
        poiName: eb.ref('excluded.poiName'),
        status: eb.ref('excluded.status'),
        details: eb.ref('excluded.details'),
      }))
    )
    .returningAll()
    .executeTakeFirst();
}

export type GetFlaggedModelsInput = {
  take?: number;
  skip?: number;
  sort?: { id: string; desc?: boolean }[];
};

// The Pending flagged-models moderation queue: each flag row plus its model's summary (nested via
// jsonObjectFrom), ordered by the caller's sort columns then createdAt desc. Returns the page items plus the
// total Pending count.
export async function getFlaggedModels(db: Kysely<DB>, input: GetFlaggedModelsInput = {}) {
  const { take, skip, sort = [] } = input;

  let itemsQuery = db
    .selectFrom('ModelFlag')
    .where('ModelFlag.status', '=', 'Pending')
    .select((eb) => [
      'ModelFlag.modelId',
      'ModelFlag.poi',
      'ModelFlag.nsfw',
      'ModelFlag.triggerWords',
      'ModelFlag.minor',
      'ModelFlag.details',
      'ModelFlag.poiName',
      'ModelFlag.createdAt',
      jsonObjectFrom(
        eb
          .selectFrom('Model')
          .select([
            'Model.id',
            'Model.name',
            'Model.description',
            'Model.nsfw',
            'Model.poi',
            'Model.minor',
            'Model.sfwOnly',
            'Model.status',
            'Model.uploadType',
            'Model.type',
          ])
          .whereRef('Model.id', '=', 'ModelFlag.modelId')
      ).as('model'),
    ]);

  for (const s of sort) itemsQuery = itemsQuery.orderBy(sql.ref(s.id), s.desc ? 'desc' : 'asc');
  itemsQuery = itemsQuery.orderBy('ModelFlag.createdAt', 'desc');
  if (take != null) itemsQuery = itemsQuery.limit(take);
  if (skip != null) itemsQuery = itemsQuery.offset(skip);

  const items = await itemsQuery.execute();

  const count = Number(
    (
      await db
        .selectFrom('ModelFlag')
        .where('status', '=', 'Pending')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirst()
    )?.count ?? 0
  );

  return { items, count };
}

// Mark the given models' flags Resolved in one statement. Guards the empty-array case (`in ()` is a Postgres
// syntax error). The moderator-activity tracking from the source stays with the caller.
export function resolveFlaggedModel(db: Kysely<DB>, ids: number[]) {
  if (!ids.length) return Promise.resolve([]);
  return db
    .updateTable('ModelFlag')
    .set({ status: 'Resolved' })
    .where('modelId', 'in', ids)
    .execute();
}

// -----------------------------------------------------------------------------
// unpublishBlockedModel — the DB write core invoked when a file's hash matches a
// blocked entry. Decomposed into per-statement db-first functions; the compose
// functions open a transaction. All caches / search-index / bid side effects are
// SKIPPED (they stay with the caller).
// -----------------------------------------------------------------------------

// The model (id + existing meta) that owns a given version — the read that seeds the unpublish meta.
export function getModelForVersion(db: Kysely<DB>, modelVersionId: number) {
  return db
    .selectFrom('ModelVersion')
    .innerJoin('Model', 'Model.id', 'ModelVersion.modelId')
    .select(['Model.id as modelId', 'Model.meta as modelMeta'])
    .where('ModelVersion.id', '=', modelVersionId)
    .executeTakeFirst();
}

// Flip the model's status + meta; RETURNs the owner so the posts write can be scoped to them.
export function setModelUnpublished(
  db: Kysely<DB>,
  input: { id: number; status: ModelStatusValue; meta: object }
) {
  return db
    .updateTable('Model')
    .set({ status: input.status, meta: toJson(input.meta) })
    .where('id', '=', input.id)
    .returning('userId')
    .executeTakeFirstOrThrow();
}

// Cascade: unpublish the model's currently-Published/Scheduled versions and stamp the same meta.
export function unpublishModelVersions(db: Kysely<DB>, input: { modelId: number; meta: object }) {
  return db
    .updateTable('ModelVersion')
    .set({ status: 'Unpublished', meta: toJson(input.meta) })
    .where('modelId', '=', input.modelId)
    .where('status', 'in', ['Published', 'Scheduled'])
    .execute();
}

// Un-publish the owner's posts for every version of the model: stamp unpublish metadata, remember the prior
// publishedAt, and null publishedAt. (`updatedAt` is intentionally NOT bumped — the source ran this as raw
// SQL, which bypasses Prisma's @updatedAt; keepUpdatedAt opts out of the plugin's auto-stamp.)
export function clearModelPublishedPosts(
  db: Kysely<DB>,
  input: { modelId: number; userId: number; unpublishedAt: string; unpublishedBy: number }
) {
  return db
    .updateTable('Post')
    .set({
      metadata: sql`"metadata" || jsonb_build_object('unpublishedAt', ${input.unpublishedAt}::text, 'unpublishedBy', ${input.unpublishedBy}::int, 'prevPublishedAt', "publishedAt")`,
      publishedAt: null,
      updatedAt: keepUpdatedAt,
    })
    .where('publishedAt', 'is not', null)
    .where('userId', '=', input.userId)
    .where('modelVersionId', 'in', (eb) =>
      eb.selectFrom('ModelVersion').select('id').where('modelId', '=', input.modelId)
    )
    .execute();
}

// Compose: unpublish a model + its versions + the owner's posts in one transaction. `reason` set → the
// violation status + reason/customMessage stamped into meta.
export function unpublishModel(
  db: Kysely<DB>,
  input: { id: number; userId: number; reason?: string; customMessage?: string; meta?: object }
) {
  return db.transaction().execute(async (trx) => {
    const unpublishedAt = new Date().toISOString();
    const updatedMeta = {
      ...(input.meta ?? {}),
      ...(input.reason
        ? { unpublishedReason: input.reason, customMessage: input.customMessage }
        : {}),
      unpublishedAt,
      unpublishedBy: input.userId,
    };
    const status: ModelStatusValue = input.reason ? 'UnpublishedViolation' : 'Unpublished';

    const model = await setModelUnpublished(trx, { id: input.id, status, meta: updatedMeta });
    await unpublishModelVersions(trx, { modelId: input.id, meta: updatedMeta });
    await clearModelPublishedPosts(trx, {
      modelId: input.id,
      userId: model.userId,
      unpublishedAt,
      unpublishedBy: input.userId,
    });
    return model;
  });
}

// Compose: unpublish the model that owns the blocked version, mirroring the source's fixed reason/message.
export async function unpublishBlockedModel(db: Kysely<DB>, modelVersionId: number) {
  const version = await getModelForVersion(db, modelVersionId);
  if (!version?.modelId) return;

  const meta = (version.modelMeta ?? {}) as object;
  return unpublishModel(db, {
    id: version.modelId,
    userId: -1,
    reason: 'duplicate',
    customMessage: 'Model has been unpublished due to matching a blocked hash',
    meta,
  });
}
