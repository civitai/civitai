import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import type { CosmeticType } from '$lib/cosmetics';

export type CosmeticRow = {
  id: number;
  name: string;
  description: string | null;
  type: CosmeticType;
  source: string;
  data: unknown;
};

export async function getPaginatedCosmetics({
  page = 1,
  limit = 60,
  name,
  types,
}: {
  page?: number;
  limit?: number;
  name?: string;
  types?: CosmeticType[];
}): Promise<{ items: CosmeticRow[]; totalItems: number; page: number; limit: number }> {
  const offset = (page - 1) * limit;

  let base = dbRead.selectFrom('Cosmetic');
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

export type GrantResult = { totalPairs: number; alreadyOwned: number; newlyGranted: number };

// Grant the full cross-product (every cosmetic to every user). Validates ids exist (reports which are
// missing), counts already-owned pairs, then inserts idempotently (ON CONFLICT DO NOTHING). Pure internal
// Kysely write — no main-app call (cosmetics aren't in the search index). Mirrors the main app's
// grantCosmeticsToUsers.
export async function grantCosmeticsToUsers({
  cosmeticIds,
  userIds,
}: {
  cosmeticIds: number[];
  userIds: number[];
}): Promise<GrantResult> {
  const uniqueUserIds = [...new Set(userIds)];
  const uniqueCosmeticIds = [...new Set(cosmeticIds)];

  const cosmetics = await dbRead
    .selectFrom('Cosmetic')
    .select('id')
    .where('id', 'in', uniqueCosmeticIds)
    .execute();
  const missingCosmeticIds = uniqueCosmeticIds.filter((id) => !cosmetics.some((c) => c.id === id));
  if (missingCosmeticIds.length)
    throw new Error(`These cosmetics don't exist: ${missingCosmeticIds.join(', ')}`);

  const users = await dbRead
    .selectFrom('User')
    .select('id')
    .where('id', 'in', uniqueUserIds)
    .execute();
  const missingUserIds = uniqueUserIds.filter((id) => !users.some((u) => u.id === id));
  if (missingUserIds.length)
    throw new Error(`These users don't exist: ${missingUserIds.join(', ')}`);

  const owned = await dbWrite
    .selectFrom('UserCosmetic')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('userId', 'in', uniqueUserIds)
    .where('cosmeticId', 'in', uniqueCosmeticIds)
    .where('claimKey', '=', 'claimed')
    .executeTakeFirst();
  const alreadyOwned = Number(owned?.count ?? 0);

  for (const userId of uniqueUserIds) {
    await sql`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
      SELECT ${userId}, c.id, 'claimed'
      FROM "Cosmetic" c
      WHERE c.id IN (${sql.join(uniqueCosmeticIds)})
      ON CONFLICT DO NOTHING
    `.execute(dbWrite);
  }

  const totalPairs = uniqueUserIds.length * uniqueCosmeticIds.length;
  return { totalPairs, alreadyOwned, newlyGranted: totalPairs - alreadyOwned };
}
