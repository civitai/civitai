import type { Prisma, PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getUserCreatorRow } from '@civitai/db-queries/hot-reads';
import { constants } from '~/server/common/constants';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { profileImageSelect } from '~/server/selectors/image.selector';
import { withSpan } from '~/server/utils/otel-helpers';

/**
 * The two reads behind the creator card (`fetchUserCreator`): the user with its links, stats, rank,
 * equipped cosmetics and profile picture, and their published-model count. One Prisma reader and
 * its Kysely twin, both taking the client, so the parity suite
 * (__tests__/hot-reads-2.kysely-parity.test.ts) runs the very code the service runs.
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

/** The Prisma reads, unchanged: the user, then (when found) the published-model count. */
export async function readUserCreatorViaPrisma(
  db: PrismaClient,
  where: UserCreatorWhere
): Promise<UserCreatorRead> {
  const user = await withSpan('user:getCreator:findUser', () =>
    db.user.findFirst({
      where: {
        ...where,
        deletedAt: null,
        AND: [
          { id: { not: constants.system.user.id } },
          { username: { not: constants.system.user.username } },
        ],
      },
      select: userCreatorSelect,
    })
  );
  if (!user) return null;

  /**
   * TODO: seems to be deprecated, we are getting model count from the stats
   * though it might be bugged since we are not updating stats if user deletes/unpublishes models
   */
  const modelCount = await withSpan('user:getCreator:countModels', () =>
    db.model.count({
      where: {
        userId: user?.id,
        status: 'Published',
      },
    })
  );

  return { user, modelCount };
}

/** The same answer in one Kysely statement (`getUserCreatorRow`), mapped to the Prisma shape. */
export async function readUserCreatorViaKysely(
  db: Kysely<DB>,
  where: UserCreatorWhere
): Promise<UserCreatorRead> {
  const row = await withSpan('user:getCreator:findUser', () =>
    getUserCreatorRow(db, {
      id: where.id,
      username: where.username,
      systemUserId: constants.system.user.id,
      systemUsername: constants.system.user.username,
    })
  );
  if (!row) return null;

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
    stats:
      row.statsUserId !== null
        ? {
            downloadCountAllTime: row.downloadCountAllTime,
            thumbsUpCountAllTime: row.thumbsUpCountAllTime,
            followerCountAllTime: row.followerCountAllTime,
            reactionCountAllTime: row.reactionCountAllTime,
            uploadCountAllTime: row.uploadCountAllTime,
            generationCountAllTime: row.generationCountAllTime,
          }
        : null,
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
            type: row.profilePictureType,
            width: row.profilePictureWidth,
            height: row.profilePictureHeight,
            metadata: row.profilePictureMetadata,
          }
        : null,
  };

  return { user: user as unknown as UserCreatorUser, modelCount: row.modelCount ?? 0 };
}
