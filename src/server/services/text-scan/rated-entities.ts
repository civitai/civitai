import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  updateArticleNsfwLevels,
  updateBountyEntryNsfwLevels,
  updateBountyNsfwLevels,
  updatePostNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { maybeAutoResolveRatingDisputeAfterScan } from '~/server/services/rating-review.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { highestNsfwLevel } from '~/server/services/text-scan/evaluate';
import {
  notifyTextScanRatingRaised,
  type NotifyTextScanRatingRaisedArgs,
} from '~/server/services/text-scan/notify';
import { isTextScanRaised } from '@civitai/shared/rated-entity-sql';
import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

export type RatedEntityType = 'Article' | 'Post' | 'Bounty' | 'BountyEntry';

export type RatedEntitySnapshot = {
  nsfwLevel: number;
  moderatorNsfwLevel: number | null;
  userId: number | null;
  title: string | null;
  url: string;
};

const ratedEntities: Record<
  RatedEntityType,
  {
    recompute: (ids: number[]) => Promise<unknown>;
    read: (id: number) => Promise<RatedEntitySnapshot | null>;
  }
> = {
  Article: {
    recompute: (ids) => updateArticleNsfwLevels(ids),
    read: async (id) => {
      const row = await dbWrite.article.findUnique({
        where: { id },
        select: { nsfwLevel: true, moderatorNsfwLevel: true, userId: true, title: true },
      });
      return row && { ...row, url: `/articles/${id}` };
    },
  },
  Post: {
    recompute: (ids) => updatePostNsfwLevels(ids),
    read: async (id) => {
      const row = await dbWrite.post.findUnique({
        where: { id },
        select: { nsfwLevel: true, moderatorNsfwLevel: true, userId: true, title: true },
      });
      return row && { ...row, url: `/posts/${id}` };
    },
  },
  Bounty: {
    recompute: (ids) => updateBountyNsfwLevels(ids),
    read: async (id) => {
      const row = await dbWrite.bounty.findUnique({
        where: { id },
        select: { nsfwLevel: true, moderatorNsfwLevel: true, userId: true, name: true },
      });
      return row && { ...row, title: row.name, url: `/bounties/${id}` };
    },
  },
  BountyEntry: {
    recompute: (ids) => updateBountyEntryNsfwLevels(ids),
    read: async (id) => {
      const row = await dbWrite.bountyEntry.findUnique({
        where: { id },
        select: { nsfwLevel: true, moderatorNsfwLevel: true, userId: true, bountyId: true },
      });
      return row && { ...row, title: null, url: `/bounties/${row.bountyId}/entries/${id}` };
    },
  },
};

function ratingRose(before: number, after: number) {
  const droppedSfwBit = (before & sfwBrowsingLevelsFlag & ~after) !== 0;
  return droppedSfwBit || highestNsfwLevel(after) > highestNsfwLevel(before);
}

// A bounty's nsfw flag pins it to every NSFW bit at once, which names no level.
function noticeLevel(after: number, detectedLevel: number) {
  return after === nsfwBrowsingLevelsFlag ? detectedLevel : highestNsfwLevel(after);
}

export function readRatedEntity(entityType: RatedEntityType, entityId: number) {
  return ratedEntities[entityType].read(entityId);
}

export async function recomputeRatedEntityNsfwLevel(entityType: RatedEntityType, entityId: number) {
  await ratedEntities[entityType].recompute([entityId]);
}

// The derived level leaves an unrated post (images still 0) at 0, so a verdict that lands first sees
// no rise and sends nothing. The floor takes effect on the image scan's recompute: notify there, under
// the callback's key, so a raise the callback did tell the owner about is not resent.
export async function recomputePostNsfwLevelWithFloorNotice(
  postId: number,
  recompute: () => Promise<unknown>
) {
  const before = await ratedEntities.Post.read(postId).catch(() => null);
  await recompute();
  if (!before) return;
  // The scan's own side effects must not fail on a notice.
  await notifyIfPostFloorTookEffect(postId, before).catch((e: Error) =>
    logToAxiom({
      type: 'error',
      name: 'text-scan',
      message: 'floor notice on recompute failed',
      entityType: 'Post',
      entityId: postId,
      error: e.message,
    }).catch(() => undefined)
  );
}

async function notifyIfPostFloorTookEffect(postId: number, before: RatedEntitySnapshot) {
  if (!before.userId) return;
  const after = await ratedEntities.Post.read(postId);
  if (!after || after.moderatorNsfwLevel != null) return;
  if (!ratingRose(before.nsfwLevel, after.nsfwLevel)) return;

  const verdict = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: 'Post', entityId: postId } },
    select: { workflowId: true, nsfwLevel: true, triggeredLabels: true, result: true },
  });
  if (!verdict?.workflowId || !verdict.nsfwLevel) return;
  if (!isTextScanRaised({ entityType: 'Post', ...verdict })) return;
  const labels = verdict.triggeredLabels;
  if (!labels.includes('nsfw') || labels.includes('poi') || labels.includes('minor')) return;

  const level = highestNsfwLevel(after.nsfwLevel);
  const [{ images }] = await dbWrite.$queryRaw<{ images: number | null }[]>`
    SELECT bit_or("nsfwLevel") AS images FROM "Image" WHERE "postId" = ${postId}
  `;
  // Images that reach the floor on their own raised the post, not the text.
  if (highestNsfwLevel(images) >= level) return;

  await notifyTextScanRatingRaised({
    entityType: 'Post',
    entityId: postId,
    userId: before.userId,
    level,
    title: before.title,
    url: before.url,
    workflowId: verdict.workflowId,
  });
}

export type RatingFloorResult = { deferredRatingNotice: NotifyTextScanRatingRaisedArgs | null };

const NOTHING_DEFERRED: RatingFloorResult = { deferredRatingNotice: null };

export async function applyRatingFloor(
  entityType: RatedEntityType,
  args: ApplyTextScanArgs
): Promise<RatingFloorResult> {
  const result = await raiseToFloor(entityType, args);
  if (entityType !== 'Article')
    await maybeAutoResolveRatingDisputeAfterScan(entityType, args.entityId);
  return result;
}

async function raiseToFloor(
  entityType: RatedEntityType,
  { entityId, workflowId, outcome, ratingBefore }: ApplyTextScanArgs
): Promise<RatingFloorResult> {
  if (!outcome.nsfw) return NOTHING_DEFERRED;

  const entity = ratedEntities[entityType];
  const before = ratingBefore !== undefined ? ratingBefore : await entity.read(entityId);
  if (!before) return NOTHING_DEFERRED;
  await entity.recompute([entityId]);

  if (!outcome.nsfw.raised || before.moderatorNsfwLevel != null || !before.userId)
    return NOTHING_DEFERRED;
  const after = await entity.read(entityId);
  if (!after || !ratingRose(before.nsfwLevel, after.nsfwLevel)) return NOTHING_DEFERRED;

  const notice: NotifyTextScanRatingRaisedArgs = {
    entityType,
    entityId,
    userId: before.userId,
    level: noticeLevel(after.nsfwLevel, outcome.nsfw.detectedLevel),
    title: before.title,
    url: before.url,
    workflowId,
  };
  if (outcome.poi?.detected || outcome.minor?.detected) return { deferredRatingNotice: notice };
  await notifyTextScanRatingRaised(notice);
  return NOTHING_DEFERRED;
}
