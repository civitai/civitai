import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The Postgres read cores of the moderator app's image-moderation side-effect bundles
// (apps/moderator/src/lib/server/image-moderation-effects.ts). Only the pure data-gathering SELECTs are
// ported here; the search-index re-queues, redis cache busts, and ClickHouse analytics inserts those
// functions also run stay with the caller.

export type ComicProjectIdRow = { projectId: number };

// Distinct comic-project ids that contain any of the given images — the lookup queueComicsForImages uses to
// decide which comic projects to re-index. (Side effect: the per-project search-index re-queue stays with the
// caller.)
export async function listComicProjectIdsForImages(
  db: Kysely<DB>,
  imageIds: number[]
): Promise<ComicProjectIdRow[]> {
  if (!imageIds.length) return [];
  return db
    .selectFrom('ComicPanel')
    .select('projectId')
    .distinct()
    .where('imageId', 'in', imageIds)
    .execute();
}

export type PostGalleryLinkRow = {
  modelVersionId: number | null;
  modelId: number | null;
  model3dId: number | null;
};

// The model-version / model / model3d links behind each post — the rows bustPostGalleryCaches reduces into
// the gallery cache tags to bust. Dedupes + null-filters the input ids like the source. (Side effect: the
// actual cache busting stays with the caller.)
export async function listPostGalleryLinks(
  db: Kysely<DB>,
  postIds: number[]
): Promise<PostGalleryLinkRow[]> {
  const ids = [...new Set(postIds.filter((id) => id != null))];
  if (!ids.length) return [];
  return db
    .selectFrom('Post as p')
    .leftJoin('ModelVersion as mv', 'mv.id', 'p.modelVersionId')
    .select([
      'p.modelVersionId as modelVersionId',
      'mv.modelId as modelId',
      'p.model3dId as model3dId',
    ])
    .where('p.id', 'in', ids)
    .execute();
}

export type ImageTagNameRow = { name: string };

// Names of the active (non-disabled) tags on an image — the `tags` array of the DeleteTOS analytics payload.
export async function listImageTagNames(
  db: Kysely<DB>,
  imageId: number
): Promise<ImageTagNameRow[]> {
  return db
    .selectFrom('TagsOnImageDetails as toi')
    .innerJoin('Tag as t', 't.id', 'toi.tagId')
    .select('t.name')
    .where('toi.imageId', '=', imageId)
    .where('toi.disabled', '=', false)
    .execute();
}

export type ImageResourceModelVersionRow = { modelVersionId: number };

// The model-version ids of an image's resources — the `resources` array of the DeleteTOS analytics payload.
export async function listImageResourceModelVersions(
  db: Kysely<DB>,
  imageId: number
): Promise<ImageResourceModelVersionRow[]> {
  return db
    .selectFrom('ImageResourceNew')
    .select('modelVersionId')
    .where('imageId', '=', imageId)
    .execute();
}

export type ImageTosReportDetail = { violation: string | null; comment: string | null };

// The latest TOS-violation report's structured detail for an image (DISTINCT ON via LIMIT 1) — supplies the
// DeleteTOS payload's fallback violationType/violationDetails. Raw `sql` to reach the jsonb `->>` accessors on
// Report.details, preserved exactly from the source.
export async function getImageTosViolationReport(
  db: Kysely<DB>,
  imageId: number
): Promise<ImageTosReportDetail | undefined> {
  const res = await sql<ImageTosReportDetail>`
    SELECT r.details->>'violation' AS violation, r.details->>'comment' AS comment
    FROM "Report" r
    JOIN "ImageReport" ir ON ir."reportId" = r.id
    WHERE ir."imageId" = ${imageId} AND r.reason = 'TOSViolation'
    ORDER BY r."createdAt" DESC
    LIMIT 1
  `.execute(db);
  return res.rows[0];
}
