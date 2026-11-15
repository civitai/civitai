import type { Pool } from 'pg';
import { normalizeTitle, nsfwLevels } from '../models/document';
import { challengeDocument } from './document';

/**
 * Which challenges get a point: the site's `challengeSemanticEligibleWhere`
 * (challenge-visibility.sql.ts) as SQL. The site's challenge-eligibility parity test runs both
 * against one database and fails when they keep different challenges, so a change to either has
 * to change both. The rest of the feed's visibility (visibleAt, the domain-currency and
 * user-challenge gates, both browsing levels, blocks) depends on the viewer or the clock, so it is
 * carried in the payload and filtered per query.
 */
export const CHALLENGE_ELIGIBLE_SQL = `c."ingestion" = 'Scanned'
  AND c."coverImageId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND i."poi" = true)
  AND (c.source <> 'User' OR EXISTS (
    SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND i."ingestion" = 'Scanned'))
  AND c.status <> 'Cancelled'`;

export type ChallengePayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The embedded document, for phrase filters. */
  search_text: string;
  title: string;
  theme: string | null;
  status: string;
  /** System, Mod or User: the domain-currency and user-challenge gates apply to User only. */
  source: string;
  buzzType: string;
  /** The set bits of Challenge.nsfwLevel. */
  nsfwLevel: number[];
  /** The set bits of the cover image's nsfwLevel: the feed requires both to meet the viewer's. */
  coverNsfwLevel: number[];
  modelVersionIds: number[];
  eventId: number | null;
  visibleAt: string;
  /** Challenge.createdById; null for a system challenge. */
  userId: number | null;
  username: string | null;
  coverImageId: number;
  /** sha256 of search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Set on write, see withPayloadHash. */
  payloadHash?: string;
};

type Row = {
  id: number;
  title: string;
  theme: string | null;
  invitation: string | null;
  description: string | null;
  status: string;
  source: string;
  buzzType: string;
  nsfwLevel: number;
  coverNsfwLevel: number | null;
  modelVersionIds: number[];
  eventId: number | null;
  eventTitle: string | null;
  visibleAt: Date;
  userId: number | null;
  username: string | null;
  coverImageId: number;
};

/** The payloads of the eligible challenges among `ids`; an id missing from the map gets no point. */
export async function getChallengeDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, ChallengePayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT c.id, c.title, c.theme, left(c.invitation, 2000) AS invitation,
       left(c.description, 20000) AS description, c.status::text AS status,
       c.source::text AS source, c."buzzType", c."nsfwLevel", ci."nsfwLevel" AS "coverNsfwLevel",
       c."modelVersionIds", c."eventId", ce.title AS "eventTitle", c."visibleAt",
       c."createdById" AS "userId", u.username, c."coverImageId"
     FROM "Challenge" c
     LEFT JOIN "Image" ci ON ci.id = c."coverImageId"
     LEFT JOIN "ChallengeEvent" ce ON ce.id = c."eventId"
     LEFT JOIN "User" u ON u.id = c."createdById"
     WHERE c.id = ANY($1::int[]) AND ${CHALLENGE_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, ChallengePayload>();
  for (const row of rows) {
    const { text, docHash } = challengeDocument(row);
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.title),
      search_text: text,
      title: row.title,
      theme: row.theme,
      status: row.status,
      source: row.source,
      buzzType: row.buzzType,
      nsfwLevel: nsfwLevels(row.nsfwLevel),
      coverNsfwLevel: nsfwLevels(row.coverNsfwLevel ?? 0),
      modelVersionIds: row.modelVersionIds ?? [],
      eventId: row.eventId,
      visibleAt: new Date(row.visibleAt).toISOString(),
      userId: row.userId,
      username: row.username,
      coverImageId: row.coverImageId,
      docHash,
    });
  }
  return docs;
}
