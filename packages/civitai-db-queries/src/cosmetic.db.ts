import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// `Cosmetic.type`/`Cosmetic.source` enums, derived from the schema so this module needs no separate enum
// import.
type CosmeticTypeValue = DB['Cosmetic']['type'];
type CosmeticSourceValue = DB['Cosmetic']['source'];

export type CosmeticRow = {
  id: number;
  name: string;
  description: string | null;
  type: CosmeticTypeValue;
  source: CosmeticSourceValue;
  data: unknown;
};

export type GetPaginatedCosmeticsParams = {
  page?: number;
  limit?: number;
  name?: string;
  types?: CosmeticTypeValue[];
};

// A page of cosmetics, newest first, optionally filtered by a name substring (ilike) and/or a set of types.
// Runs a count then the items query and returns both for pagination.
export async function getPaginatedCosmetics(
  db: Kysely<DB>,
  { page = 1, limit = 60, name, types }: GetPaginatedCosmeticsParams
): Promise<{
  items: CosmeticRow[];
  totalItems: number;
  page: number;
  limit: number;
}> {
  const offset = (page - 1) * limit;

  let base = db.selectFrom('Cosmetic');
  if (name) base = base.where('name', 'ilike', `%${name}%`);
  if (types?.length) base = base.where('type', 'in', types);

  const totalItems = Number(
    (await base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst())?.count ?? 0
  );

  const items = (await base
    .select(['id', 'name', 'description', 'type', 'source', 'data'])
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()) as CosmeticRow[];

  return { items, totalItems, page, limit };
}

// The idempotent per-user grant insert: for one user, claim every listed cosmetic that still exists,
// skipping pairs the user already owns (ON CONFLICT DO NOTHING). Exported and callable on its own so this
// hand-written raw INSERT stays independently compile/EXPLAIN-testable — grantCosmeticsToUsers gates it behind
// existence reads that throw under the offline harness. Callers must pass a non-empty cosmeticIds
// (grantCosmeticsToUsers guards this) — an empty list compiles to `IN ()`.
export function insertUserCosmeticGrant(
  db: Kysely<DB>,
  { userId, cosmeticIds }: { userId: number; cosmeticIds: number[] }
) {
  return sql`
    INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
    SELECT ${userId}, c.id, 'claimed'
    FROM "Cosmetic" c
    WHERE c.id IN (${sql.join(cosmeticIds)})
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export type GrantResult = { totalPairs: number; alreadyOwned: number; newlyGranted: number };

// Grant the full cross-product (every cosmetic to every user). Validates the ids exist (throws naming the
// missing ones), counts already-owned pairs, then inserts idempotently per user. Pure internal Kysely write —
// no search-index/side-effect coupling. Mirrors the moderator app's grantCosmeticsToUsers.
export async function grantCosmeticsToUsers(
  db: Kysely<DB>,
  {
    cosmeticIds,
    userIds,
  }: {
    cosmeticIds: number[];
    userIds: number[];
  }
): Promise<GrantResult> {
  const uniqueUserIds = [...new Set(userIds)];
  const uniqueCosmeticIds = [...new Set(cosmeticIds)];

  if (!uniqueUserIds.length || !uniqueCosmeticIds.length)
    return { totalPairs: 0, alreadyOwned: 0, newlyGranted: 0 };

  const cosmetics = await db
    .selectFrom('Cosmetic')
    .select('id')
    .where('id', 'in', uniqueCosmeticIds)
    .execute();
  const missingCosmeticIds = uniqueCosmeticIds.filter((id) => !cosmetics.some((c) => c.id === id));
  if (missingCosmeticIds.length)
    throw new Error(`These cosmetics don't exist: ${missingCosmeticIds.join(', ')}`);

  const users = await db.selectFrom('User').select('id').where('id', 'in', uniqueUserIds).execute();
  const missingUserIds = uniqueUserIds.filter((id) => !users.some((u) => u.id === id));
  if (missingUserIds.length)
    throw new Error(`These users don't exist: ${missingUserIds.join(', ')}`);

  const owned = await db
    .selectFrom('UserCosmetic')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('userId', 'in', uniqueUserIds)
    .where('cosmeticId', 'in', uniqueCosmeticIds)
    .where('claimKey', '=', 'claimed')
    .executeTakeFirst();
  const alreadyOwned = Number(owned?.count ?? 0);

  for (const userId of uniqueUserIds) {
    await insertUserCosmeticGrant(db, { userId, cosmeticIds: uniqueCosmeticIds });
  }

  const totalPairs = uniqueUserIds.length * uniqueCosmeticIds.length;
  return { totalPairs, alreadyOwned, newlyGranted: totalPairs - alreadyOwned };
}
