import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonBuildObject } from './infra/helpers';

// `userWithCosmeticsSelect` (<civitai>/src/server/selectors/user.selector.ts) as ONE statement,
// behind the default-off server Flipt flag `kysely-hot-reads-12`. Prisma reads that select as one
// statement per relation: the user, its profile picture ("Image"), its equipped "UserCosmetic"
// rows, and their "Cosmetic" rows. The app-side wrappers
// (<civitai>/src/server/services/hot-reads-12.reads.ts) map these rows to the exact Prisma payload,
// and <civitai>/src/server/services/__tests__/hot-reads-12.kysely-parity.test.ts compares the two
// against a real database.
//
// Shape notes, each pinned by the parity suite:
// - The profile picture is a LEFT JOIN, so a dangling "profilePictureId" reads as no picture, as
//   in Prisma. Its columns are top-level, so the timestamps and JSON go through the pg parsers
//   @civitai/db/kysely registers. "needsReview" is read for the servable check only; the wrapper
//   drops it, as Prisma's servable-profile-picture extension does.
// - The equipped cosmetics are a correlated `json_agg` subquery (`equippedAt IS NOT NULL AND
//   equippedToId IS NULL`, the select's own filter). Every column in it survives JSON unchanged
//   (JSON columns, integers, text, enums as text); none is a timestamp. Prisma's nested read has
//   no `orderBy`; this one is ordered by the table's key (cosmetic id, then claim key) so it is
//   defined. The parity suite compares the lists sorted.
// - The user ids are ONE array parameter (`= ANY($1)`), so the statement text does not vary with
//   the number of users.
//
// Relations: base tables only, none declared `/// @view`.

/** One equipped cosmetic as the aggregate builds it. */
export type UserWithCosmeticsCosmeticJson = {
  data: unknown;
  cosmetic: { id: number; data: unknown; type: string; source: string; name: string };
};

function usersWithCosmeticsQuery(db: Kysely<DB>) {
  return (
    db
      .selectFrom('User')
      .leftJoin('Image as ProfilePicture', 'ProfilePicture.id', 'User.profilePictureId')
      .select((eb) => [
        'User.id',
        'User.username',
        'User.deletedAt',
        'User.image',
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
          .whereRef('UserCosmetic.userId', '=', 'User.id')
          .where('UserCosmetic.equippedAt', 'is not', null)
          .where('UserCosmetic.equippedToId', 'is', null)
          .$castTo<{ cosmetics: UserWithCosmeticsCosmeticJson[] }>()
          .as('cosmetics'),
      ])
      // An aggregate always yields one row and `coalesce` turns an empty one into `[]`, so the array
      // is never null. A type-only narrowing; no SQL changes.
      .$narrowType<{ cosmetics: UserWithCosmeticsCosmeticJson[] }>()
  );
}

/** The `userWithCosmeticsSelect` columns of each of `userIds` that exists, in one statement. */
export function listUsersWithCosmeticsRows(db: Kysely<DB>, userIds: number[]) {
  return usersWithCosmeticsQuery(db)
    .where((eb) => eb('User.id', '=', eb.fn.any(eb.val(userIds))))
    .orderBy('User.id', 'asc')
    .execute();
}

export type UserWithCosmeticsRow = Awaited<ReturnType<typeof listUsersWithCosmeticsRows>>[number];

/**
 * `model.getSimple`'s read (`getSimpleModelWithVersions`, <civitai>/src/server/services/
 * model.service.ts): the model's id, name, createdAt, locked and status, and its owner with
 * `userWithCosmeticsSelect`, in one statement. The owner is an INNER JOIN: Prisma's `user`
 * relation is required ("Model"."userId" is NOT NULL with a foreign key), so a model always has
 * one. `undefined` when there is no such model.
 */
export function getSimpleModelWithOwnerRow(db: Kysely<DB>, modelId: number) {
  return usersWithCosmeticsQuery(db)
    .innerJoin('Model', 'Model.userId', 'User.id')
    .select([
      'Model.id as modelId',
      'Model.name as modelName',
      'Model.createdAt as modelCreatedAt',
      'Model.locked as modelLocked',
      'Model.status as modelStatus',
    ])
    .where('Model.id', '=', modelId)
    .executeTakeFirst();
}
