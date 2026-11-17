import type { Pool } from 'pg';
import { heldUserSql } from '../held';
import { normalizeTitle, nsfwLevels } from '../models/document';
import { bountyDocument } from './document';

/** NsfwLevel.Blocked: a level that blocks on its own. */
const BLOCKED = 32;
/** NsfwLevel.XXX: the level the bounty feed serves a bounty marked nsfw at. */
const XXX = 16;

/**
 * Which bounties get a point: the site's `bountySemanticEligibleText`
 * (semantic-bounty-eligibility.ts) as SQL. The site's bounty-eligibility parity test runs both against
 * one database and fails when they keep different bounties, so a change to either has to change
 * both. Open, expired and awarded depend on the clock, so the dates and flags they are computed
 * from are carried in the payload and filtered per query. Level 0 is a bounty whose level job has
 * not run yet: it gets a point once it is rated. A takedown or an owner-removal sets Private (and the
 * latter clears userId). No image id is stored: the site checks images at hydration.
 */
export const BOUNTY_ELIGIBLE_SQL = `b."userId" IS NOT NULL AND b."userId" <> -1
  AND b.availability NOT IN ('Unsearchable', 'Private') AND NOT b.poi
  AND b."nsfwLevel" <> 0 AND (b."nsfwLevel" & ${BLOCKED}) = 0
  AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND NOT ${heldUserSql('b."userId"')}`;

export type BountyPayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The embedded document, for phrase filters. */
  search_text: string;
  name: string;
  type: string;
  /** Individual or Split. */
  mode: string;
  /** Open or BenefactorsOnly. */
  entryMode: string;
  /** details.baseModel, the feed's base-model filter. */
  baseModel: string | null;
  /** The set bits of the level the feed serves it at: XXX when marked nsfw, else nsfwLevel. */
  nsfwLevel: number[];
  /** Midnight UTC of the bounty's dates. */
  startsAt: string;
  expiresAt: string;
  complete: boolean;
  refunded: boolean;
  hasEntries: boolean;
  userId: number;
  username: string | null;
  /** sha256 of search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Set on write, see withPayloadHash. */
  payloadHash?: string;
};

type Row = {
  id: number;
  name: string;
  description: string | null;
  type: string;
  mode: string;
  entryMode: string;
  baseModel: string | null;
  nsfwLevel: number;
  nsfw: boolean;
  startsAt: Date;
  expiresAt: Date;
  complete: boolean;
  refunded: boolean;
  hasEntries: boolean;
  userId: number;
  username: string | null;
  tags: string[] | null;
};

/** The payloads of the eligible bounties among `ids`; an id missing from the map gets no point. */
export async function getBountyDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, BountyPayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT b.id, b.name, left(b.description, 20000) AS description, b.type::text AS type,
       b.mode::text AS mode, b."entryMode"::text AS "entryMode",
       b.details->>'baseModel' AS "baseModel", b."nsfwLevel", b.nsfw,
       b."startsAt"::timestamp AT TIME ZONE 'UTC' AS "startsAt",
       b."expiresAt"::timestamp AT TIME ZONE 'UTC' AS "expiresAt",
       b.complete, b.refunded,
       EXISTS (SELECT 1 FROM "BountyEntry" be WHERE be."bountyId" = b.id) AS "hasEntries",
       b."userId", u.username,
       -- Tag.name is citext, whose array node-pg returns unparsed: cast, as models/source.ts does.
       COALESCE((SELECT array_agg(t.name::text ORDER BY t.name) FROM "TagsOnBounty" tob
          JOIN "Tag" t ON t.id = tob."tagId" WHERE tob."bountyId" = b.id), '{}') AS tags
     FROM "Bounty" b
     JOIN "User" u ON u.id = b."userId"
     WHERE b.id = ANY($1::int[]) AND ${BOUNTY_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, BountyPayload>();
  for (const row of rows) {
    const { text, docHash } = bountyDocument({ ...row, tags: row.tags ?? [] });
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.name),
      search_text: text,
      name: row.name,
      type: row.type,
      mode: row.mode,
      entryMode: row.entryMode,
      baseModel: row.baseModel,
      nsfwLevel: nsfwLevels(row.nsfw ? XXX : row.nsfwLevel),
      startsAt: new Date(row.startsAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      complete: row.complete,
      refunded: row.refunded,
      hasEntries: row.hasEntries,
      userId: row.userId,
      username: row.username,
      docHash,
    });
  }
  return docs;
}
