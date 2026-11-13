import { dbMock } from '~/__tests__/mocks/db.mock';

export type UserCosmeticRow = {
  userId: number;
  cosmeticId: number;
  data: unknown;
  equippedAt: Date | null;
  equippedToId: number | null;
};

export type CosmeticRow = {
  id: number;
  name: string;
  type: string;
  source: string;
  data: unknown;
  flags: number;
};

type Where = Record<string, unknown>;

/**
 * Applies the user-cosmetic cache lookup's `where` the way Postgres would. A condition it cannot
 * evaluate matches nothing, so a changed lookup reads as an empty result rather than passing.
 */
function matches(row: UserCosmeticRow, where: Where) {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key as keyof UserCosmeticRow];
    if (condition === null) return value === null;
    if (condition && typeof condition === 'object') {
      if ('in' in condition) return (condition as { in: unknown[] }).in.includes(value);
      if ('not' in condition && (condition as { not: unknown }).not === null) return value !== null;
    }
    return false;
  });
}

const sqlText = (strings: readonly string[]) => strings.join('?');

/**
 * Backs the user cosmetic, cosmetic and profile-picture cache lookups with fixture rows, so a read
 * that fills users from those caches can be driven end to end on the canonical mocks. Each lookup
 * answers only for the ids it was given. `$queryRaw` statements other than the profile-picture one
 * resolve to `otherQueryRaw(...)`, `[]` by default.
 */
export function installUserCosmeticCacheFake({
  userCosmetics,
  cosmetics,
  profilePictures,
  otherQueryRaw = () => [],
}: {
  userCosmetics: UserCosmeticRow[];
  cosmetics: CosmeticRow[];
  profilePictures: ({ userId: number } & Record<string, unknown>)[];
  otherQueryRaw?: (strings: readonly string[], ...values: unknown[]) => unknown;
}) {
  dbMock.dbRead.userCosmetic.findMany.mockImplementation((async ({
    where = {},
  }: { where?: Where } = {}) =>
    userCosmetics
      .filter((row) => matches(row, where))
      .map(({ userId, cosmeticId, data }) => ({ userId, cosmeticId, data }))) as never);

  dbMock.dbRead.cosmetic.findMany.mockImplementation((async ({
    where = {},
  }: { where?: Where } = {}) => {
    // The withheld check asks only about creator-made cosmetics; these fixtures are not.
    const ids = (where.id as { in?: number[] } | undefined)?.in;
    if ('createdById' in where || !ids) return [];
    return cosmetics.filter((x) => ids.includes(x.id));
  }) as never);

  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: readonly string[],
    ...values: unknown[]
  ) => {
    if (!sqlText(strings).includes('JOIN "Image" i ON i.id = u."profilePictureId"'))
      return otherQueryRaw(strings, ...values);
    const joined = values.find(
      (v): v is { values: number[] } => !!v && typeof v === 'object' && 'values' in v
    );
    if (!joined) throw new Error('userCosmeticCacheFake: the profile-picture read carried no ids');
    return profilePictures.filter((x) => joined.values.includes(x.userId));
  }) as never);
}
