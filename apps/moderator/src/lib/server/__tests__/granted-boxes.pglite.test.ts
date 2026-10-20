import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modGrantSourceKey } from '@civitai/shared/mystery-box';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The User Lookup list of boxes a moderator granted: what it lists decides what can be taken back, so
 * a bought box must not appear in it, nor anyone else's.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { getGrantedBoxes } = await import('../user-account.service');

const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

const USER = 5150;
const OTHER = 6160;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Cosmetic" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "CosmeticShopItem" (
      "id" INTEGER PRIMARY KEY,
      "cosmeticId" INTEGER,
      "title" TEXT NOT NULL DEFAULT 'listing',
      "listed" BOOLEAN NOT NULL DEFAULT true
    );
  `);
  await db.exec(migration('20261105120000_mystery_box_items'));
  await db.exec(migration('20261107120000_mystery_box_listing_unlisted_and_refunds'));
  await db.exec(`
    INSERT INTO "Cosmetic" ("id") VALUES (500), (501);
    INSERT INTO "ItemDefinition" ("id", "type", "name", "status") VALUES (1, 'box', 'Party Box', 'published');
    INSERT INTO "ItemDefinition" ("id", "type", "name", "cosmeticId") VALUES
      (2, 'cosmetic', 'Blue cap', 500), (3, 'cosmetic', 'Pink cap', 501);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const hold = (sourceKey: string, userId = USER, at = '2026-11-08T10:00:00Z') =>
  db.query(
    `INSERT INTO "Item" ("itemDefinitionId", "holderType", "holderId", "sourceKey", "createdAt")
     VALUES (1, 'user', $1, $2, $3)`,
    [userId, sourceKey, at]
  );
const opened = (
  boxItemId: number,
  sourceKey: string,
  rewardStatus: string,
  at: string,
  rewardDefinitionId = 2
) =>
  db.query(
    `INSERT INTO "BoxOpening" ("boxItemId", "boxDefinitionId", "boxVersion", "userId", "boxSourceKey",
       "tierId", "contentId", "rewardDefinitionId", "rewardType", "tierWeight", "eligibleWeight",
       "tierRoll", "tierPoolSize", "itemRoll", "rewardStatus", "createdAt")
     VALUES ($1, 1, 1, $2, $3, 1, 1, $6, 'cosmetic', 1, 1, 0, 1, 0, $4, $5)`,
    [boxItemId, USER, sourceKey, rewardStatus, at, rewardDefinitionId]
  );

describe('getGrantedBoxes', () => {
  it('lists held, opened and taken-back granted boxes, newest first', async () => {
    await hold(modGrantSourceKey('g1', USER, 1), USER, '2026-11-08T10:00:00Z');
    await opened(77, modGrantSourceKey('g1', USER, 2), 'granted', '2026-11-08T11:00:00Z');
    await opened(78, modGrantSourceKey('g2', USER, 1), 'refunded', '2026-11-08T09:00:00Z', 3);

    const { items, truncated } = await getGrantedBoxes(USER);
    expect(truncated).toBe(false);
    expect(
      items.map(({ sourceKey, boxName, state, reward }) => [sourceKey, boxName, state, reward])
    ).toEqual([
      [modGrantSourceKey('g1', USER, 2), 'Party Box', 'opened', 'Blue cap'],
      [modGrantSourceKey('g1', USER, 1), 'Party Box', 'held', null],
      [modGrantSourceKey('g2', USER, 1), 'Party Box', 'takenBack', 'Pink cap'],
    ]);
  });

  it("leaves out bought boxes and other users' granted ones", async () => {
    await hold('item-purchase-v1-5150-10-key');
    await opened(79, 'item-purchase-v1-5150-10-other', 'granted', '2026-11-08T12:00:00Z');
    await hold(modGrantSourceKey('g1', OTHER, 1), OTHER);

    expect((await getGrantedBoxes(USER)).items).toEqual([]);
    // Control: the same reads find a granted box of this user's.
    await hold(modGrantSourceKey('g1', USER, 1));
    expect((await getGrantedBoxes(USER)).items).toHaveLength(1);
  });

  it('says when it shows only the latest', async () => {
    for (let n = 1; n <= 3; n++) await hold(modGrantSourceKey('g1', USER, n));
    const { items, truncated } = await getGrantedBoxes(USER, 2);
    expect(items).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});
