import type { Prisma } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getUserCreatorRow, getUserStatRow } from '@civitai/db-queries/hot-reads';
import { constants } from '~/server/common/constants';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { profileImageSelect } from '~/server/selectors/image.selector';
import { withSpan } from '~/server/utils/otel-helpers';

/**
 * The read behind the creator card (`fetchUserCreator`): the user with its links, stats, rank,
 * equipped cosmetics and profile picture, and their published-model count, in the shape the Prisma
 * `user.findFirst` with `userCreatorSelect` returned. Taking the client lets
 * __tests__/hot-reads-2.kysely-parity.test.ts run the very code the service runs.
 */
export type UserCreatorWhere = { username?: string; id?: number };

const userCreatorSelect = {
  id: true,
  image: true,
  username: true,
  muted: true,
  bannedAt: true,
  deletedAt: true,
  createdAt: true,
  publicSettings: true,
  settings: true,
  excludeFromLeaderboards: true,
  links: {
    select: {
      url: true,
      type: true,
    },
  },
  stats: {
    select: {
      downloadCountAllTime: true,
      thumbsUpCountAllTime: true,
      followerCountAllTime: true,
      reactionCountAllTime: true,
      uploadCountAllTime: true,
      generationCountAllTime: true,
    },
  },
  rank: {
    select: {
      leaderboardRank: true,
      leaderboardId: true,
      leaderboardTitle: true,
      leaderboardCosmetic: true,
    },
  },
  cosmetics: {
    where: { equippedAt: { not: null }, equippedToId: null },
    select: {
      data: true,
      cosmetic: {
        select: simpleCosmeticSelect,
      },
    },
  },
  profilePicture: {
    select: profileImageSelect,
  },
} satisfies Prisma.UserSelect;

export type UserCreatorUser = Prisma.UserGetPayload<{ select: typeof userCreatorSelect }>;
export type UserCreatorRead = { user: UserCreatorUser; modelCount: number } | null;

/**
 * Two Kysely statements, one after the other on ONE pooled connection, mapped to the Prisma shape: the user (`getUserCreatorRow`, with links, rank, cosmetics, profile picture and
 * the model count), then, once its id is known, its stats (`getUserStatRow`). The stats are the
 * "UserStat" VIEW, so they are read by that id as a parameter rather than joined to "User": a join
 * cannot reach into the view's per-user aggregates, and a username lookup would compute them for
 * every user (see hot-reads.db.ts).
 */
export async function readUserCreatorViaKysely(
  db: Kysely<DB>,
  where: UserCreatorWhere
): Promise<UserCreatorRead> {
  const found = await db.connection().execute(async (conn) => {
    const row = await withSpan('user:getCreator:findUser', () =>
      getUserCreatorRow(conn, {
        id: where.id,
        username: where.username,
        systemUserId: constants.system.user.id,
        systemUsername: constants.system.user.username,
      })
    );
    if (!row) return null;
    const stats = await withSpan('user:getCreator:userStats', () => getUserStatRow(conn, row.id));
    return { row, stats };
  });
  if (!found) return null;
  const { row, stats } = found;

  const user = {
    id: row.id,
    image: row.image,
    username: row.username,
    muted: row.muted,
    bannedAt: row.bannedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    publicSettings: row.publicSettings,
    settings: row.settings,
    excludeFromLeaderboards: row.excludeFromLeaderboards,
    links: row.links,
    stats: stats ?? null,
    rank:
      row.rankUserId !== null
        ? {
            leaderboardRank: row.leaderboardRank,
            leaderboardId: row.leaderboardId,
            leaderboardTitle: row.leaderboardTitle,
            leaderboardCosmetic: row.leaderboardCosmetic,
          }
        : null,
    cosmetics: row.cosmetics.map((cosmetic) => ({
      data: cosmetic.data,
      cosmetic: {
        id: cosmetic.cosmeticId,
        name: cosmetic.cosmeticName,
        description: cosmetic.cosmeticDescription,
        type: cosmetic.cosmeticType,
        source: cosmetic.cosmeticSource,
        data: cosmetic.cosmeticData,
      },
    })),
    profilePicture:
      row.profilePictureId !== null
        ? {
            id: row.profilePictureId,
            name: row.profilePictureName,
            url: row.profilePictureUrl,
            nsfwLevel: row.profilePictureNsfwLevel,
            hash: row.profilePictureHash,
            userId: row.profilePictureUserId,
            ingestion: row.profilePictureIngestion,
            needsReview: row.profilePictureNeedsReview,
            tosViolation: row.profilePictureTosViolation,
            type: row.profilePictureType,
            width: row.profilePictureWidth,
            height: row.profilePictureHeight,
            metadata: row.profilePictureMetadata,
          }
        : null,
  };

  return { user: user as unknown as UserCreatorUser, modelCount: row.modelCount ?? 0 };
}
