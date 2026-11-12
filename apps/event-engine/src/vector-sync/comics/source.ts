import type { Pool } from 'pg';
import { normalizeTitle } from '../models/document';
import { comicDocument } from './document';

/**
 * Which comics get a point: the site's `comicSearchEligibleWhere` (comics.search-index.ts) as SQL.
 * The site's comic-eligibility parity test runs both against one database and fails when they keep
 * different comics, so a change to either has to change both. ComicProject has no availability or
 * unlisted column; the owner-not-banned clause is already part of the rule.
 */
export const COMIC_ELIGIBLE_SQL = `cp."status" = 'Active' AND cp."tosViolation" = FALSE AND cp."userId" != -1
  AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = cp."userId" AND u."bannedAt" IS NULL)
  AND EXISTS (
    SELECT 1 FROM "ComicChapter" cc
    WHERE cc."projectId" = cp.id AND cc."status" = 'Published'
    AND EXISTS (
      SELECT 1 FROM "ComicPanel" cpn JOIN "Image" i ON i.id = cpn."imageId"
      WHERE cpn."projectId" = cc."projectId" AND cpn."chapterPosition" = cc."position"
      AND cpn."status" = 'Ready' AND cpn."imageUrl" IS NOT NULL
      AND i."ingestion" = 'Scanned' AND i."needsReview" IS NULL AND i."tosViolation" = FALSE
    )
    AND NOT EXISTS (
      SELECT 1 FROM "ComicPanel" cpn LEFT JOIN "Image" i ON i.id = cpn."imageId"
      WHERE cpn."projectId" = cc."projectId" AND cpn."chapterPosition" = cc."position"
      AND cpn."status" = 'Ready'
      AND (i.id IS NULL OR i."ingestion" != 'Scanned' OR i."needsReview" IS NOT NULL
        OR i."tosViolation" = TRUE)
    )
  )`;

export type ComicPayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The embedded document, for phrase filters. */
  search_text: string;
  name: string;
  genre: string | null;
  /**
   * ComicProject.nsfwLevel as stored: the bitwise OR of its chapters' levels, 0 while unrated.
   * Kept whole because the comic feed shows a comic only when every one of its bits is within the
   * viewer's browsing level (and always shows 0); a per-bit list would allow any overlap.
   */
  nsfwLevel: number;
  updatedAt: string;
  userId: number;
  username: string | null;
  coverImageId: number | null;
  /** sha256 of search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Set on write, see withPayloadHash. */
  payloadHash?: string;
};

type Row = {
  id: number;
  name: string;
  description: string | null;
  genre: string | null;
  nsfwLevel: number;
  updatedAt: Date;
  userId: number;
  username: string | null;
  coverImageId: number | null;
};

/** The payloads of the eligible comics among `ids`; an id missing from the map gets no point. */
export async function getComicDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, ComicPayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT cp.id, cp.name, left(cp.description, 20000) AS description, cp.genre::text AS genre,
       cp."nsfwLevel", cp."updatedAt", cp."userId", u.username, cp."coverImageId"
     FROM "ComicProject" cp JOIN "User" u ON u.id = cp."userId"
     WHERE cp.id = ANY($1::int[]) AND ${COMIC_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, ComicPayload>();
  for (const row of rows) {
    const { text, docHash } = comicDocument(row);
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.name),
      search_text: text,
      name: row.name,
      genre: row.genre,
      nsfwLevel: row.nsfwLevel,
      updatedAt: new Date(row.updatedAt).toISOString(),
      userId: row.userId,
      username: row.username,
      coverImageId: row.coverImageId,
      docHash,
    });
  }
  return docs;
}
