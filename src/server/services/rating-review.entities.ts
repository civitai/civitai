import type { Prisma } from '@prisma/client';
import {
  collectionRatingLevel,
  modelRatingLevel,
  songDisputable,
  songNeverReviewable,
  songScanStateOf,
  textScanNsfwReason,
  textScanResultTextHash,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';
import { isTextScanRaised } from '@civitai/shared/rated-entity-sql';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { ratedLevel, scanFlagLevel, withContentLevel } from '~/server/services/bounty-rated-level';
import { ratedEntityContentNsfwLevelSql } from '~/server/services/text-scan/scan-floor';
import { BOUNTY_SCAN_DETAILS_KEY } from '~/server/utils/bounty-details';
import { readSystemNsfwLockAt } from '~/server/utils/minor-flag-meta';
import {
  ChallengeSource,
  EntityModerationStatus,
  ImageIngestionStatus,
  MediaType,
} from '~/shared/utils/prisma/enums';

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
  // A system check, not a moderator, locked the level: the owner may dispute it even after the scan
  // that raised it has gone clean.
  systemNsfwLock?: boolean;
};

// A POI/minor flag forces the model SFW, so a rating dispute cannot move it while the flag stands.
export const FLAG_RESTRICTED_MESSAGE =
  'A model flagged as depicting a real person or a minor cannot have its rating disputed while the flag stands.';
// A forced level wins over a moderator rating, so resolving a dispute would change nothing.
export const FORCED_LEVEL_MESSAGE =
  "This collection's rating is fixed by Civitai, so it can't be disputed.";

// A moderator's ruling locks a song's level, and a locked level counts as the song's review, which
// only its own scans may give: so a song is disputable only once they have reviewed it.
export const SONG_UNREVIEWED_MESSAGE =
  "This song is still being reviewed, so its rating can't be disputed yet.";
export const SONG_REMOVED_MESSAGE = "This song was removed, so its rating can't be disputed.";
export const SONG_UNREVIEWABLE_MESSAGE =
  "This song's scans could not review it, so its rating can't be disputed.";
const REMOVED_SONG_STATES: string[] = [ImageIngestionStatus.Blocked, ImageIngestionStatus.NotFound];

function songDisputeRestriction(ingestion: string, scanJobs: unknown): string | undefined {
  if (songDisputable(ingestion)) return undefined;
  if (REMOVED_SONG_STATES.includes(ingestion)) return SONG_REMOVED_MESSAGE;
  return songNeverReviewable(songScanStateOf(ingestion, scanJobs))
    ? SONG_UNREVIEWABLE_MESSAGE
    : SONG_UNREVIEWED_MESSAGE;
}

// Moderator actions that lock or unlock a model's nsfw flag. Any logged after the system marker makes
// the lock that stands now the moderator's: an unlock means a later lock (a dispute resolution logs
// none) is not the one the system set.
const SYSTEM_USER_ID = constants.system.user.id;

export const MODERATOR_NSFW_LOCK_ACTIVITIES = [
  'lockProperty:nsfw',
  'unlockProperty:nsfw',
  'setSfwOnly',
  'unsetSfwOnly',
  'setMinor',
  'setMinorAutoHash',
  'setMinorTextScan',
  'unsetMinor',
  'rollbackMinorAutoHash',
  'setPoi',
  'setPoiAutoHash',
  'unsetPoi',
  'revertPoiAutoHash',
];

/** Whether a moderator ruled on the model's nsfw flag after `at`; the primary, as a fresh ruling
 *  may not have reached the replica. Pass `db` inside a transaction so it reads on that connection. */
export async function moderatorRuledNsfwSince(
  modelId: number,
  at: Date,
  {
    alsoRejections = false,
    db = dbWrite,
  }: { alsoRejections?: boolean; db?: Pick<Prisma.TransactionClient, 'modActivity'> } = {}
) {
  const ruling = await db.modActivity.findFirst({
    where: {
      entityType: 'model',
      entityId: modelId,
      activity: {
        in: alsoRejections
          ? [...MODERATOR_NSFW_LOCK_ACTIVITIES, 'rejectLockReview']
          : MODERATOR_NSFW_LOCK_ACTIVITIES,
      },
      createdAt: { gt: at },
      // The system's own approval of a dispute is not a moderator's ruling.
      NOT: { userId: SYSTEM_USER_ID },
    },
    select: { id: true },
  });
  return !!ruling;
}

export async function hasSystemNsfwLock(
  modelId: number,
  m: { nsfw: boolean; lockedProperties: string[] | null; meta: unknown }
) {
  if (!m.nsfw || !m.lockedProperties?.includes('nsfw')) return false;
  const at = readSystemNsfwLockAt(m.meta);
  if (!at) return false;
  // Primary: a moderator's lock that has not reached the replica would read as the system's.
  return !(await moderatorRuledNsfwSince(modelId, at));
}

type Db = typeof dbRead | typeof dbWrite;

const setByTextScan = (details: unknown) =>
  !!details && typeof details === 'object' && BOUNTY_SCAN_DETAILS_KEY in details;

// The nsfw flag pins a bounty's stored level to every NSFW bit, which names no level. When the text
// scan set the flag, its moderation row holds the level it rated; images can still rate the bounty
// higher.
async function bountyRatedLevel(
  id: number,
  b: {
    nsfw: boolean;
    details: unknown;
    nsfwLevel: number;
    moderatorNsfwLevel: number | null;
  },
  db: Db
) {
  const pinned = ratedLevel(b.nsfwLevel);
  if (!b.nsfw || b.moderatorNsfwLevel != null || !setByTextScan(b.details)) return pinned;
  const em = await db.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: 'Bounty', entityId: id } },
    select: { nsfwLevel: true, result: true },
  });
  const scanned = em && scanFlagLevel(em);
  if (scanned == null) return pinned;
  const rows = await db.$queryRaw<{ level: number | null }[]>`
    SELECT ${ratedEntityContentNsfwLevelSql(
      'Bounty',
      'e'
    )} AS level FROM "Bounty" e WHERE e.id = ${id}
  `;
  return withContentLevel(scanned, rows[0]?.level ?? null);
}
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
        lockedProperties: true,
        meta: true,
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
      systemNsfwLock: await hasSystemNsfwLock(id, m),
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
      select: {
        userId: true,
        nsfw: true,
        details: true,
        nsfwLevel: true,
        updatedAt: true,
        name: true,
        ...overrideSelect,
      },
    });
    return (
      b && {
        ownerId: b.userId,
        currentLevel: await bountyRatedLevel(id, b, db),
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
  Song: async (id, db) => {
    const i = await db.image.findUnique({
      where: { id },
      select: {
        userId: true,
        type: true,
        ingestion: true,
        nsfwLevel: true,
        updatedAt: true,
        metadata: true,
        scanJobs: true,
      },
    });
    if (!i || i.type !== MediaType.audio) return null;
    const title = (i.metadata as { title?: unknown } | null)?.title;
    return {
      ownerId: i.userId,
      currentLevel: ratedLevel(i.nsfwLevel),
      updatedAt: i.updatedAt,
      title: typeof title === 'string' && title.trim() ? title : `Song #${id}`,
      parentId: null,
      override: null,
      overrideBasis: null,
      disputeRestriction: songDisputeRestriction(i.ingestion, i.scanJobs),
    };
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
