import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});

const { updateImagesFlag } = await import('~/server/services/image.service');

// 1 shares its url with 3, a CSAM block, so it is withheld from a moderator without the grant.
const WITHHELD = 1;
const PLAIN = 2;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    ${CSAM_LINK_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, "needsReview" text, "blockedFor" text,
      "userId" int, "pHash" bigint, poi boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      "updatedAt" timestamp(3));
    ${WITHHELD_TABLES_SQL}
  `);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "Image";
    INSERT INTO "Image" (id, url, "blockedFor", "userId", poi) VALUES
      (${WITHHELD}, 'shared', NULL, 7, true),
      (${PLAIN}, 'plain', NULL, 7, true),
      (3, 'shared', 'CSAM', 8, false);
  `);
});

const poi = async () =>
  (
    await holder.db.query<{ id: number; poi: boolean }>(
      `SELECT id, poi FROM "Image" WHERE id = ANY($1) ORDER BY id`,
      [[WITHHELD, PLAIN]]
    )
  ).rows.map((row) => [row.id, row.poi]);

// The route checks first; this is the write, for an image that became withheld after that check.
describe('clearing a flag', () => {
  it('leaves an image withheld from the moderator flagged without the grant', async () => {
    const written = await updateImagesFlag({
      ids: [WITHHELD, PLAIN],
      flag: 'poi',
      value: false,
      withheldFor: { csamReview: false },
    });
    expect(written).toEqual([PLAIN]);
    expect(await poi()).toEqual([
      [WITHHELD, true],
      [PLAIN, false],
    ]);
  });

  it('stamps updatedAt on the rows it writes, as the Prisma path does', async () => {
    await updateImagesFlag({
      ids: [WITHHELD, PLAIN],
      flag: 'poi',
      value: false,
      withheldFor: { csamReview: false },
    });
    const { rows } = await holder.db.query<{ id: number; stamped: boolean }>(
      `SELECT id, "updatedAt" IS NOT NULL AS stamped FROM "Image" WHERE id = ANY($1) ORDER BY id`,
      [[WITHHELD, PLAIN]]
    );
    expect(rows.map((row) => [row.id, row.stamped])).toEqual([
      [WITHHELD, false],
      [PLAIN, true],
    ]);
  });

  it('clears both for a moderator holding the grant', async () => {
    const written = await updateImagesFlag({
      ids: [WITHHELD, PLAIN],
      flag: 'poi',
      value: false,
      withheldFor: { csamReview: true },
    });
    expect(written.sort()).toEqual([WITHHELD, PLAIN]);
    expect(await poi()).toEqual([
      [WITHHELD, false],
      [PLAIN, false],
    ]);
  });
});
