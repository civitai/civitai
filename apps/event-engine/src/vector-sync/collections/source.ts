import type { Pool } from 'pg';
import { normalizeTitle, nsfwLevels } from '../models/document';
import { collectionDocument } from './document';

/**
 * Which collections get a point: the site's `collectionSemanticEligibleWhere`
 * (collection-visibility.sql.ts) as SQL. The site's collection-eligibility parity test runs both
 * against one database and fails when they keep different collections, so a change to either has
 * to change both. Level 0 is a collection whose level job has not run yet: it gets a point once it
 * is rated.
 */
export const COLLECTION_ELIGIBLE_SQL = `c.read = 'Public' AND c.availability NOT IN ('Unsearchable', 'Private')
  AND c."userId" <> -1 AND c."nsfwLevel" <> 0
  AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."collectionId" = c.id)`;

export type CollectionPayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The embedded document, for phrase filters. */
  search_text: string;
  name: string;
  /** Model, Article, Post, Image or Model3D; null for a mixed collection. */
  type: string | null;
  /** Contest or Bookmark; null for an ordinary collection. */
  mode: string | null;
  /** The set bits of Collection.nsfwLevel. */
  nsfwLevel: number[];
  userId: number;
  username: string | null;
  imageId: number | null;
  /** sha256 of search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Set on write, see withPayloadHash. */
  payloadHash?: string;
};

type Row = {
  id: number;
  name: string;
  description: string | null;
  type: string | null;
  mode: string | null;
  nsfwLevel: number;
  userId: number;
  username: string | null;
  imageId: number | null;
};

/** The payloads of the eligible collections among `ids`; an id missing from the map gets no point. */
export async function getCollectionDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, CollectionPayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT c.id, c.name, left(c.description, 20000) AS description, c.type::text AS type,
       c.mode::text AS mode, c."nsfwLevel", c."userId", u.username, c."imageId"
     FROM "Collection" c
     JOIN "User" u ON u.id = c."userId"
     WHERE c.id = ANY($1::int[]) AND ${COLLECTION_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, CollectionPayload>();
  for (const row of rows) {
    const { text, docHash } = collectionDocument(row);
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.name),
      search_text: text,
      name: row.name,
      type: row.type,
      mode: row.mode,
      nsfwLevel: nsfwLevels(row.nsfwLevel),
      userId: row.userId,
      username: row.username,
      imageId: row.imageId,
      docHash,
    });
  }
  return docs;
}
