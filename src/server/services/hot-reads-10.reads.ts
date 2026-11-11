import type { Prisma } from '@prisma/client';
import { servableProfilePicture } from '~/server/services/profile-picture.servable';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getCollectionByIdRow } from '@civitai/db-queries/hot-reads-10';
import { collectionSelect } from '~/server/selectors/collection.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

/**
 * The read behind `kysely-hot-reads-10`: the collection read (`getCollectionById`,
 * collection.service.ts), as a Prisma reader and its Kysely twin taking the client, so the parity
 * suite (__tests__/hot-reads-10.kysely-parity.test.ts) runs the very code the service runs. The
 * Prisma reader is the original read, moved here verbatim. The twin returns the value the Prisma
 * reader returns, from ONE statement where Prisma issues one per relation.
 */

/** The Prisma read's arguments: `collectionSelect` plus the owner with their cosmetics. */
export const collectionByIdFindArgs = (id: number) =>
  ({
    where: { id },
    select: {
      ...collectionSelect,
      user: { select: userWithCosmeticsSelect },
    },
  } as const);

/** `null` when there is no such collection (`findUnique`). */
export function readCollectionByIdViaPrisma(db: Prisma.TransactionClient, id: number) {
  return db.collection.findUnique(collectionByIdFindArgs(id));
}

export type CollectionById = NonNullable<Awaited<ReturnType<typeof readCollectionByIdViaPrisma>>>;

type Row = NonNullable<Awaited<ReturnType<typeof getCollectionByIdRow>>>;

/**
 * The same collection from ONE statement (`getCollectionByIdRow`), `null` when there is no such
 * collection. Keys are built in the order the Prisma select lists them. The Prisma read has no
 * `orderBy`: the collection's tags come back in the order they were added ("createdAt", NULLs first,
 * then tag id), the cover's tags and the cosmetics in key order.
 */
export async function readCollectionByIdViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<CollectionById | null> {
  const row: Row | undefined = await getCollectionByIdRow(db, id);
  if (!row) return null;

  const collection = {
    id: row.id,
    name: row.name,
    description: row.description,
    read: row.read,
    write: row.write,
    type: row.type,
    nsfw: row.nsfw,
    nsfwLevel: row.nsfwLevel,
    // `imageSelect` (image.selector.ts), field for field.
    image:
      row.coverId !== null
        ? {
            id: row.coverId,
            name: row.coverName,
            url: row.coverUrl,
            nsfwLevel: row.coverNsfwLevel,
            width: row.coverWidth,
            height: row.coverHeight,
            hash: row.coverHash,
            meta: row.coverMeta,
            userId: row.coverUserId,
            generationProcess: row.coverGenerationProcess,
            needsReview: row.coverNeedsReview,
            scannedAt: row.coverScannedAt,
            ingestion: row.coverIngestion,
            blockedFor: row.coverBlockedFor,
            postId: row.coverPostId,
            type: row.coverType,
            metadata: row.coverMetadata,
            createdAt: row.coverCreatedAt,
            hideMeta: row.coverHideMeta,
            tags: row.coverTags.map((tag) => ({
              tag: {
                id: tag.tag.id,
                name: tag.tag.name,
                isCategory: tag.tag.isCategory,
                type: tag.tag.type,
              },
              automated: tag.automated,
              needsReview: tag.needsReview,
            })),
          }
        : null,
    mode: row.mode,
    metadata: row.metadata,
    availability: row.availability,
    archivedAt: row.archivedAt,
    userId: row.userId,
    tags: row.tags.map((tag) => ({
      tag: { id: tag.tag.id, name: tag.tag.name },
      filterableOnly: tag.filterableOnly,
    })),
    // `userWithCosmeticsSelect` (user.selector.ts), field for field.
    user: {
      id: row.ownerId,
      username: row.ownerUsername,
      deletedAt: row.ownerDeletedAt,
      image: row.ownerImage,
      // One payload for every viewer: no owner exception.
      profilePicture: servableProfilePicture(
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
        row.profilePictureNeedsReview
      ),
      cosmetics: row.cosmetics.map((cosmetic) => ({
        data: cosmetic.data,
        cosmetic: {
          id: cosmetic.cosmetic.id,
          data: cosmetic.cosmetic.data,
          type: cosmetic.cosmetic.type,
          source: cosmetic.cosmetic.source,
          name: cosmetic.cosmetic.name,
        },
      })),
    },
  };

  return collection as unknown as CollectionById;
}
