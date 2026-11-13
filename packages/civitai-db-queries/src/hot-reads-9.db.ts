import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonBuildObject } from './infra/helpers';

// The Kysely port of the user profile read (`getUserWithProfile`, user-profile.service.ts), served
// behind the default-off server Flipt flag `kysely-hot-reads-9`; off, the Prisma read runs
// unchanged. This is ONE statement. The app-side wrapper
// (<civitai>/src/server/services/hot-reads-9.reads.ts) maps the row to the exact Prisma payload,
// and <civitai>/src/server/services/__tests__/hot-reads-9.kysely-parity.test.ts compares the two
// against a real database.
//
// Shape notes, each pinned by the parity suite:
// - The cosmetics' two timestamps are sent as epoch milliseconds (`obtainedAtMs`, `equippedAtMs`)
//   and turned back into Dates by the wrapper. Both columns are TIMESTAMP(3), so the value is a
//   whole number of milliseconds, and `round` takes back the sub-microsecond error of
//   `date_part`'s double. (`date_part`, not `extract(epoch FROM …)`: the parity suite's relation
//   ledger reads every `from "<name>"` as a relation.)
// - None of the Prisma relation reads has an `orderBy`. Here each aggregate is ordered by its
//   table's key (links by id, cosmetics by cosmetic id then claim key, tags by tag id), so the
//   order is defined; the parity suite compares the lists sorted.
//
// Relations: base tables, plus two declared `/// @view` in schema.full.prisma. "UserRank" carries
// the marker but is a TABLE (the leaderboard job truncates and refills it, user.service.ts), and is
// joined here as the creator card's read joins it (hot-reads.db.ts). "TagsOnImageDetails" is a VIEW,
// a per-row projection of "TagsOnImageNew" with no GROUP BY or UNION, so Postgres flattens it and
// the image id reaches the base-table scan; the parity suite EXPLAINs the statement and fails if the
// "TagsOnImageNew" scan does not filter by it.

export type UserWithProfileWhere = { id?: number; username?: string };

/** One cosmetic as the aggregate builds it. */
export type UserWithProfileCosmeticJson = {
  equippedAtMs: number | null;
  cosmeticId: number;
  obtainedAtMs: number;
  claimKey: string;
  data: unknown;
  cosmetic: {
    id: number;
    data: unknown;
    type: string;
    source: string;
    name: string;
    description: string | null;
    videoUrl: string | null;
  };
};

/** One link as the aggregate builds it. */
export type UserWithProfileLinkJson = { id: number; url: string; type: string };

/** One cover-image tag as the aggregate builds it. */
export type UserWithProfileTagJson = {
  tag: { id: number; name: string; isCategory: boolean; type: string };
  automated: boolean;
  needsReview: boolean;
};

/**
 * The user (not deleted) by id and/or username, with every relation the profile read selects, in
 * one statement; `undefined` when there is no such user.
 */
export function getUserWithProfileRow(db: Kysely<DB>, where: UserWithProfileWhere) {
  let query = db
    .selectFrom('User')
    .leftJoin('Image as ProfilePicture', 'ProfilePicture.id', 'User.profilePictureId')
    .leftJoin('UserRank', 'UserRank.userId', 'User.id')
    .leftJoin('UserProfile', 'UserProfile.userId', 'User.id')
    .leftJoin('Image as CoverImage', 'CoverImage.id', 'UserProfile.coverImageId')
    .leftJoin('Image as SfwCoverImage', 'SfwCoverImage.id', 'UserProfile.sfwCoverImageId')
    .select((eb) => {
      const coverTags = (image: 'CoverImage' | 'SfwCoverImage') =>
        eb
          .selectFrom('TagsOnImageDetails')
          .innerJoin('Tag', 'Tag.id', 'TagsOnImageDetails.tagId')
          .select((eb) =>
            eb.fn
              .coalesce(
                eb.fn
                  .jsonAgg(
                    jsonBuildObject({
                      tag: jsonBuildObject({
                        id: eb.ref('Tag.id'),
                        name: eb.ref('Tag.name'),
                        isCategory: eb.ref('Tag.isCategory'),
                        type: eb.ref('Tag.type'),
                      }),
                      automated: eb.ref('TagsOnImageDetails.automated'),
                      needsReview: eb.ref('TagsOnImageDetails.needsReview'),
                    })
                  )
                  .orderBy('TagsOnImageDetails.tagId', 'asc'),
                sql<[]>`'[]'`
              )
              .as('tags')
          )
          .whereRef('TagsOnImageDetails.imageId', '=', `${image}.id`)
          .where('TagsOnImageDetails.disabled', '=', false)
          .$castTo<{ tags: UserWithProfileTagJson[] }>();

      return [
        'User.id',
        'User.username',
        'User.deletedAt',
        'User.image',
        'User.leaderboardShowcase',
        'User.createdAt',
        'User.muted',
        'User.bannedAt',
        'User.meta',
        'User.publicSettings',
        'User.settings',
        'ProfilePicture.id as profilePictureId',
        'ProfilePicture.name as profilePictureName',
        'ProfilePicture.url as profilePictureUrl',
        'ProfilePicture.nsfwLevel as profilePictureNsfwLevel',
        'ProfilePicture.hash as profilePictureHash',
        'ProfilePicture.userId as profilePictureUserId',
        'ProfilePicture.ingestion as profilePictureIngestion',
        'ProfilePicture.needsReview as profilePictureNeedsReview',
        'ProfilePicture.type as profilePictureType',
        'ProfilePicture.width as profilePictureWidth',
        'ProfilePicture.height as profilePictureHeight',
        'ProfilePicture.metadata as profilePictureMetadata',
        'UserRank.userId as rankUserId',
        'UserRank.leaderboardRank',
        'UserRank.leaderboardId',
        'UserRank.leaderboardTitle',
        'UserRank.leaderboardCosmetic',
        'UserProfile.userId as profileUserId',
        'UserProfile.bio as profileBio',
        'UserProfile.coverImageId as profileCoverImageId',
        'UserProfile.message as profileMessage',
        'UserProfile.messageAddedAt as profileMessageAddedAt',
        'UserProfile.sfwBio as profileSfwBio',
        'UserProfile.sfwMessage as profileSfwMessage',
        'UserProfile.sfwMessageAddedAt as profileSfwMessageAddedAt',
        'UserProfile.sfwCoverImageId as profileSfwCoverImageId',
        'UserProfile.profileSectionsSettings as profileSectionsSettings',
        'UserProfile.privacySettings as profilePrivacySettings',
        'UserProfile.showcaseItems as profileShowcaseItems',
        'UserProfile.showcaseSections as profileShowcaseSections',
        'UserProfile.location as profileLocation',
        'UserProfile.nsfw as profileNsfw',
        'CoverImage.id as coverId',
        'CoverImage.name as coverName',
        'CoverImage.url as coverUrl',
        'CoverImage.nsfwLevel as coverNsfwLevel',
        'CoverImage.width as coverWidth',
        'CoverImage.height as coverHeight',
        'CoverImage.hash as coverHash',
        'CoverImage.meta as coverMeta',
        'CoverImage.userId as coverUserId',
        'CoverImage.generationProcess as coverGenerationProcess',
        'CoverImage.needsReview as coverNeedsReview',
        'CoverImage.scannedAt as coverScannedAt',
        'CoverImage.ingestion as coverIngestion',
        'CoverImage.blockedFor as coverBlockedFor',
        'CoverImage.postId as coverPostId',
        'CoverImage.type as coverType',
        'CoverImage.metadata as coverMetadata',
        'CoverImage.createdAt as coverCreatedAt',
        'CoverImage.hideMeta as coverHideMeta',
        coverTags('CoverImage').as('coverTags'),
        'SfwCoverImage.id as sfwCoverId',
        'SfwCoverImage.name as sfwCoverName',
        'SfwCoverImage.url as sfwCoverUrl',
        'SfwCoverImage.nsfwLevel as sfwCoverNsfwLevel',
        'SfwCoverImage.width as sfwCoverWidth',
        'SfwCoverImage.height as sfwCoverHeight',
        'SfwCoverImage.hash as sfwCoverHash',
        'SfwCoverImage.meta as sfwCoverMeta',
        'SfwCoverImage.userId as sfwCoverUserId',
        'SfwCoverImage.generationProcess as sfwCoverGenerationProcess',
        'SfwCoverImage.needsReview as sfwCoverNeedsReview',
        'SfwCoverImage.scannedAt as sfwCoverScannedAt',
        'SfwCoverImage.ingestion as sfwCoverIngestion',
        'SfwCoverImage.blockedFor as sfwCoverBlockedFor',
        'SfwCoverImage.postId as sfwCoverPostId',
        'SfwCoverImage.type as sfwCoverType',
        'SfwCoverImage.metadata as sfwCoverMetadata',
        'SfwCoverImage.createdAt as sfwCoverCreatedAt',
        'SfwCoverImage.hideMeta as sfwCoverHideMeta',
        coverTags('SfwCoverImage').as('sfwCoverTags'),
        eb
          .selectFrom('UserLink')
          .select((eb) =>
            eb.fn
              .coalesce(
                eb.fn
                  .jsonAgg(
                    jsonBuildObject({
                      id: eb.ref('UserLink.id'),
                      url: eb.ref('UserLink.url'),
                      type: eb.ref('UserLink.type'),
                    })
                  )
                  .orderBy('UserLink.id', 'asc'),
                sql<[]>`'[]'`
              )
              .as('links')
          )
          .whereRef('UserLink.userId', '=', 'User.id')
          .$castTo<{ links: UserWithProfileLinkJson[] }>()
          .as('links'),
        eb
          .selectFrom('UserCosmetic')
          .innerJoin('Cosmetic', 'Cosmetic.id', 'UserCosmetic.cosmeticId')
          .select((eb) =>
            eb.fn
              .coalesce(
                eb.fn
                  .jsonAgg(
                    jsonBuildObject({
                      equippedAtMs: sql<number | null>`round(date_part('epoch', ${eb.ref(
                        'UserCosmetic.equippedAt'
                      )}) * 1000)::bigint`,
                      cosmeticId: eb.ref('UserCosmetic.cosmeticId'),
                      obtainedAtMs: sql<number>`round(date_part('epoch', ${eb.ref(
                        'UserCosmetic.obtainedAt'
                      )}) * 1000)::bigint`,
                      claimKey: eb.ref('UserCosmetic.claimKey'),
                      data: eb.ref('UserCosmetic.data'),
                      cosmetic: jsonBuildObject({
                        id: eb.ref('Cosmetic.id'),
                        data: eb.ref('Cosmetic.data'),
                        type: eb.ref('Cosmetic.type'),
                        source: eb.ref('Cosmetic.source'),
                        name: eb.ref('Cosmetic.name'),
                        description: eb.ref('Cosmetic.description'),
                        videoUrl: eb.ref('Cosmetic.videoUrl'),
                      }),
                    })
                  )
                  .orderBy('UserCosmetic.cosmeticId', 'asc')
                  .orderBy('UserCosmetic.claimKey', 'asc'),
                sql<[]>`'[]'`
              )
              .as('cosmetics')
          )
          .whereRef('UserCosmetic.userId', '=', 'User.id')
          .$castTo<{ cosmetics: UserWithProfileCosmeticJson[] }>()
          .as('cosmetics'),
      ];
    })
    .where('User.deletedAt', 'is', null);
  if (where.id !== undefined) query = query.where('User.id', '=', where.id);
  if (where.username !== undefined) query = query.where('User.username', '=', where.username);
  // `coalesce` makes the aggregates non-null; type-only narrowing.
  return query
    .limit(1)
    .$narrowType<{
      coverTags: UserWithProfileTagJson[];
      sfwCoverTags: UserWithProfileTagJson[];
      links: UserWithProfileLinkJson[];
      cosmetics: UserWithProfileCosmeticJson[];
    }>()
    .executeTakeFirst();
}
