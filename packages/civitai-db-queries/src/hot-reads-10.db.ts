import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonBuildObject } from './infra/helpers';

// The Kysely port of the collection read (`getCollectionById`, collection.service.ts), served
// behind the default-off server Flipt flag `kysely-hot-reads-10`; off, the Prisma read runs
// unchanged. Prisma fans that read out into one statement per relation (the collection, its cover
// image, the cover's tags and those tags' tags, the collection's tags and their tags, the owner,
// the owner's profile picture, and the owner's equipped cosmetics and their cosmetics). This is ONE
// statement. The app-side wrapper (<civitai>/src/server/services/hot-reads-10.reads.ts) maps the
// row to the exact Prisma payload, and
// <civitai>/src/server/services/__tests__/hot-reads-10.kysely-parity.test.ts compares the two
// against a real database.
//
// Shape notes, each pinned by the parity suite:
// - The cover image and the profile picture are LEFT JOINs, so a dangling id reads as no
//   relation, as it does in Prisma. Their timestamps are top-level columns, parsed by the pg
//   parsers @civitai/db/kysely registers.
// - The owner is an INNER JOIN: Prisma's `user` relation is required ("Collection"."userId" is
//   NOT NULL with a cascading foreign key), so a collection always has one.
// - The to-many relations (the collection's tags, the cover's tags, the owner's equipped
//   cosmetics) are correlated `json_agg` subqueries. Every column in them survives JSON unchanged
//   (integers, booleans, text, citext, enums as text, JSON columns); none of them is a timestamp.
// - None of the Prisma relation reads has an `orderBy`. The collection's tags are ordered by when
//   they were added ("createdAt", NULLs first, then tag id), which is the order Prisma's unordered
//   read gives on a heap filled in insertion order and the order the contest category dropdown
//   shows them in; the parity suite pins it order-sensitively. The other aggregates are ordered by
//   their table's key (cover tags by tag id, cosmetics by cosmetic id then claim key), so the order
//   is defined; the parity suite compares those lists sorted.
//
// Relations: base tables, plus "TagsOnImageDetails", declared `/// @view` in schema.full.prisma and
// a VIEW in fact: a per-row projection of "TagsOnImageNew" with no GROUP BY or UNION, so Postgres
// flattens it and the image id reaches the base-table scan. The parity suite EXPLAINs the statement
// and fails if the "TagsOnImageNew" scan does not filter by it.

/** One collection tag as the aggregate builds it. */
export type CollectionByIdTagJson = {
  tag: { id: number; name: string };
  filterableOnly: boolean;
};

/** One cover-image tag as the aggregate builds it. */
export type CollectionByIdImageTagJson = {
  tag: { id: number; name: string; isCategory: boolean; type: string };
  automated: boolean;
  needsReview: boolean;
};

/** One equipped cosmetic of the owner as the aggregate builds it. */
export type CollectionByIdCosmeticJson = {
  data: unknown;
  cosmetic: { id: number; data: unknown; type: string; source: string; name: string };
};

/**
 * The collection by id, with its cover image, tags and owner (profile picture and equipped
 * cosmetics), in one statement; `undefined` when there is no such collection.
 */
export function getCollectionByIdRow(db: Kysely<DB>, id: number) {
  return (
    db
      .selectFrom('Collection')
      .innerJoin('User as Owner', 'Owner.id', 'Collection.userId')
      .leftJoin('Image as CoverImage', 'CoverImage.id', 'Collection.imageId')
      .leftJoin('Image as ProfilePicture', 'ProfilePicture.id', 'Owner.profilePictureId')
      .select((eb) => [
        'Collection.id',
        'Collection.name',
        'Collection.description',
        'Collection.read',
        'Collection.write',
        'Collection.type',
        'Collection.nsfw',
        'Collection.nsfwLevel',
        'Collection.mode',
        'Collection.metadata',
        'Collection.availability',
        'Collection.archivedAt',
        'Collection.userId',
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
              .as('coverTags')
          )
          .whereRef('TagsOnImageDetails.imageId', '=', 'CoverImage.id')
          .where('TagsOnImageDetails.disabled', '=', false)
          .$castTo<{ coverTags: CollectionByIdImageTagJson[] }>()
          .as('coverTags'),
        eb
          .selectFrom('TagsOnCollection')
          .innerJoin('Tag', 'Tag.id', 'TagsOnCollection.tagId')
          .select((eb) =>
            eb.fn
              .coalesce(
                eb.fn
                  .jsonAgg(
                    jsonBuildObject({
                      tag: jsonBuildObject({ id: eb.ref('Tag.id'), name: eb.ref('Tag.name') }),
                      filterableOnly: eb.ref('TagsOnCollection.filterableOnly'),
                    })
                  )
                  .orderBy('TagsOnCollection.createdAt', (ob) => ob.asc().nullsFirst())
                  .orderBy('TagsOnCollection.tagId', 'asc'),
                sql<[]>`'[]'`
              )
              .as('tags')
          )
          .whereRef('TagsOnCollection.collectionId', '=', 'Collection.id')
          .$castTo<{ tags: CollectionByIdTagJson[] }>()
          .as('tags'),
        'Owner.id as ownerId',
        'Owner.username as ownerUsername',
        'Owner.deletedAt as ownerDeletedAt',
        'Owner.image as ownerImage',
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
        eb
          .selectFrom('UserCosmetic')
          .innerJoin('Cosmetic', 'Cosmetic.id', 'UserCosmetic.cosmeticId')
          .select((eb) =>
            eb.fn
              .coalesce(
                eb.fn
                  .jsonAgg(
                    jsonBuildObject({
                      data: eb.ref('UserCosmetic.data'),
                      cosmetic: jsonBuildObject({
                        id: eb.ref('Cosmetic.id'),
                        data: eb.ref('Cosmetic.data'),
                        type: eb.ref('Cosmetic.type'),
                        source: eb.ref('Cosmetic.source'),
                        name: eb.ref('Cosmetic.name'),
                      }),
                    })
                  )
                  .orderBy('UserCosmetic.cosmeticId', 'asc')
                  .orderBy('UserCosmetic.claimKey', 'asc'),
                sql<[]>`'[]'`
              )
              .as('cosmetics')
          )
          .whereRef('UserCosmetic.userId', '=', 'Owner.id')
          .where('UserCosmetic.equippedAt', 'is not', null)
          .where('UserCosmetic.equippedToId', 'is', null)
          .$castTo<{ cosmetics: CollectionByIdCosmeticJson[] }>()
          .as('cosmetics'),
      ])
      .where('Collection.id', '=', id)
      // An aggregate always yields one row and `coalesce` turns an empty one into `[]`, so the three
      // arrays are never null. A type-only narrowing; no SQL changes.
      .$narrowType<{
        coverTags: CollectionByIdImageTagJson[];
        tags: CollectionByIdTagJson[];
        cosmetics: CollectionByIdCosmeticJson[];
      }>()
      .executeTakeFirst()
  );
}
