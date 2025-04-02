import { uniqBy } from 'lodash-es';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { createJob, getJobDate } from './job';
import {
  deleteTagsOnImageNew,
  insertTagsOnImageNew,
  upsertTagsOnImageNew,
} from '~/server/services/tagsOnImageNew.service';

const UPVOTE_TAG_THRESHOLD = constants.tagVoting.upvoteThreshold;
const DOWNVOTE_TAG_THRESHOLD = 0;
export const applyVotedTags = createJob('apply-voted-tags', '*/2 * * * *', async () => {
  await applyUpvotes();
  await applyDownvotes();
});

async function applyUpvotes() {
  // Get the last sent time
  // --------------------------------------------
  const [lastApplied, setLastApplied] = await getJobDate('last-tags-applied');

  // Apply tags over the threshold
  // --------------------------------------------
  const toAdd = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Apply voted tags
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      LEFT JOIN "TagsOnImageDetails" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE
          vote.vote > 0
        AND vote."createdAt" > ${lastApplied}
        AND applied."tagId" IS NULL
    ), over_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) >= ${UPVOTE_TAG_THRESHOLD}
    )
    SELECT "imageId", "tagId"
    FROM over_threshold;
  `;
  await insertTagsOnImageNew(
    toAdd.map(({ imageId, tagId }) => ({ imageId, tagId, source: 'User' }))
  );

  // Bring back disabled tag where voted by moderator
  // --------------------------------------------
  const toRestore = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Enable upvoted moderation tags if voted by mod
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImageDetails" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > ${lastApplied}
        AND applied."disabled"
        AND vote.vote > 5
    )
    SELECT "imageId", "tagId"
    FROM affected;
  `;

  await upsertTagsOnImageNew(
    toAdd.map(({ imageId, tagId }) => ({ imageId, tagId, disabled: false }))
  );

  // Get affected images to update search index, cache, and votes
  // --------------------------------------------
  const affectedImageTags = uniqBy(
    [...toAdd, ...toRestore],
    ({ imageId, tagId }) => `${imageId}-${tagId}`
  );

  // Update votes
  await dbWrite.$queryRaw`
    -- Update image tag votes
    WITH affected AS (
      SELECT
        (value ->> 'imageId')::int as "imageId",
        (value ->> 'tagId')::int as "tagId"
      FROM json_array_elements(${JSON.stringify(affectedImageTags)}::json)
    )
    UPDATE "TagsOnImageVote" SET "applied" = true
    WHERE ("imageId", "tagId") IN (SELECT "imageId", "tagId" FROM affected)
      AND vote > 0;
  `;

  // Update the last sent time
  // --------------------------------------------
  await setLastApplied();
}

async function applyDownvotes() {
  // Get the last sent time
  // --------------------------------------------
  const [lastApplied, setLastApplied] = await getJobDate('last-tags-disabled');

  // Delete tags under the threshold (not moderation)
  // --------------------------------------------
  const toDelete = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Delete downvoted tags (not moderation)
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImageDetails" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE
          vote.vote < 0
        AND vote."createdAt" > (${lastApplied} - INTERVAL '1 minute')
        AND applied."disabled" = FALSE
        AND applied."needsReview" = FALSE
        AND applied."automated" = TRUE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= ${DOWNVOTE_TAG_THRESHOLD}
    )
    SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type != 'Moderation';
  `;
  await deleteTagsOnImageNew(toDelete);

  // Disable tags under the threshold (moderation) where voted by moderator
  // --------------------------------------------
  const toDisable = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Disable downvoted moderation tags if voted by mod
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImageDetails" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE
          vote.vote < 0
        AND vote."createdAt" > (${lastApplied} - INTERVAL '1 minute')
        AND applied."disabled" = FALSE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId",
        SUM(votes.vote) "votes",
        SUM(IIF(votes.vote < -5, 1, 0)) "heavyVotes"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= 0
    )
    SELECT ut."imageId", ut."tagId"
    FROM under_threshold ut
    JOIN "Tag" t ON t.id = ut."tagId"
    WHERE t.type = 'Moderation' AND ut."heavyVotes" > 0;
  `;

  // Add "Needs Review" to tags under the threshold (moderation)
  // --------------------------------------------
  const toReview = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Send downvoted tags for review (moderation)
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImageDetails" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE
          vote.vote < 0
        AND vote."createdAt" > (${lastApplied} - INTERVAL '1 minute')
        AND applied."disabled" = FALSE
        AND applied."needsReview" = FALSE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= ${UPVOTE_TAG_THRESHOLD}
    )
    SELECT "imageId", "tagId"
    FROM under_threshold ut
    JOIN "Tag" t ON t.id = ut."tagId"
    WHERE t.type = 'Moderation';
  `;

  await upsertTagsOnImageNew([
    ...toDisable.map(({ imageId, tagId }) => ({
      imageId,
      tagId,
      disabled: true,
      needsReview: false,
    })),
    ...toReview.map(({ imageId, tagId }) => ({ imageId, tagId, needsReview: true })),
  ]);

  const affectedImageTags = uniqBy(
    [...toDelete, ...toDisable],
    ({ imageId, tagId }) => `${imageId}-${tagId}`
  );

  // Update votes
  await dbWrite.$executeRaw`
    WITH affected AS (
      SELECT
        (value ->> 'imageId')::int as "imageId",
        (value ->> 'tagId')::int as "tagId"
      FROM json_array_elements(${JSON.stringify(affectedImageTags)}::json)
    )
    UPDATE "TagsOnImageVote" SET "applied" = true
    WHERE ("imageId", "tagId") IN (SELECT "imageId", "tagId" FROM affected)
      AND vote > 0;
  `;

  // Update the last sent time
  // --------------------------------------------
  await setLastApplied();
}
