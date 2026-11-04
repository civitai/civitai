import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
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
  logRatingNoticeDecision,
  notifyTextScanRatingRaised,
  ratingRose,
  type NotifyTextScanRatingRaisedArgs,
  type RatingNoticeDecision,
} from '~/server/services/text-scan/notify';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

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
    imageLevel?: (id: number) => Promise<number>;
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
    imageLevel: async (id) => {
      const rows = await dbWrite.$queryRaw<{ level: number | null }[]>(Prisma.sql`
        SELECT bit_or(i."nsfwLevel") AS level FROM "Image" i WHERE i."postId" = ${id}
      `);
      return rows?.[0]?.level ?? 0;
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
  const decide = (
    decision: RatingNoticeDecision,
    levels: { before?: number; baseline?: number; after?: number } = {}
  ) => {
    logRatingNoticeDecision({
      path: 'callback',
      entityType,
      entityId,
      workflowId,
      decision,
      before: levels.before ?? null,
      baseline: levels.baseline ?? null,
      after: levels.after ?? null,
    });
    return NOTHING_DEFERRED;
  };
  const before = ratingBefore !== undefined ? ratingBefore : await entity.read(entityId);
  if (!before) return decide('entity-gone');
  await entity.recompute([entityId]);

  const was = { before: before.nsfwLevel };
  if (!outcome.nsfw.raised) return decide('not-raised', was);
  if (before.moderatorNsfwLevel != null) return decide('moderator-rated', was);
  if (!before.userId) return decide('no-owner', was);
  const after = await entity.read(entityId);
  if (!after) return decide('entity-gone', was);
  // A stored 0 may only mean the job has not recomputed the post yet; judge against its images.
  const shown =
    before.nsfwLevel === 0 && entity.imageLevel
      ? await entity.imageLevel(entityId)
      : before.nsfwLevel;
  const levels = { ...was, baseline: shown, after: after.nsfwLevel };
  if (!ratingRose(shown, after.nsfwLevel)) return decide('no-rise', levels);

  const notice: NotifyTextScanRatingRaisedArgs = {
    entityType,
    entityId,
    userId: before.userId,
    level: noticeLevel(after.nsfwLevel, outcome.nsfw.detectedLevel),
    title: before.title,
    url: before.url,
    workflowId,
  };
  if (outcome.poi?.detected || outcome.minor?.detected) {
    decide('deferred-poi-minor', levels);
    return { deferredRatingNotice: notice };
  }
  try {
    await notifyTextScanRatingRaised(notice);
  } catch (error) {
    decide('notice-failed', levels);
    throw error;
  }
  return decide('sent', levels);
}
