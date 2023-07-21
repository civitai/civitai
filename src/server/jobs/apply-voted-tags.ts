import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

const UPVOTE_TAG_THRESHOLD = 3;
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
  await dbWrite.$executeRaw`
    -- Apply voted tags
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      LEFT JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > ${lastApplied} AND applied."tagId" IS NULL
    ), over_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) >= ${UPVOTE_TAG_THRESHOLD}
    )
    INSERT INTO "TagsOnImage"("tagId", "imageId")
    SELECT
      "tagId",
      "imageId"
    FROM over_threshold
    ON CONFLICT ("tagId", "imageId") DO NOTHING;
  `;

  // Bring back disabled tag where voted by moderator
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Enable upvoted moderation tags if voted by mod
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > ${lastApplied}
        AND applied.disabled
        AND vote.vote > 5
    )
    UPDATE "TagsOnImage" SET "disabled" = false, "disabledAt" = null
    WHERE ("tagId", "imageId") IN (
      SELECT "tagId", "imageId" FROM affected
    );
  `;

  // Update NSFW baseline
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Update NSFW baseline
    WITH to_update AS (
      SELECT array_agg(i.id) ids
      FROM "Image" i
      -- if any moderation tags were applied since last run
      WHERE EXISTS (
        SELECT 1 FROM "TagsOnImage" toi
        JOIN "Tag" t ON t.id = toi."tagId" AND t.type = 'Moderation'
        WHERE
          NOT toi.disabled
          AND toi."imageId" = i.id
          AND toi."createdAt" > ${lastApplied}
      )
    )
    SELECT update_nsfw_levels(ids)
    FROM to_update;
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
  await dbWrite.$executeRaw`
    -- Delete downvoted tags (not moderation)
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > (${lastApplied} - INTERVAL '1 minute') AND applied."disabled" = FALSE AND applied."needsReview" = FALSE AND applied."automated" = TRUE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= ${DOWNVOTE_TAG_THRESHOLD}
    )
    DELETE FROM "TagsOnImage" WHERE ("tagId", "imageId") IN (
      SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type != 'Moderation'
    );
  `;

  // Disable tags under the threshold (moderation) where voted by moderator
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Disable downvoted moderation tags if voted by mod
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > (${lastApplied} - INTERVAL '1 minute') AND applied."disabled" = FALSE
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
    UPDATE "TagsOnImage" SET "disabled" = true, "needsReview" = false, "disabledAt" = NOW()
    WHERE ("tagId", "imageId") IN (
      SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type = 'Moderation' AND ut."heavyVotes" > 0
    );
  `;

  // Add "Needs Review" to tags under the threshold (moderation)
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Send downvoted tags for review (moderation)
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > (${lastApplied} - INTERVAL '1 minute') AND applied."disabled" = FALSE AND applied."needsReview" = FALSE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= ${UPVOTE_TAG_THRESHOLD}
    )
    UPDATE "TagsOnImage" SET "needsReview" = TRUE WHERE ("tagId", "imageId") IN (
      SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type = 'Moderation'
    );
  `;

  // Update NSFW baseline
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Remove NSFW if no longer tagged
    WITH to_update AS (
      SELECT array_agg(i.id) ids
      FROM "Image" i
      WHERE nsfw != 'None'
      -- If any moderation tags were disabled since last run, update
      AND EXISTS (
        SELECT 1 FROM "TagsOnImage" toi
        JOIN "Tag" t ON t.id = toi."tagId"
        WHERE
          toi.disabled AND t.type = 'Moderation' AND toi."imageId" = i.id
          AND toi."disabledAt" > ${lastApplied}
      )
      -- And there aren't any remaining moderation tags
      AND NOT EXISTS (
        SELECT 1 FROM "TagsOnImage" toi
        JOIN "Tag" t ON t.id = toi."tagId"
        WHERE
          toi.disabled = FALSE AND t.type = 'Moderation' AND toi."imageId" = i.id
      )
    )
    SELECT update_nsfw_levels(ids)
    FROM to_update;
  `;

  // Update the last sent time
  // --------------------------------------------
  await setLastApplied();
}
