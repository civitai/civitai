import * as dbKysely from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { sql } from 'kysely';
import { assertLocalDatabase } from '../src/lib/dev/local-database';
import {
  FIXED_ITEMS,
  cosmeticItems,
  pickCosmetics,
  seedSql,
} from '../src/lib/server/shop/seed-items';

// Seeds the placeholder shop catalog. Safe to repeat: an existing item (and any price edited on it) is left alone.
//   pnpm run seed:shop              inserts into the local database named by DATABASE_URL
//   pnpm run seed:shop --print-sql  prints the SQL instead, to run through your own write path
async function main() {
  const connectionString = process.env.DATABASE_URL;
  assertLocalDatabase(connectionString);

  const { createKyselyClients } = (dbKysely as { default?: typeof dbKysely }).default ?? dbKysely;
  const { db } = createKyselyClients<DB>({
    connectionString,
    sslNoVerify: true,
    singleClient: true,
    max: 1,
  });
  try {
    // a few of each type, so a type with few cosmetics is not crowded out by one with thousands
    const cosmetics = (
      await Promise.all(
        ['Badge', 'NamePlate', 'ProfileDecoration', 'Sticker'].map((type) =>
          db
            .selectFrom('Cosmetic')
            .select(['id', 'name', 'type'])
            .where('source', '=', 'Purchase')
            .where('type', '=', type as 'Badge')
            .orderBy('id', 'desc')
            .limit(3)
            .execute()
        )
      )
    ).flat();
    const text = seedSql([...FIXED_ITEMS, ...cosmeticItems(pickCosmetics(cosmetics))]);
    if (process.argv.includes('--print-sql')) {
      console.log(text);
      return;
    }
    await sql.raw(text).execute(db);
    console.log('Shop catalog seeded.');
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
