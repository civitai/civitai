import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';
import { CONFIRM_LEASE_MS } from '../constants';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { answerConfirm, claimNext, enqueueConfirm, itemForToken } = await import(
  '../confirm.service'
);
const { pageCard } = await import('../card');

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(
    HERE,
    '../../../../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_new_order_confirm_queue/migration.sql'
  ),
  'utf8'
);

const NOW = new Date('2026-10-13T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

const PG = 1;
const PG13 = 2;
const R = 4;

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(`
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL DEFAULT 'u', "type" TEXT NOT NULL DEFAULT 'image',
      "name" TEXT, "width" INTEGER, "height" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pg.exec(MIGRATION);
  dbHandle.current = new Kysely<DB>({ dialect: pgliteDialect(pg) });
});

async function seed(imageId: number, level: number, modId: number, at = NOW) {
  await pg.query(
    `INSERT INTO "Image" ("id", "url", "nsfwLevel") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [imageId, `key-${imageId}`, level]
  );
  return enqueueConfirm({ imageId, level, modId, at });
}

const row = async (imageId: number) =>
  (
    await pg.query<Record<string, unknown>>(
      `SELECT * FROM "NewOrderConfirmItem" WHERE "imageId" = $1 ORDER BY id DESC`,
      [imageId]
    )
  ).rows[0];

describe('enqueueConfirm', () => {
  it('records the level the first moderator set, who set it and when', async () => {
    expect(await seed(10, R, 7)).toBe(true);
    const item = await row(10);
    expect(item).toMatchObject({ imageId: 10, firstLevel: R, firstModId: 7, status: 'open' });
    expect(new Date(item.firstSetAt as string).toISOString()).toBe(NOW.toISOString());
  });

  it('keeps a single open item per image', async () => {
    await seed(10, R, 7);
    expect(await seed(10, PG, 8)).toBe(false);
    const { rows } = await pg.query(`SELECT * FROM "NewOrderConfirmItem"`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstLevel: R, firstModId: 7 });
  });
});

describe('claimNext', () => {
  it('never serves the moderator who set the level', async () => {
    await seed(10, R, 7);
    expect(await claimNext(7, NOW)).toBeNull();
    expect(await claimNext(8, NOW)).not.toBeNull();
  });

  it('serves the oldest item first', async () => {
    await seed(10, R, 7, later(5000));
    await seed(11, R, 7, NOW);
    expect((await claimNext(8, NOW))!.imageId).toBe(11);
  });

  it('skips images the moderator already answered on an earlier item', async () => {
    await seed(10, R, 7);
    const first = (await claimNext(8, NOW))!;
    await answerConfirm({ token: first.token, userId: 8, level: PG }, NOW);
    await seed(10, R, 9, later(1000));
    await seed(11, R, 9, later(2000));
    expect((await claimNext(8, later(3000)))!.imageId).toBe(11);
  });

  it('hands out an item to one moderator at a time while the lease is live', async () => {
    await seed(10, R, 7);
    expect(await claimNext(8, NOW)).not.toBeNull();
    expect(await claimNext(9, later(1000))).toBeNull();
    expect(await claimNext(9, later(CONFIRM_LEASE_MS + 1))).not.toBeNull();
  });

  it('returns the same card on a reload instead of taking a second lease', async () => {
    await seed(10, R, 7);
    await seed(11, R, 7, later(1000));
    const a = (await claimNext(8, NOW))!;
    const b = (await claimNext(8, later(500)))!;
    expect(b.token).toBe(a.token);
    const { rows } = await pg.query(`SELECT * FROM "NewOrderConfirmClaim" WHERE "userId" = 8`);
    expect(rows).toHaveLength(1);
  });

  it('skips items that are no longer open', async () => {
    await seed(10, R, 7);
    await seed(11, R, 7, later(1000));
    const a = (await claimNext(8, NOW))!;
    await answerConfirm({ token: a.token, userId: 8, level: R }, later(100));
    expect((await claimNext(8, later(200)))!.imageId).toBe(11);
  });
});

describe('the blind card', () => {
  it('carries neither the first moderator level nor the image level', async () => {
    await seed(10, R, 7);
    const card = pageCard((await claimNext(8, NOW))!);
    expect(Object.keys(card).sort()).toEqual(
      ['height', 'leaseExpiresAt', 'name', 'token', 'type', 'url', 'width'].sort()
    );
    expect(JSON.stringify(card)).not.toMatch(/level/i);
  });

  it('does not select either level or the first moderator from the database', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))! as Record<string, unknown>;
    expect(card).not.toHaveProperty('firstLevel');
    expect(card).not.toHaveProperty('nsfwLevel');
    expect(card).not.toHaveProperty('firstModId');
  });
});

describe('answerConfirm', () => {
  it('agrees when the second level matches the first', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))!;
    const result = await answerConfirm({ token: card.token, userId: 8, level: R }, later(1000));
    expect(result).toEqual({ ok: true, outcome: 'agreed' });
    expect(await row(10)).toMatchObject({ status: 'agreed', secondLevel: R, secondModId: 8 });
    expect(new Date((await row(10)).secondAt as string).toISOString()).toBe(
      later(1000).toISOString()
    );
  });

  it('drops the item when the levels differ, with no tiebreak', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))!;
    const result = await answerConfirm({ token: card.token, userId: 8, level: PG13 }, later(1000));
    expect(result).toEqual({ ok: true, outcome: 'disagreed' });
    expect(await row(10)).toMatchObject({ status: 'disagreed', secondLevel: PG13 });
    expect(await claimNext(9, later(2000))).toBeNull();
  });

  it('refuses a token that is not the moderator’s own', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))!;
    expect(await answerConfirm({ token: card.token, userId: 9, level: R }, NOW)).toEqual({
      ok: false,
      reason: 'not-yours',
    });
    expect((await row(10)).status).toBe('open');
  });

  it('refuses the moderator who set the level, even holding a claim', async () => {
    await seed(10, R, 7);
    await pg.query(
      `INSERT INTO "NewOrderConfirmClaim" ("itemId", "userId", "expiresAt", "token")
       VALUES (1, 7, $1, '00000000-0000-4000-8000-000000000001')`,
      [later(60_000).toISOString()]
    );
    expect(
      await answerConfirm(
        { token: '00000000-0000-4000-8000-000000000001', userId: 7, level: R },
        NOW
      )
    ).toEqual({ ok: false, reason: 'own-rating' });
    expect((await row(10)).status).toBe('open');
  });

  it('refuses a second answer on the same item', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))!;
    await answerConfirm({ token: card.token, userId: 8, level: R }, NOW);
    expect(await answerConfirm({ token: card.token, userId: 8, level: PG }, NOW)).toEqual({
      ok: false,
      reason: 'not-open',
    });
    expect((await row(10)).status).toBe('agreed');
  });

  it('refuses an answer once the lease expired, even before anyone else claims the item', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))!;
    expect(
      await answerConfirm({ token: card.token, userId: 8, level: R }, later(CONFIRM_LEASE_MS + 1))
    ).toEqual({ ok: false, reason: 'expired' });
    expect((await row(10)).status).toBe('open');
  });

  it('refuses the first moderator once a second moderator holds the item', async () => {
    await seed(10, R, 7);
    const stale = (await claimNext(8, NOW))!;
    const after = later(CONFIRM_LEASE_MS + 1);
    expect(await claimNext(9, after)).not.toBeNull();
    expect(await answerConfirm({ token: stale.token, userId: 8, level: R }, after)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect((await row(10)).status).toBe('open');
  });

  it('refuses a level a moderator cannot rate', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))!;
    expect(await answerConfirm({ token: card.token, userId: 8, level: 32 }, NOW)).toEqual({
      ok: false,
      reason: 'invalid-level',
    });
  });

  it('resolves the item from the token for the moderator it was minted for only', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))!;
    expect(await itemForToken(card.token, 8, NOW)).toBe(card.itemId);
    expect(await itemForToken(card.token, 9, NOW)).toBeNull();
  });

  it('does not resolve a token whose lease expired', async () => {
    await seed(10, R, 7);
    const card = (await claimNext(8, NOW))!;
    expect(await itemForToken(card.token, 8, later(CONFIRM_LEASE_MS + 1))).toBeNull();
  });
});
