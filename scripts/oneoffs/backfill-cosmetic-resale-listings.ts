/**
 * Migrate cross-creator resale listings out of `User.settings.creatorShop
 * .resoldItemIds` (the old JSON blob) into the `UserCosmeticShopItemResale`
 * table. Run right after migration 20260805120000_add_cosmetic_shop_item_resale:
 * until it finishes, resellers who listed under the old scheme have no rows, so
 * their storefront's resold section reads empty and a sale through it pays them
 * no seller share.
 *
 * Each row is written with:
 *   sellerShare — the item's CURRENT `meta.sellerShare`. The old scheme kept no
 *                 per-listing record, so this is the only terms these listings
 *                 ever had. Anything the original creator changes after this
 *                 script runs is grandfathered against the value captured here.
 *   index       — the listing's position in the old array, so each creator's
 *                 chosen storefront order survives.
 *
 * Ids in the blob that no longer resolve to a CosmeticShopItem are dropped
 * (the item was deleted; the lookups used to skip them at read time).
 *
 * Usage:
 *   pnpm tsscript scripts/oneoffs/backfill-cosmetic-resale-listings.ts [options]
 *
 * Options:
 *   --dry-run      Report what would be inserted, write nothing.
 *   --verify       Compare blobs against rows and report any mismatch. Implies
 *                  no writes. Run after a real pass to confirm it took.
 *   --prune        Delete the legacy `resoldItemIds` key from every settings
 *                  blob. Refuses to run unless --verify would pass, so it can
 *                  only ever run on data that's already migrated. Do this in a
 *                  separate pass, once the table has proven itself.
 *   --chunk-size=N Users per batch (default 500).
 *   --min-id=N     Resume cursor (inclusive).
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isVerify = args.includes('--verify');
const isPrune = args.includes('--prune');
const chunkArg = args.find((a) => a.startsWith('--chunk-size='));
const minIdArg = args.find((a) => a.startsWith('--min-id='));
const CHUNK = chunkArg ? parseInt(chunkArg.split('=')[1], 10) : 500;
const MIN_ID = minIdArg ? parseInt(minIdArg.split('=')[1], 10) : 0;

const prisma = new PrismaClient();

// Every user still carrying a non-empty legacy array, with the ids in order.
const LEGACY_USERS_SQL = `
  SELECT u.id, array_agg(resold.shop_item_id::int ORDER BY resold.ordinality) AS "shopItemIds"
  FROM "User" u
  CROSS JOIN LATERAL jsonb_array_elements_text(
    jsonb_extract_path(u.settings::jsonb, 'creatorShop', 'resoldItemIds')
  ) WITH ORDINALITY AS resold(shop_item_id, ordinality)
  WHERE jsonb_typeof(jsonb_extract_path(u.settings::jsonb, 'creatorShop', 'resoldItemIds')) = 'array'
    AND u.id >= $1
  GROUP BY u.id
  ORDER BY u.id ASC
  LIMIT $2`;

// Same source, but writing straight into the table so the whole batch is one
// statement. ON CONFLICT DO NOTHING makes re-runs (and a partial first run)
// safe: a listing already in the table keeps the share it was written with.
const INSERT_SQL = `
  INSERT INTO "UserCosmeticShopItemResale" ("userId", "shopItemId", "sellerShare", "index")
  SELECT u.id,
         si.id,
         COALESCE((si.meta ->> 'sellerShare')::int, 0),
         (resold.ordinality - 1)::int
  FROM "User" u
  CROSS JOIN LATERAL jsonb_array_elements_text(
    jsonb_extract_path(u.settings::jsonb, 'creatorShop', 'resoldItemIds')
  ) WITH ORDINALITY AS resold(shop_item_id, ordinality)
  JOIN "CosmeticShopItem" si ON si.id = resold.shop_item_id::int
  WHERE u.id = ANY($1::int[])
  ON CONFLICT ("userId", "shopItemId") DO NOTHING`;

// The `creatorShop` guard is not redundant: jsonb_set is STRICT, so on a user
// without that key the new_value is NULL and the statement nulls their ENTIRE
// settings blob. The caller can't reach such a user today (they wouldn't be in
// the legacy scan), which is exactly why the footgun would go unnoticed.
const PRUNE_SQL = `
  UPDATE "User"
  SET settings = jsonb_set(
    settings::jsonb,
    '{creatorShop}',
    (settings::jsonb -> 'creatorShop') - 'resoldItemIds'
  )
  WHERE id = ANY($1::int[])
    AND jsonb_typeof(settings::jsonb -> 'creatorShop') = 'object'`;

type LegacyUser = { id: number; shopItemIds: number[] };

const pageLegacyUsers = (cursor: number) =>
  prisma.$queryRawUnsafe<LegacyUser[]>(LEGACY_USERS_SQL, cursor, CHUNK);

/**
 * Every legacy id that should have produced a row but didn't. Ids whose item is
 * gone are expected misses, not failures — they're excluded here the same way
 * the INSERT's join excludes them.
 */
async function findMissing(users: LegacyUser[]) {
  const userIds = users.map((u) => u.id);
  const rows = await prisma.userCosmeticShopItemResale.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, shopItemId: true },
  });
  const have = new Set(rows.map((r) => `${r.userId}:${r.shopItemId}`));

  const legacyItemIds = [...new Set(users.flatMap((u) => u.shopItemIds))];
  const live = new Set(
    (
      await prisma.cosmeticShopItem.findMany({
        where: { id: { in: legacyItemIds } },
        select: { id: true },
      })
    ).map((i) => i.id)
  );

  return users.flatMap((u) =>
    u.shopItemIds
      .filter((shopItemId) => live.has(shopItemId) && !have.has(`${u.id}:${shopItemId}`))
      .map((shopItemId) => ({ userId: u.id, shopItemId }))
  );
}

async function main() {
  const mode = isVerify ? 'verify' : isPrune ? 'prune' : isDryRun ? 'dry-run' : 'write';
  console.log(`[resale-backfill] mode=${mode} chunk=${CHUNK} minId=${MIN_ID}`);

  let cursor = MIN_ID;
  let users = 0;
  let listings = 0;
  let inserted = 0;
  const missing: { userId: number; shopItemId: number }[] = [];

  while (true) {
    const page = await pageLegacyUsers(cursor);
    if (!page.length) break;

    users += page.length;
    listings += page.reduce((sum, u) => sum + u.shopItemIds.length, 0);
    const ids = page.map((u) => u.id);

    if (mode === 'write') {
      inserted += await prisma.$executeRawUnsafe(INSERT_SQL, ids);
    }
    // Prune has to prove the rows exist before it throws the blob away, so it
    // verifies the same way --verify does and aborts the whole run on a miss.
    if (mode === 'verify' || mode === 'prune') {
      const gaps = await findMissing(page);
      missing.push(...gaps);
      if (mode === 'prune' && gaps.length) break;
      if (mode === 'prune') await prisma.$executeRawUnsafe(PRUNE_SQL, ids);
    }

    cursor = ids[ids.length - 1] + 1;
    console.log(`[resale-backfill] users=${users} listings=${listings} cursor=${cursor}`);
  }

  console.log(
    `[resale-backfill] done. users=${users} legacyListings=${listings}` +
      (mode === 'write' ? ` inserted=${inserted}` : '')
  );

  if (mode === 'verify' || mode === 'prune') {
    if (missing.length) {
      console.error(`[resale-backfill] MISSING ${missing.length} listing(s):`);
      for (const m of missing.slice(0, 50))
        console.error(`  user=${m.userId} item=${m.shopItemId}`);
      if (missing.length > 50) console.error(`  …and ${missing.length - 50} more`);
      console.error(
        mode === 'prune'
          ? '[resale-backfill] pruned nothing past this point — run without --prune first.'
          : '[resale-backfill] re-run without --verify to insert them.'
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    console.log('[resale-backfill] every legacy listing has a row.');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
