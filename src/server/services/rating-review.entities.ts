import { allBrowsingLevelsFlag, getHighestBrowsingLevelBit } from '@civitai/shared';
import {
  collectionRatingLevel,
  modelRatingLevel,
  textScanNsfwReason,
  textScanResultTextHash,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';
import { isTextScanRaised } from '@civitai/shared/rated-entity-sql';
import type { dbWrite } from '~/server/db/client';
import { dbRead } from '~/server/db/client';
import { ChallengeSource, EntityModerationStatus } from '~/shared/utils/prisma/enums';

export type RatingReviewSubject = {
  ownerId: number | null;
  currentLevel: number;
  updatedAt: Date | null;
  title: string;
  parentId: number | null;
  override: number | null;
  overrideBasis: number | null;
  // Set when something other than the rating decides the level, so a dispute could not move it.
  disputeRestriction?: string;
};

// A POI/minor flag forces the model SFW, so a rating dispute cannot move it while the flag stands.
export const FLAG_RESTRICTED_MESSAGE =
  'A model flagged as depicting a real person or a minor cannot have its rating disputed while the flag stands.';
// A forced level wins over a moderator rating, so resolving a dispute would change nothing.
export const FORCED_LEVEL_MESSAGE =
  "This collection's rating is fixed by Civitai, so it can't be disputed.";

// Blocked is a ToS action, not a rating: an `nsfw` bounty stores R|X|XXX|Blocked, so its highest bit would read as Blocked.
const ratedLevel = (mask: number) => getHighestBrowsingLevelBit(mask & allBrowsingLevelsFlag);

type Db = typeof dbRead | typeof dbWrite;
type Loader = (id: number, db: Db) => Promise<RatingReviewSubject | null>;

const overrideSelect = { moderatorNsfwLevel: true, moderatorNsfwLevelBasis: true } as const;
const overridePair = (r: {
  moderatorNsfwLevel: number | null;
  moderatorNsfwLevelBasis: number | null;
}) => ({
  override: r.moderatorNsfwLevel,
  overrideBasis: r.moderatorNsfwLevelBasis,
});

const loaders: Record<RatingReviewEntityType, Loader> = {
  Article: async (id, db) => {
    const a = await db.article.findUnique({
      where: { id },
      select: { userId: true, nsfwLevel: true, updatedAt: true, title: true, ...overrideSelect },
    });
    return (
      a && {
        ownerId: a.userId,
        currentLevel: a.nsfwLevel,
        updatedAt: a.updatedAt,
        title: a.title,
        parentId: null,
        ...overridePair(a),
      }
    );
  },
  Model: async (id, db) => {
    const m = await db.model.findUnique({
      where: { id },
      select: {
        userId: true,
        nsfw: true,
        updatedAt: true,
        name: true,
        deletedAt: true,
        poi: true,
        minor: true,
      },
    });
    if (!m || m.deletedAt) return null;
    return {
      ownerId: m.userId,
      currentLevel: modelRatingLevel(m.nsfw),
      updatedAt: m.updatedAt,
      title: m.name,
      parentId: null,
      override: null,
      overrideBasis: null,
      disputeRestriction: m.poi || m.minor ? FLAG_RESTRICTED_MESSAGE : undefined,
    };
  },
  Post: async (id, db) => {
    const p = await db.post.findUnique({
      where: { id },
      select: { userId: true, nsfwLevel: true, updatedAt: true, title: true, ...overrideSelect },
    });
    return (
      p && {
        ownerId: p.userId,
        currentLevel: ratedLevel(p.nsfwLevel),
        updatedAt: p.updatedAt,
        title: p.title ?? `Post #${id}`,
        parentId: null,
        ...overridePair(p),
      }
    );
  },
  Bounty: async (id, db) => {
    const b = await db.bounty.findUnique({
      where: { id },
      select: { userId: true, nsfwLevel: true, updatedAt: true, name: true, ...overrideSelect },
    });
    return (
      b && {
        ownerId: b.userId,
        currentLevel: ratedLevel(b.nsfwLevel),
        updatedAt: b.updatedAt,
        title: b.name,
        parentId: null,
        ...overridePair(b),
      }
    );
  },
  BountyEntry: async (id, db) => {
    const e = await db.bountyEntry.findUnique({
      where: { id },
      select: { userId: true, bountyId: true, nsfwLevel: true, updatedAt: true, ...overrideSelect },
    });
    return (
      e && {
        ownerId: e.userId,
        currentLevel: ratedLevel(e.nsfwLevel),
        updatedAt: e.updatedAt,
        title: `Entry #${id}`,
        parentId: e.bountyId,
        ...overridePair(e),
      }
    );
  },
  Challenge: async (id, db) => {
    const c = await db.challenge.findUnique({
      where: { id },
      select: {
        createdById: true,
        source: true,
        nsfwLevel: true,
        updatedAt: true,
        title: true,
        ...overrideSelect,
      },
    });
    return (
      c && {
        ownerId: c.source === ChallengeSource.User ? c.createdById : null,
        currentLevel: ratedLevel(c.nsfwLevel),
        updatedAt: c.updatedAt,
        title: c.title,
        parentId: null,
        ...overridePair(c),
      }
    );
  },
  Crucible: async (id, db) => {
    const c = await db.crucible.findUnique({
      where: { id },
      select: { userId: true, nsfwLevel: true, updatedAt: true, name: true, ...overrideSelect },
    });
    return (
      c && {
        ownerId: c.userId,
        currentLevel: ratedLevel(c.nsfwLevel),
        updatedAt: c.updatedAt,
        title: c.name,
        parentId: null,
        ...overridePair(c),
      }
    );
  },
  Collection: async (id, db) => {
    const c = await db.collection.findUnique({
      where: { id },
      select: {
        userId: true,
        nsfwLevel: true,
        updatedAt: true,
        name: true,
        metadata: true,
        ...overrideSelect,
      },
    });
    const forced = (c?.metadata as { forcedBrowsingLevel?: unknown } | null)?.forcedBrowsingLevel;
    return (
      c && {
        ownerId: c.userId,
        currentLevel: collectionRatingLevel(c.nsfwLevel),
        updatedAt: c.updatedAt,
        title: c.name,
        parentId: null,
        ...overridePair(c),
        disputeRestriction: forced ? FORCED_LEVEL_MESSAGE : undefined,
      }
    );
  },
};

export function loadRatingReviewSubject(
  entityType: RatingReviewEntityType,
  entityId: number,
  db: Db = dbRead
): Promise<RatingReviewSubject | null> {
  return loaders[entityType](entityId, db);
}

export type RatingReviewScan = {
  raised: boolean;
  level: number | null;
  reason: string | null;
  textHash: string | null;
  pending: boolean;
};

export async function getRatingReviewScan(
  entityType: RatingReviewEntityType,
  entityId: number,
  db: Db = dbRead
): Promise<RatingReviewScan | null> {
  const em = await db.entityModeration.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { status: true, nsfwLevel: true, result: true },
  });
  if (!em) return null;
  const raised = isTextScanRaised({ entityType, nsfwLevel: em.nsfwLevel, result: em.result });
  return {
    raised,
    level: raised ? em.nsfwLevel : null,
    reason: raised ? textScanNsfwReason(em.result) : null,
    textHash: textScanResultTextHash(em.result),
    pending: em.status === EntityModerationStatus.Pending,
  };
}
