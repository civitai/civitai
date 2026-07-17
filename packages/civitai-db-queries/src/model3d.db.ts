import { sql, type Kysely, type SelectType, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// `Model3D.status`, derived from the schema so this module needs no separate enum import.
type Model3DStatusValue = SelectType<DB['Model3D']['status']>;

// The @unique thumbnail link from an image to its parent Model3D, for the review-card affordance.
export type Model3DRef = { id: number; name: string; status: Model3DStatusValue };

// Batched: which of these images are a Model3D's @unique thumbnail → the parent Model3D ref, keyed by
// thumbnailImageId. Guards the empty-array case (no `IN ()`).
export async function getModel3DsByThumbnailImageIds(
  db: Kysely<DB>,
  imageIds: number[]
): Promise<Record<number, Model3DRef>> {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return {};

  const rows = await db
    .selectFrom('Model3D')
    .select(['id', 'name', 'status', 'thumbnailImageId'])
    .where('thumbnailImageId', 'in', ids)
    .execute();

  const map: Record<number, Model3DRef> = {};
  for (const r of rows)
    if (r.thumbnailImageId != null)
      map[r.thumbnailImageId] = { id: r.id, name: r.name, status: r.status };
  return map;
}

// Generic single-Model3D update. The caller passes the id plus whichever columns to set; `updatedAt` is
// stamped automatically (Model3D is a Prisma `@updatedAt` column with no DB trigger). Prefer this over a
// narrow single-column setter; keep a named function only for a multi-column transition, one needing a
// jsonb/CASE/proc expression, or one with an extra WHERE guard (see unpublishModel3d). Returns the updated row.
export function updateModel3D(db: Kysely<DB>, input: Updateable<DB['Model3D']> & { id: number }) {
  const { id, ...data } = input;
  return db
    .updateTable('Model3D')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

// The DB write core of the moderator spoke's unpublishModel3d: flip a Model3D to Unpublished, skipping a
// deleted row so the review action can't resurrect it. The recordModActivity side-effect and the main-app
// userContentOverviewCache refresh stay with the caller.
//
// This also serves the model3d.service `unpublishModel3D` DB core (both flip status → Unpublished keyed by
// id), so a separate port is intentionally NOT added — the caller-side existence/ownership guards + cache
// refresh differ, but the SQL write is identical.
export function unpublishModel3d(db: Kysely<DB>, { id }: { id: number; userId: number }) {
  return db
    .updateTable('Model3D')
    .set({ status: 'Unpublished' })
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .execute();
}

// Soft-delete a Model3D: stamp status → Deleted plus deletedAt/deletedBy. Model3D.updatedAt is @updatedAt in
// Prisma — auto-stamped here by the plugin. The existence/ownership + idempotent already-deleted short-circuit
// and the userContentOverviewCache refresh stay with the caller.
export function deleteModel3D(db: Kysely<DB>, { id, userId }: { id: number; userId: number }) {
  return db
    .updateTable('Model3D')
    .set({ status: 'Deleted', deletedAt: new Date(), deletedBy: userId })
    .where('id', '=', id)
    .returning(['id', 'status', 'deletedAt', 'deletedBy'])
    .executeTakeFirst();
}

// Mod restore, driven by the row's CURRENT status (the caller reads + guards that only Deleted/Unpublished
// reach here): Deleted → Unpublished (clear deletedAt/deletedBy), otherwise Unpublished → Published (stamp
// publishedAt). The two-step ladder from the service lives across two calls; this applies one transition.
export function restoreModel3D(
  db: Kysely<DB>,
  { id, status }: { id: number; status: Model3DStatusValue }
) {
  const data: Updateable<DB['Model3D']> =
    status === 'Deleted'
      ? { status: 'Unpublished', deletedAt: null, deletedBy: null }
      : { status: 'Published', publishedAt: new Date() };
  return db.updateTable('Model3D').set(data).where('id', '=', id).execute();
}

// Mod nsfwLevel override — the Model3D row half. `lockedProperties` is passed in already resolved (the caller
// appends 'nsfwLevel' when locking); a lock=false call still writes the unchanged array, matching the service.
export function setModel3DNsfwLevelRow(
  db: Kysely<DB>,
  { id, nsfwLevel, lockedProperties }: { id: number; nsfwLevel: number; lockedProperties: string[] }
) {
  return db
    .updateTable('Model3D')
    .set({ nsfwLevel, lockedProperties })
    .where('id', '=', id)
    .execute();
}

// The denormalized-metric half of the override (Model3DMetric.nsfwLevel). Model3DMetric.updatedAt is a plain
// @default(now()) column, so it is intentionally NOT stamped here.
export function setModel3DMetricNsfwLevel(
  db: Kysely<DB>,
  { model3dId, nsfwLevel }: { model3dId: number; nsfwLevel: number }
) {
  return db
    .updateTable('Model3DMetric')
    .set({ nsfwLevel })
    .where('model3dId', '=', model3dId)
    .execute();
}

// Compose: apply the override to both the Model3D row and its denormalized Model3DMetric copy atomically. The
// existence lookup, lockedProperties resolution, and cache refresh stay with the caller.
export function setModel3DNsfwLevel(
  db: Kysely<DB>,
  input: { id: number; nsfwLevel: number; lockedProperties: string[] }
) {
  return db.transaction().execute(async (trx) => {
    await setModel3DNsfwLevelRow(trx, input);
    await setModel3DMetricNsfwLevel(trx, { model3dId: input.id, nsfwLevel: input.nsfwLevel });
  });
}

// The moderation flags a mod can flip on a Model3D. Each flip auto-locks the field (appends it to
// lockedProperties) so a later non-mod upsert can't override the decision.
export type ToggleableModel3DFlagField = 'tosViolation' | 'poi' | 'minor' | 'nsfw' | 'unlisted';

// Set one boolean moderation flag to `value` and write the resolved `lockedProperties` (caller appends
// `field`). The next-value + lock computation stays with the caller (it reads the current row).
export function toggleModel3DFlag(
  db: Kysely<DB>,
  {
    id,
    field,
    value,
    lockedProperties,
  }: { id: number; field: ToggleableModel3DFlagField; value: boolean; lockedProperties: string[] }
) {
  const data: Updateable<DB['Model3D']> = { lockedProperties };
  data[field] = value;
  return db.updateTable('Model3D').set(data).where('id', '=', id).execute();
}

// Recompute Model3D.nsfwLevel (and its denormalized Model3DMetric copy) from the single thumbnail Image, for
// the given ids. Rows whose nsfwLevel a mod locked are excluded at the CTE level so both branches skip them.
// Ported verbatim from nsfwLevels.service `updateModel3DNsfwLevels` — raw SQL bypasses @updatedAt exactly as
// the Prisma $queryRaw did. Guards the empty-array case.
export async function updateModel3DNsfwLevels(db: Kysely<DB>, model3dIds: number[]) {
  if (!model3dIds.length) return;
  await sql`
    WITH level AS (
      SELECT
        m.id,
        COALESCE(i."nsfwLevel", 0) AS "nsfwLevel"
      FROM "Model3D" m
      LEFT JOIN "Image" i ON i.id = m."thumbnailImageId"
      WHERE m.id IN (${sql.join(model3dIds)})
        AND NOT ('nsfwLevel' = ANY(m."lockedProperties"))
    ), model_update AS (
      UPDATE "Model3D" m
      SET "nsfwLevel" = level."nsfwLevel"
      FROM level
      WHERE level.id = m.id AND level."nsfwLevel" != m."nsfwLevel"
      RETURNING m.id
    )
    UPDATE "Model3DMetric" mm
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE mm."model3dId" = level.id AND mm."nsfwLevel" != level."nsfwLevel"
    RETURNING mm."model3dId" AS id;
  `.execute(db);
}

// The scan/mod-path variant: recompute every Model3D whose @unique thumbnail IS this image, in one statement.
// The service read the ids then delegated to updateModel3DNsfwLevels; scoping the CTE directly on
// thumbnailImageId collapses that to a single round-trip. The service's `postId != null` short-circuit is a
// caller-side concern (a Model3D thumbnail is never a posted image) and is dropped from the pure core.
export async function updateModel3DNsfwLevelForThumbnailImage(db: Kysely<DB>, imageId: number) {
  await sql`
    WITH level AS (
      SELECT
        m.id,
        COALESCE(i."nsfwLevel", 0) AS "nsfwLevel"
      FROM "Model3D" m
      LEFT JOIN "Image" i ON i.id = m."thumbnailImageId"
      WHERE m."thumbnailImageId" = ${imageId}
        AND NOT ('nsfwLevel' = ANY(m."lockedProperties"))
    ), model_update AS (
      UPDATE "Model3D" m
      SET "nsfwLevel" = level."nsfwLevel"
      FROM level
      WHERE level.id = m.id AND level."nsfwLevel" != m."nsfwLevel"
      RETURNING m.id
    )
    UPDATE "Model3DMetric" mm
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE mm."model3dId" = level.id AND mm."nsfwLevel" != level."nsfwLevel"
    RETURNING mm."model3dId" AS id;
  `.execute(db);
}
