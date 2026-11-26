import type { PGlite } from '@electric-sql/pglite';

/** The pglite stand-ins have no creator columns or creator-shop listings; adds the parts the "in review" rule reads. */
export async function addCreatorShopStandIns(pg: PGlite) {
  await pg.exec(`
    ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "createdById" INTEGER;
    ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "flags" INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS "CosmeticShopItem" (
      "id" INTEGER PRIMARY KEY,
      "cosmeticId" INTEGER REFERENCES "Cosmetic"("id") ON DELETE CASCADE,
      "unitAmount" INTEGER NOT NULL DEFAULT 0,
      "addedById" INTEGER,
      "title" TEXT NOT NULL DEFAULT '',
      "status" TEXT NOT NULL DEFAULT 'Published',
      "meta" JSONB NOT NULL DEFAULT '{}',
      "rejectionReason" TEXT
    );`);
}
