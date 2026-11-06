import { Prisma } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  getUserWithProfileRow,
  type UserWithProfileTagJson,
  type UserWithProfileWhere,
} from '@civitai/db-queries/hot-reads-9';
import { userWithProfileSelect } from '~/server/selectors/user.selector';
import { profilePictureOf } from '~/server/services/user-creator.reads';

/**
 * The read behind `kysely-hot-reads-9`: the user profile read (`getUserWithProfile`,
 * user-profile.service.ts), as a Prisma reader and its Kysely twin taking the client, so the parity
 * suite (__tests__/hot-reads-9.kysely-parity.test.ts) runs the very code the service runs. The
 * Prisma reader is the original read, moved here verbatim. The twin returns the value the Prisma
 * reader returns, from ONE statement where Prisma issues one per relation.
 */

export type { UserWithProfileWhere };

/** The Prisma read's arguments: `userWithProfileSelect` plus the four columns the service needs. */
export const userWithProfileFindArgs = ({ id, username }: UserWithProfileWhere) =>
  ({
    where: {
      id,
      username,
      deletedAt: null,
    },
    select: {
      ...userWithProfileSelect,
      bannedAt: true,
      meta: true,
      publicSettings: true,
      settings: true,
    },
  } as const);

/** Rejects with Prisma's P2025 when there is no such user (`findUniqueOrThrow`). */
export function readUserWithProfileViaPrisma(
  db: Prisma.TransactionClient,
  where: UserWithProfileWhere
) {
  return db.user.findUniqueOrThrow(userWithProfileFindArgs(where));
}

export type UserWithProfile = Awaited<ReturnType<typeof readUserWithProfileViaPrisma>>;

type Row = NonNullable<Awaited<ReturnType<typeof getUserWithProfileRow>>>;

/**
 * The error Prisma's `findUniqueOrThrow` rejects with, so a caller's error mapping
 * (`throwDbError`: P2025 is NOT_FOUND) treats a missing user the same on both paths.
 */
export function userNotFoundError() {
  return new Prisma.PrismaClientKnownRequestError('No User found', {
    code: 'P2025',
    clientVersion: Prisma.prismaVersion.client,
    meta: { modelName: 'User', cause: 'Expected a record, found none.' },
  });
}

const msToDate = (ms: number | string | null) => (ms === null ? null : new Date(Number(ms)));

const tagsOf = (tags: UserWithProfileTagJson[]) =>
  tags.map((tag) => ({
    tag: {
      id: tag.tag.id,
      name: tag.tag.name,
      isCategory: tag.tag.isCategory,
      type: tag.tag.type,
    },
    automated: tag.automated,
    needsReview: tag.needsReview,
  }));

/** `imageSelect` (image.selector.ts), field for field, from one prefixed set of columns. */
function coverImageOf(row: Row, prefix: 'cover' | 'sfwCover') {
  const c = (key: string): unknown => (row as Record<string, unknown>)[`${prefix}${key}`];
  if (c('Id') === null) return null;
  return {
    id: c('Id'),
    name: c('Name'),
    url: c('Url'),
    nsfwLevel: c('NsfwLevel'),
    width: c('Width'),
    height: c('Height'),
    hash: c('Hash'),
    meta: c('Meta'),
    userId: c('UserId'),
    generationProcess: c('GenerationProcess'),
    needsReview: c('NeedsReview'),
    scannedAt: c('ScannedAt'),
    ingestion: c('Ingestion'),
    blockedFor: c('BlockedFor'),
    postId: c('PostId'),
    type: c('Type'),
    metadata: c('Metadata'),
    createdAt: c('CreatedAt'),
    hideMeta: c('HideMeta'),
    tags: tagsOf(prefix === 'cover' ? row.coverTags : row.sfwCoverTags),
  };
}

/**
 * The same user from ONE statement (`getUserWithProfileRow`), rejecting with Prisma's P2025 when
 * there is no such user. Keys are built in the order the Prisma select lists them. Cosmetics,
 * links and tags come back in key order (the Prisma read has no `orderBy`).
 */
export async function readUserWithProfileViaKysely(
  db: Kysely<DB>,
  where: UserWithProfileWhere
): Promise<UserWithProfile> {
  // Prisma rejects a where with no unique field; never issue an unfiltered read.
  if (where.id === undefined && where.username === undefined)
    throw new Error('readUserWithProfileViaKysely: an id or a username is required');
  const row = await getUserWithProfileRow(db, where);
  if (!row) throw userNotFoundError();

  const user = {
    id: row.id,
    username: row.username,
    deletedAt: row.deletedAt,
    image: row.image,
    profilePicture: profilePictureOf(row),
    leaderboardShowcase: row.leaderboardShowcase,
    createdAt: row.createdAt,
    muted: row.muted,
    cosmetics: row.cosmetics.map((cosmetic) => ({
      equippedAt: msToDate(cosmetic.equippedAtMs),
      cosmeticId: cosmetic.cosmeticId,
      obtainedAt: msToDate(cosmetic.obtainedAtMs),
      claimKey: cosmetic.claimKey,
      data: cosmetic.data,
      cosmetic: {
        id: cosmetic.cosmetic.id,
        data: cosmetic.cosmetic.data,
        type: cosmetic.cosmetic.type,
        source: cosmetic.cosmetic.source,
        name: cosmetic.cosmetic.name,
        description: cosmetic.cosmetic.description,
        videoUrl: cosmetic.cosmetic.videoUrl,
      },
    })),
    links: row.links.map((link) => ({ id: link.id, url: link.url, type: link.type })),
    rank:
      row.rankUserId !== null
        ? {
            leaderboardRank: row.leaderboardRank,
            leaderboardId: row.leaderboardId,
            leaderboardTitle: row.leaderboardTitle,
            leaderboardCosmetic: row.leaderboardCosmetic,
          }
        : null,
    profile:
      row.profileUserId !== null
        ? {
            bio: row.profileBio,
            coverImageId: row.profileCoverImageId,
            coverImage: coverImageOf(row, 'cover'),
            message: row.profileMessage,
            messageAddedAt: row.profileMessageAddedAt,
            sfwBio: row.profileSfwBio,
            sfwMessage: row.profileSfwMessage,
            sfwMessageAddedAt: row.profileSfwMessageAddedAt,
            sfwCoverImageId: row.profileSfwCoverImageId,
            sfwCoverImage: coverImageOf(row, 'sfwCover'),
            profileSectionsSettings: row.profileSectionsSettings,
            privacySettings: row.profilePrivacySettings,
            showcaseItems: row.profileShowcaseItems,
            showcaseSections: row.profileShowcaseSections,
            location: row.profileLocation,
            nsfw: row.profileNsfw,
            userId: row.profileUserId,
          }
        : null,
    bannedAt: row.bannedAt,
    meta: row.meta,
    publicSettings: row.publicSettings,
    settings: row.settings,
  };

  return user as unknown as UserWithProfile;
}
