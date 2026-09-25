import { dbWrite } from '~/server/db/client';
import {
  updateArticleNsfwLevels,
  updateBountyEntryNsfwLevels,
  updateBountyNsfwLevels,
  updatePostNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { highestNsfwLevel } from '~/server/services/text-scan/evaluate';
import {
  notifyTextScanRatingRaised,
  type NotifyTextScanRatingRaisedArgs,
} from '~/server/services/text-scan/notify';
import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

export type RatedEntityType = 'Article' | 'Post' | 'Bounty' | 'BountyEntry';

type RatedRow = {
  nsfwLevel: number;
  moderatorNsfwLevel: number | null;
  userId: number | null;
  title: string | null;
  url: string;
};

const ratedEntities: Record<
  RatedEntityType,
  { recompute: (ids: number[]) => Promise<unknown>; read: (id: number) => Promise<RatedRow | null> }
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

export async function recomputeRatedEntityNsfwLevel(entityType: RatedEntityType, entityId: number) {
  await ratedEntities[entityType].recompute([entityId]);
}

export type RatingFloorResult = { deferredRatingNotice: NotifyTextScanRatingRaisedArgs | null };

const NOTHING_DEFERRED: RatingFloorResult = { deferredRatingNotice: null };

export async function applyRatingFloor(
  entityType: RatedEntityType,
  { entityId, workflowId, outcome }: ApplyTextScanArgs,
  { notify = true }: { notify?: boolean } = {}
): Promise<RatingFloorResult> {
  if (!outcome.nsfw) return NOTHING_DEFERRED;

  const entity = ratedEntities[entityType];
  const before = await entity.read(entityId);
  if (!before) return NOTHING_DEFERRED;
  await entity.recompute([entityId]);

  if (!notify || !outcome.nsfw.raised || before.moderatorNsfwLevel != null || !before.userId)
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
