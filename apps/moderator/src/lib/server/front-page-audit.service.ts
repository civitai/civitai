import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { getModeratorDb } from './moderator-db';
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
}): Promise<{ ok: boolean; error?: string; tagNsfwLevel?: number }> {
  // The tag must be a Moderation tag — Retool trusted the client with both ids, so a forged tagId
  // wrote a vote for an unrelated tag. It must NOT also be attached to this image: requiring that
  // made the tag palette unusable, since ADDING a tag the tagger missed is the whole point of it.
  // `type = 'Moderation'` is the security property; attachment was never part of it.
  // `nsfwLevel` comes back with it because `LogNsfwLevel2` records the TAG's level as the rating, and
  // this is already the query that proves the tag is a moderation tag.
  const moderationTag = await dbRead
    .selectFrom('Tag as t')
    .select(['t.id', 't.nsfwLevel'])
    .where('t.id', '=', input.tagId)
    .where('t.type', '=', 'Moderation')
    .executeTakeFirst();
  if (!moderationTag) return { ok: false, error: 'That tag is not a moderation tag.' };

  const result = await voteOnImageTags([
    { imageId: input.imageId, tagId: input.tagId, vote: input.direction === 'up' ? 1 : -1 },
  ]);
  return result.ok
    ? { ok: true, tagNsfwLevel: moderationTag.nsfwLevel }
    : { ok: false, error: result.error };
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

/**
 * The rating this sweep is about to replace. Read BEFORE the update, because it is the whole value of
 * the audit row — `recordModActivity` stores no before/after, so without this "who changed this image
 * from X to XXX" stays answerable for the Retool era and not for ours.
 */
export async function getImageRating(imageId: number): Promise<number | null> {
  const row = await dbRead
    .selectFrom('Image')
    .select('nsfwLevel')
    .where('id', '=', imageId)
    .executeTakeFirst();
  return row?.nsfwLevel ?? null;
}

/**
 * Retool's `LogNsfwLevel` and `LogNsfwLevel2` — the rating audit trail in the moderator database's
 * `RatingChanges`, and the last two Front Page Audit writes that were never ported.
 *
 * Both are `UPDATE_OR_INSERT_BY` keyed on `imageId`, read out of the app export
 * (`retool-exports/raw/front-page-audit.json`, plugins → LogNsfwLevel / LogNsfwLevel2). Two things in
 * that export contradict what `parity-findings.md` recorded from the audit, and both matter:
 *
 *  - `LogNsfwLevel` is NOT a plain INSERT. Both writes upsert by `imageId`, so the table holds the
 *    LATEST change per image rather than a history of every change. Kept that way deliberately: it is
 *    the shape the Retool-era rows are already in, and an append-only trail is a different dataset
 *    wearing the same table.
 *  - `originalRating` is the SWEEP'S selected rating (`selectedAge.value`), not a lookup of the image's
 *    own previous level. On this page they are the same number — the sweep query is
 *    `where i.nsfwLevel = <selected>` — which is why reading the image's current level is a faithful
 *    port and not a reinterpretation.
 *
 * `updatedBy` is a NAME (Retool wrote `current_user.fullName`), matching every historical row. New rows
 * write the Civitai username, which is at least resolvable — see `moderator-db-backfill-tasks.md`.
 *
 * Best-effort, like `recordResearchRating` beside them: an audit row must not fail the moderation action
 * it describes, which has already committed by the time these run.
 */
async function upsertRatingChange(input: {
  imageId: number;
  originalRating: number;
  rating: number;
  updatedBy: string | null;
}): Promise<void> {
  try {
    const db = getModeratorDb();
    // Retool's UPDATE_OR_INSERT_BY: update the image's row, insert only when there was none. Not an
    // `ON CONFLICT` — `RatingChanges` has no unique constraint on `imageId` to conflict against.
    const updated = await db
      .updateTable('RatingChanges')
      .set({
        originalRating: input.originalRating,
        rating: input.rating,
        updatedBy: input.updatedBy,
      })
      .where('imageId', '=', input.imageId)
      .executeTakeFirst();

    if (Number(updated.numUpdatedRows ?? 0) > 0) return;

    await db
      .insertInto('RatingChanges')
      .values({
        imageId: input.imageId,
        originalRating: input.originalRating,
        rating: input.rating,
        updatedBy: input.updatedBy,
      })
      .execute();
  } catch (e) {
    console.error('[front-page-audit] rating change not logged', e);
  }
}

/** `LogNsfwLevel` — a moderator setting the rating. `rating` is the level set. */
export const recordRatingChange = upsertRatingChange;

/**
 * `LogNsfwLevel2` — a moderator voting a moderation tag ONTO an image. The rating recorded is the
 * TAG's own `nsfwLevel`, i.e. what the tag would make the image, not what the image is.
 *
 * Additions only: Retool disabled this write when the vote was a downvote
 * (`queryDisabled: voteParams.vote === -10`), so removing a tag records nothing. The caller passes the
 * direction rather than filtering, so that rule stays here with the write it belongs to.
 */
export async function recordTagVoteRatingChange(input: {
  imageId: number;
  originalRating: number;
  tagNsfwLevel: number | null;
  direction: 'up' | 'down';
  updatedBy: string | null;
}): Promise<void> {
  if (input.direction !== 'up') return;
  // A tag with no level of its own says nothing about what the image should be rated.
  if (input.tagNsfwLevel === null) return;
  await upsertRatingChange({
    imageId: input.imageId,
    originalRating: input.originalRating,
    rating: input.tagNsfwLevel,
    updatedBy: input.updatedBy,
  });
}
