import type { Pool } from 'pg';
import { normalizeTitle, nsfwLevels } from '../models/document';
import { storylineDocument } from './document';

/** NsfwLevel.Blocked: a chapter 1 post at it, or unrated, hides the storyline. */
const BLOCKED = 32;

/**
 * The FROM clause both the eligibility and the payload read: storyline `st`, its owner `u`,
 * chapter 1 `rc`, its post `rp` and that post's author `ru`.
 */
export const STORYLINE_FROM = `"Storyline" st
  JOIN "User" u ON u.id = st."userId"
  LEFT JOIN "StorylineChapter" rc ON rc."storylineId" = st.id AND rc.depth = 0
  LEFT JOIN "Post" rp ON rp.id = rc."postId"
  LEFT JOIN "User" ru ON ru.id = rp."userId"`;

/**
 * Which storylines get a point: the site's `storylineSemanticEligibleText`
 * (storyline-visibility.sql.ts) as SQL, held to it by the site's storyline-eligibility parity test.
 * Publication time is not part of it: the payload's rootPublishedAt is filtered at query time.
 */
export const STORYLINE_ELIGIBLE_SQL = `(st."tosViolation" = false AND u."bannedAt" IS NULL
  AND u."deletedAt" IS NULL AND rp.id IS NOT NULL AND rc."removedAt" IS NULL
  AND rp."tosViolation" = false AND ru."bannedAt" IS NULL AND ru."deletedAt" IS NULL
  AND rp."nsfwLevel" NOT IN (0, ${BLOCKED}) AND rp."publishedAt" IS NOT NULL
  AND rp.availability = 'Public')`;

/**
 * The story level the feed filters on, the site's `storyLevelText`: chapter 1's post level (the
 * ceiling when unrated), raised to the title's rating. Pinned to it by the same parity test.
 */
export const STORY_LEVEL_SQL = `(SELECT CASE WHEN lv.l = 0 OR lv.f = 0 THEN lv.l
    WHEN (lv.l & ~(lv.f - 1)) = 0 THEN lv.f ELSE lv.l & ~(lv.f - 1) END
  FROM (SELECT COALESCE(NULLIF(NULLIF(rp."nsfwLevel", 0), ${BLOCKED}), st."maxNsfwLevel") AS l,
    COALESCE(st."moderatorNsfwLevel", st."nsfwLevel") AS f) lv)`;

/** Characters of chapter 1 read; the document keeps far fewer. */
const OPENING_READ_CHARS = 20_000;

export type StorylinePayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The embedded document, for phrase filters. */
  search_text: string;
  title: string;
  /** Ongoing or Complete: the feed's ongoing, complete and open filters. */
  status: string;
  /** Anyone or collaborators: the open filter; the collaborator part is per viewer. */
  whoCanContinue: string;
  /** The set bits of the story level (see STORY_LEVEL_SQL). */
  nsfwLevel: number[];
  /** Chapter 1's publication; a query keeps only points at or before now. */
  rootPublishedAt: string;
  /** Chapter 1's row, so a delete that carries only its id finds the point. */
  rootChapterId: number;
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
  title: string;
  status: string;
  whoCanContinue: string;
  level: number;
  rootPublishedAt: Date;
  rootChapterId: number;
  openingTitle: string | null;
  openingDetail: string | null;
  userId: number;
  username: string | null;
  coverImageId: number | null;
};

/** The payloads of the eligible storylines among `ids`; an id missing from the map gets no point. */
export async function getStorylineDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, StorylinePayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT st.id, st.title, st.status::text AS status, st."whoCanContinue"::text AS "whoCanContinue",
       ${STORY_LEVEL_SQL} AS level, rp."publishedAt" AS "rootPublishedAt", rc.id AS "rootChapterId",
       rp.title AS "openingTitle", left(rp.detail, ${OPENING_READ_CHARS}) AS "openingDetail",
       st."userId", u.username, st."coverImageId"
     FROM ${STORYLINE_FROM}
     WHERE st.id = ANY($1::int[]) AND ${STORYLINE_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, StorylinePayload>();
  for (const row of rows) {
    const { text, docHash } = storylineDocument({
      title: row.title,
      username: row.username,
      openingTitle: row.openingTitle,
      openingDetail: row.openingDetail,
    });
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.title),
      search_text: text,
      title: row.title,
      status: row.status,
      whoCanContinue: row.whoCanContinue,
      nsfwLevel: nsfwLevels(row.level),
      rootPublishedAt: new Date(row.rootPublishedAt).toISOString(),
      rootChapterId: row.rootChapterId,
      userId: row.userId,
      username: row.username,
      coverImageId: row.coverImageId,
      docHash,
    });
  }
  return docs;
}
