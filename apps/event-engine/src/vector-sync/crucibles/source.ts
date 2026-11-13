import type { Pool } from 'pg';
import { normalizeTitle, nsfwLevels } from '../models/document';
import { crucibleDocument } from './document';

/**
 * Which crucibles get a point: the site's `crucibleSemanticEligibleWhere`
 * (crucible-visibility.sql.ts) as SQL. The site's crucible-eligibility parity test runs both
 * against one database and fails when they keep different crucibles, so a change to either has
 * to change both. The viewer's levels, textNsfw and the green-site gate are carried in the
 * payload and filtered per query.
 */
export const CRUCIBLE_ELIGIBLE_SQL = `c.ingestion = 'Scanned' AND i.ingestion = 'Scanned'
  AND c.status <> 'Cancelled' AND c."takenDownAt" IS NULL`;

export type CruciblePayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The embedded document, for phrase filters. */
  search_text: string;
  name: string;
  /** Pending, Active or Completed. */
  status: string;
  /** image or video. */
  contentType: string;
  /** The set bits of Crucible.nsfwLevel. */
  nsfwLevel: number[];
  /** The set bits of the cover image's nsfwLevel: the feed requires both to meet the viewer's. */
  coverNsfwLevel: number[];
  /** The text scan found the name or description adult. */
  textNsfw: boolean;
  buzzType: string;
  userId: number;
  username: string | null;
  imageId: number;
  /** sha256 of search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Set on write, see withPayloadHash. */
  payloadHash?: string;
};

type Row = {
  id: number;
  name: string;
  description: string | null;
  status: string;
  contentType: string;
  nsfwLevel: number;
  coverNsfwLevel: number;
  textNsfw: boolean;
  buzzType: string;
  userId: number;
  username: string | null;
  imageId: number;
};

/** The payloads of the eligible crucibles among `ids`; an id missing from the map gets no point. */
export async function getCrucibleDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, CruciblePayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT c.id, c.name, left(c.description, 20000) AS description, c.status::text AS status,
       c."contentType"::text AS "contentType", c."nsfwLevel", i."nsfwLevel" AS "coverNsfwLevel",
       c."textNsfw", c."buzzType", c."userId", u.username, c."imageId"
     FROM "Crucible" c
     JOIN "Image" i ON i.id = c."imageId"
     LEFT JOIN "User" u ON u.id = c."userId"
     WHERE c.id = ANY($1::int[]) AND ${CRUCIBLE_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, CruciblePayload>();
  for (const row of rows) {
    const { text, docHash } = crucibleDocument(row);
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.name),
      search_text: text,
      name: row.name,
      status: row.status,
      contentType: row.contentType,
      nsfwLevel: nsfwLevels(row.nsfwLevel),
      coverNsfwLevel: nsfwLevels(row.coverNsfwLevel),
      textNsfw: row.textNsfw,
      buzzType: row.buzzType,
      userId: row.userId,
      username: row.username,
      imageId: row.imageId,
      docHash,
    });
  }
  return docs;
}
