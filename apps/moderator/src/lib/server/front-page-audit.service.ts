import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { voteOnImageTags } from './user-actions.service';
import type { MediaType } from '$lib/media/edge-url';

// Retool's Front Page Audit: a PROACTIVE sweep of newly scanned content at one rating, not a request
// queue. `/images/ratings` is the reactive twin — images whose rating a user disputed. Same action,
// different population.

export type SweepOrder = 'newest' | 'reactions';
export type SweepMedia = 'image' | 'video';

export type SweepImage = {
  id: number;
  url: string;
  name: string | null;
  type: MediaType;
  createdAt: Date;
  nsfwLevel: number;
  aiNsfwLevel: number | null;
  needsReview: string | null;
  poi: boolean;
  prompt: string | null;
  negativePrompt: string | null;
  moderatedTags: { id: number; name: string }[];
  isProfilePicture: boolean;
  hasConnection: boolean;
};

// Video review is slower per item, so Retool paged it 20 at a time against 200 for images.
export const SWEEP_LIMITS: Record<SweepMedia, number> = { image: 200, video: 20 };

const columns = [
  'i.id',
  'i.url',
  'i.name',
  'i.type',
  'i.createdAt',
  'i.nsfwLevel',
  'i.needsReview',
  'i.poi',
] as const;

// EXISTS rather than Retool's LEFT JOINs: an image with two ImageConnection rows came back twice
// there, doubling it in the grid.
const extras = [
  // `aiNsfwLevel` exists in production — the image-scan webhook writes it — but is absent from
  // schema.full.prisma, so it cannot be selected as a typed column. It is the scanner's own rating,
  // and disagreement with `nsfwLevel` is the strongest signal a row needs a human.
  sql<number | null>`i."aiNsfwLevel"`.as('aiNsfwLevel'),
  sql<string | null>`i."meta" ->> 'prompt'`.as('prompt'),
  sql<string | null>`i."meta" ->> 'negativePrompt'`.as('negativePrompt'),
  // Names, not just ids: a moderator cannot agree or disagree with a tag they cannot read, and voting
  // is the only way this page corrects the tagger.
  sql<{ id: number; name: string }[]>`COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.name)
    FROM "TagsOnImageDetails" toi
    JOIN "Tag" t ON toi."tagId" = t.id
    WHERE toi."imageId" = i.id AND NOT toi.disabled AND t.type = 'Moderation'
  ), '[]'::jsonb)`.as('moderatedTags'),
  sql<boolean>`EXISTS (SELECT 1 FROM "User" u WHERE u."profilePictureId" = i."id")`.as(
    'isProfilePicture'
  ),
  sql<boolean>`EXISTS (SELECT 1 FROM "ImageConnection" ic WHERE ic."imageId" = i."id")`.as(
    'hasConnection'
  ),
];

/**
 * `nsfwLevel` is the bitmask column, NOT the deprecated four-value `i.nsfw` enum. Retool's `ByReactions`
 * still filtered on `i.nsfw` while its newest views filtered on `nsfwLevel`, so the two orderings
 * disagreed about what "X" meant. Both orderings here take the same filter.
 */
export async function getSweep(input: {
  nsfwLevel: number;
  order: SweepOrder;
  media: SweepMedia;
  since: Date;
}): Promise<SweepImage[]> {
  const limit = SWEEP_LIMITS[input.media];

  let q = dbRead
    .selectFrom('Image as i')
    .select([...columns, ...extras])
    .where('i.nsfwLevel', '=', input.nsfwLevel)
    .where('i.ingestion', '=', 'Scanned')
    .where('i.nsfwLevelLocked', '=', false)
    .where('i.type', '=', input.media)
    .limit(limit);

  if (input.media === 'video') {
    // Retool applied these three to the video sweep only. A remix (`parentId`) inherits its parent's
    // rating, and an image already queued for review belongs to that queue, not to a fresh sweep.
    q = q
      .where('i.minor', '=', false)
      .where('i.needsReview', 'is', null)
      .where(sql<boolean>`i.metadata ->> 'parentId' IS NULL`);
  }

  if (input.order === 'reactions') {
    // "What is actually on the front page": published posts, ranked by weekly reactions. Expressed as
    // subqueries because `ImageRank` is a production VIEW that schema.full.prisma does not model, so
    // the builder cannot join it — and a join would row-multiply anyway.
    return (await q
      .where(
        sql<boolean>`EXISTS (
          SELECT 1 FROM "Post" p
          WHERE p.id = i."postId" AND p."publishedAt" IS NOT NULL AND p."publishedAt" < now()
        )`
      )
      .orderBy(
        sql`(SELECT ir."reactionCountWeekRank" FROM "ImageRank" ir WHERE ir."imageId" = i.id) ASC NULLS LAST`
      )
      .execute()) as SweepImage[];
  }

  // Oldest-first within the unswept window: the sweep is a queue to drain, so a moderator resumes
  // where the last one stopped rather than re-reading the newest arrivals.
  return (await q
    .where('i.createdAt', '>', input.since)
    .orderBy('i.createdAt', 'asc')
    .execute()) as SweepImage[];
}

/**
 * Goes through `/api/mod/image/tag-vote` rather than writing `TagsOnImageVote` directly.
 * That endpoint applies the moderator vote WEIGHT via the main app's `addTagVotes`/`removeTagVotes`
 * — a raw ±1 row never crosses `apply-voted-tags`' ±5 threshold, so the tag would stay on the image
 * and only pick up `needsReview`. Writing the weight by hand here would be a second copy of a number
 * that lives in the main app.
 */
export async function voteOnTag(input: {
  imageId: number;
  tagId: number;
  direction: 'up' | 'down';
}): Promise<{ ok: boolean; error?: string }> {
  // The tag must be a Moderation tag — Retool trusted the client with both ids, so a forged tagId
  // wrote a vote for an unrelated tag. It must NOT also be attached to this image: requiring that
  // made the tag palette unusable, since ADDING a tag the tagger missed is the whole point of it.
  // `type = 'Moderation'` is the security property; attachment was never part of it.
  const moderationTag = await dbRead
    .selectFrom('Tag as t')
    .select('t.id')
    .where('t.id', '=', input.tagId)
    .where('t.type', '=', 'Moderation')
    .executeTakeFirst();
  if (!moderationTag) return { ok: false, error: 'That tag is not a moderation tag.' };

  const result = await voteOnImageTags([
    { imageId: input.imageId, tagId: input.tagId, vote: input.direction === 'up' ? 1 : -1 },
  ]);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Retool's `InsertRatingGame`: every rating set on this sweep also lands in `research_ratings`, the
 * dataset behind Queue Stats' "Research ratings" board.
 *
 * Unported, this was not a silent omission — `/retool/queue-stats` renders that board directly beside
 * "Ratings set", which is `ModActivity`-backed and keeps counting. One list grew and the other could
 * not, with nothing on screen saying why.
 *
 * The upsert is Retool's, verbatim including the conflict target (`research_ratings_pkey` is
 * `(userId, imageId)`): re-rating an image REPLACES that moderator's row rather than adding a second,
 * so the board counts images judged, not judgements made. `sane` is left alone — Retool never set it.
 *
 * Best-effort by design. This is a research dataset, not the moderation record, so a failure here must
 * not fail the rating that already committed.
 */
export async function recordResearchRating(input: {
  userId: number;
  imageId: number;
  nsfwLevel: number;
}): Promise<void> {
  // Raw `sql` because the table is not in the Prisma schema and so not in the generated Kysely types —
  // the same treatment `queue-stats.service.ts` gives it on the read side.
  try {
    await sql`
      INSERT INTO "research_ratings" ("userId", "imageId", "nsfwLevel")
      VALUES (${input.userId}, ${input.imageId}, ${input.nsfwLevel})
      ON CONFLICT ("userId", "imageId") DO UPDATE SET "nsfwLevel" = EXCLUDED."nsfwLevel"
    `.execute(dbWrite);
  } catch (e) {
    console.error('[front-page-audit] research rating not recorded', e);
  }
}
