import { sql, type Kysely, type Updateable } from 'kysely';
import type { Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Column enums derived from the schema (Selectable unwraps the Generated<> wrappers) so this module needs no
// separate enum import.
type MediaTypeValue = Selectable<DB['Image']>['type'];
type ImageIngestionValue = Selectable<DB['Image']>['ingestion'];
type ComicProjectStatusValue = Selectable<DB['ComicProject']>['status'];
type ComicChapterStatusValue = Selectable<DB['ComicChapter']>['status'];

export type ComicReviewPanel = {
  id: number;
  position: number;
  chapterPosition: number;
  projectId: number;
  prompt: string | null;
  uploaded: boolean;
  imageId: number;
  imageUrl: string;
  imageType: MediaTypeValue;
  nsfwLevel: number;
  needsReview: string | null;
  tosViolation: boolean;
  ingestion: ImageIngestionValue;
  blockedFor: string | null;
  projectName: string;
  projectStatus: ComicProjectStatusValue;
  projectTosViolation: boolean;
  chapterName: string;
  chapterStatus: ComicChapterStatusValue;
  authorId: number;
  authorUsername: string | null;
  authorDeletedAt: Date | null;
  authorBannedAt: Date | null;
};

export type GetComicReviewQueueParams = {
  limit: number;
  cursor?: number;
  needsReview?: string;
  includeTosViolations?: boolean;
};

// The comics moderation queue: comic panels whose underlying Image was flagged for review (needsReview),
// hard-flagged as a TOS violation, or stuck in a non-Scanned ingestion state. A ComicPanel links to its
// chapter by (projectId, chapterPosition) — there is no chapterId column. Cursor-paged newest-first on p.id.
export async function getComicReviewQueue(
  db: Kysely<DB>,
  { limit, cursor, needsReview, includeTosViolations = true }: GetComicReviewQueueParams
): Promise<{ items: ComicReviewPanel[]; nextCursor?: number }> {
  const rows = await db
    .selectFrom('ComicPanel as p')
    .innerJoin('Image as i', 'i.id', 'p.imageId')
    .innerJoin('ComicProject as proj', 'proj.id', 'p.projectId')
    .innerJoin('ComicChapter as ch', (join) =>
      join.onRef('ch.projectId', '=', 'p.projectId').onRef('ch.position', '=', 'p.chapterPosition')
    )
    .innerJoin('User as u', 'u.id', 'proj.userId')
    .where((eb) => {
      // A panel surfaces if ANY flag is set. A specific reason narrows to just that needsReview value;
      // otherwise "any review reason" unions needsReview + non-Scanned ingestion. TOS violations are
      // unioned in on top (default) so a TOS-swept panel still shows even with needsReview cleared.
      const or = needsReview
        ? [eb('i.needsReview', '=', needsReview)]
        : [eb('i.needsReview', 'is not', null), eb('i.ingestion', '!=', 'Scanned')];
      if (includeTosViolations) or.push(eb('i.tosViolation', '=', true));
      return eb.or(or);
    })
    .$if(cursor != null, (qb) => qb.where('p.id', '<', cursor!))
    .orderBy('p.id', 'desc')
    .select([
      'p.id',
      'p.position',
      'p.chapterPosition',
      'p.projectId',
      // Panels made on-site keep the prompt in one of these; off-site uploads have none. Coalesce so a
      // generated panel always shows its prompt regardless of where it landed.
      sql<
        string | null
      >`COALESCE(NULLIF(p.prompt, ''), NULLIF(p."enhancedPrompt", ''), NULLIF(i.meta->>'prompt', ''))`.as(
        'prompt'
      ),
      sql<boolean>`(p.metadata->>'sourceImageUrl') IS NOT NULL`.as('uploaded'),
      'i.id as imageId',
      'i.url as imageUrl',
      'i.type as imageType',
      'i.nsfwLevel',
      'i.needsReview',
      'i.tosViolation',
      'i.ingestion',
      'i.blockedFor',
      'proj.name as projectName',
      'proj.status as projectStatus',
      'proj.tosViolation as projectTosViolation',
      'ch.name as chapterName',
      'ch.status as chapterStatus',
      'u.id as authorId',
      'u.username as authorUsername',
      'u.deletedAt as authorDeletedAt',
      'u.bannedAt as authorBannedAt',
    ])
    .limit(limit + 1)
    .execute();

  let nextCursor: number | undefined;
  if (rows.length > limit) nextCursor = rows.pop()?.id;
  return { items: rows as ComicReviewPanel[], nextCursor };
}

// The router's `getModReviewQueue` moderator procedure is NOT ported separately: it is the same panel review
// queue this `getComicReviewQueue` already implements (identical needsReview / non-Scanned ingestion /
// tosViolation predicate + newest-first cursor). The two differ only in result SHAPE (the router returns
// Prisma nested `image`/`chapter.project.user` objects; this returns a flat row), a caller-side projection
// choice — so adding a second query would duplicate the same SQL.

// Generic single-project update. The caller passes the id plus whichever columns to set; `updatedAt` is
// stamped automatically (ComicProject is a Prisma `@updatedAt` column with no DB trigger). Prefer this over a
// narrow single-column setter (e.g. flipping `tosViolation`); keep a named function only for a multi-column
// transition or one needing a jsonb/CASE/join expression (the nsfwLevel writes below). Returns the updated row.
export function updateComicProject(
  db: Kysely<DB>,
  input: Updateable<DB['ComicProject']> & { id: number }
) {
  const { id, ...data } = input;
  return db
    .updateTable('ComicProject')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

// Generic single-chapter update by primary-key id. ComicChapter also has a (projectId, position) compound key —
// the compound-keyed transitions (`moderatorUnpublishComicChapter`) keep their own where. `updatedAt` is
// stamped automatically (@updatedAt, no DB trigger). Returns the updated row.
export function updateComicChapter(
  db: Kysely<DB>,
  input: Updateable<DB['ComicChapter']> & { id: number }
) {
  const { id, ...data } = input;
  return db
    .updateTable('ComicChapter')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

// Mod NSFW-level stamp for a whole project: overwrite every panel Image's nsfwLevel with the chosen single-bit
// level (only rows that differ). This is the "set" half — the caller follows it with the bit_or recompute
// (updateComicNsfwLevels) to bubble the stamped image levels up to chapters + project. Raw, mirroring the
// service $executeRaw.
export async function setComicProjectNsfwLevel(
  db: Kysely<DB>,
  { id, nsfwLevel }: { id: number; nsfwLevel: number }
) {
  await sql`
    UPDATE "Image" i
    SET "nsfwLevel" = ${nsfwLevel}
    FROM "ComicPanel" p
    WHERE p."imageId" = i.id
      AND p."projectId" = ${id}
      AND i."nsfwLevel" <> ${nsfwLevel}
  `.execute(db);
}

// Same stamp scoped to a single chapter's panel images.
export async function setComicChapterNsfwLevel(
  db: Kysely<DB>,
  {
    projectId,
    chapterPosition,
    nsfwLevel,
  }: { projectId: number; chapterPosition: number; nsfwLevel: number }
) {
  await sql`
    UPDATE "Image" i
    SET "nsfwLevel" = ${nsfwLevel}
    FROM "ComicPanel" p
    WHERE p."imageId" = i.id
      AND p."projectId" = ${projectId}
      AND p."chapterPosition" = ${chapterPosition}
      AND i."nsfwLevel" <> ${nsfwLevel}
  `.execute(db);
}

// Mod unpublish of a single chapter: flip status → Draft. Keyed by the (projectId, position) compound id.
// ComicChapter.updatedAt is @updatedAt — auto-stamped by the plugin.
export function moderatorUnpublishComicChapter(
  db: Kysely<DB>,
  { projectId, chapterPosition }: { projectId: number; chapterPosition: number }
) {
  return db
    .updateTable('ComicChapter')
    .set({ status: 'Draft' })
    .where('projectId', '=', projectId)
    .where('position', '=', chapterPosition)
    .execute();
}

// Recompute each chapter's nsfwLevel as the bit_or of its panel images. LEFT JOINs so a chapter with no
// panels/images resets to 0 rather than being skipped. Ported verbatim from nsfwLevels.service; raw bypasses
// @updatedAt as the Prisma $queryRaw did. Guards the empty-array case.
export async function updateComicChapterNsfwLevels(db: Kysely<DB>, projectIds: number[]) {
  if (!projectIds.length) return;
  await sql`
    WITH level AS (
      SELECT ch."projectId", ch."position" AS "chapterPosition",
             COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
      FROM "ComicChapter" ch
      LEFT JOIN "ComicPanel" p ON p."projectId" = ch."projectId"
        AND p."chapterPosition" = ch."position"
      LEFT JOIN "Image" i ON i.id = p."imageId"
      WHERE ch."projectId" IN (${sql.join(projectIds)})
      GROUP BY ch."projectId", ch."position"
    )
    UPDATE "ComicChapter" ch
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE ch."projectId" = level."projectId"
      AND ch."position" = level."chapterPosition"
      AND ch."nsfwLevel" != level."nsfwLevel";
  `.execute(db);
}

// Recompute each project's nsfwLevel as the bit_or of its chapter levels. Ported verbatim.
export async function updateComicProjectNsfwLevels(db: Kysely<DB>, projectIds: number[]) {
  if (!projectIds.length) return;
  await sql`
    WITH level AS (
      SELECT "projectId" as id, COALESCE(bit_or("nsfwLevel"), 0) "nsfwLevel"
      FROM "ComicChapter"
      WHERE "projectId" IN (${sql.join(projectIds)})
      GROUP BY "projectId"
    )
    UPDATE "ComicProject" cp
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = cp.id AND level."nsfwLevel" != cp."nsfwLevel";
  `.execute(db);
}

// Ordered compose: chapters MUST recompute before the project, since the project bit_or's the (freshly
// updated) chapter levels — running them side-by-side lets the project read stale chapter levels and stay
// unrated. Mirrors the service helper of the same name.
export async function updateComicNsfwLevels(db: Kysely<DB>, projectIds: number[]) {
  if (!projectIds.length) return;
  await updateComicChapterNsfwLevels(db, projectIds);
  await updateComicProjectNsfwLevels(db, projectIds);
}

// Recompute the comic project(s) that own `imageId`'s panel(s). Resolves the distinct project ids from the
// panel rows, then runs the ordered recompute. Returns early when the image isn't tied to any comic panel.
export async function updateComicNsfwLevelsForImage(db: Kysely<DB>, imageId: number) {
  const panels = await db
    .selectFrom('ComicPanel')
    .select('projectId')
    .distinct()
    .where('imageId', '=', imageId)
    .execute();
  const projectIds = panels.map((p) => p.projectId);
  if (!projectIds.length) return;
  await updateComicNsfwLevels(db, projectIds);
}
