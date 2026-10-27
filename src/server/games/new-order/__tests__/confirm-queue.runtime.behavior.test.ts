import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { MAX_POOL_ATTEMPTS, runConfirmSync } from '~/server/games/new-order/confirm-queue';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/games/new-order/utils', () => ({ poolCounters: {} }));
vi.mock('~/server/services/games/new-order.service', () => ({
  addImageToQueue: vi.fn(),
  manageSanityChecks: vi.fn(),
}));

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

dbMock.dbWrite.$executeRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['executeRaw']>
) => pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) => pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (
  fn: (tx: {
    $executeRaw: ReturnType<typeof pgliteRaw>['executeRaw'];
    $queryRaw: ReturnType<typeof pgliteRaw>['queryRaw'];
  }) => Promise<unknown>
) =>
  holder.db.transaction(async (t) => {
    const raw = pgliteRaw(t as unknown as PGlite);
    return fn({ $executeRaw: raw.executeRaw, $queryRaw: raw.queryRaw });
  })) as never);

const { confirmStore, enqueueConfirmItems } = await import(
  '~/server/games/new-order/confirm-queue.runtime'
);

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_knights_confirm_queue/migration.sql'
);

const NOW = new Date('2026-10-30T12:00:00.000Z');
const PG = 1;
const R = 4;
const BLOCKED = 32;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY, "url" text NOT NULL, "nsfwLevel" integer NOT NULL DEFAULT 0
    );
    CREATE SCHEMA label_store;
    CREATE TABLE label_store.recorded (ref text PRIMARY KEY, value text, labeller int);
    CREATE TABLE label_store.fail_for (itemId int);
    CREATE FUNCTION label_store.text_hash(t text) RETURNS text LANGUAGE sql AS $$ SELECT md5(t) $$;
    -- Stands in for the real function: records by ref, and raises for items listed in fail_for.
    CREATE FUNCTION label_store.record_label(
      p_subject_type text, p_subject_id text, p_content_hash text, p_family text, p_question text,
      p_value text, p_labeller_kind text, p_labeller_user_id int, p_source_ref text,
      p_labelled_at timestamptz, p_snapshot jsonb
    ) RETURNS bigint LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM label_store.fail_for f
        WHERE p_source_ref LIKE 'KnightsConfirm:' || f.itemId || ':%'
      ) THEN RAISE EXCEPTION 'label store down'; END IF;
      INSERT INTO label_store.recorded VALUES (p_source_ref, p_value, p_labeller_user_id)
        ON CONFLICT DO NOTHING;
      RETURN 1;
    END $$;
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(
    `TRUNCATE "KnightsConfirmItem", "Image", label_store.recorded, label_store.fail_for RESTART IDENTITY CASCADE`
  );
});

const image = (id: number, level = R) =>
  holder.db.query(`INSERT INTO "Image" (id, url, "nsfwLevel") VALUES ($1, $2, $3)`, [
    id,
    `key-${id}`,
    level,
  ]);

const items = async () =>
  (await holder.db.query<Record<string, unknown>>(`SELECT * FROM "KnightsConfirmItem" ORDER BY id`))
    .rows;

async function agreeItem(imageId: number, level = R) {
  await enqueueConfirmItems([{ imageId, level }], 1, NOW);
  await holder.db.query(
    `UPDATE "KnightsConfirmItem" SET status = 'agreed', "secondLevel" = "firstLevel",
       "secondModId" = 2, "secondAt" = $2 WHERE "imageId" = $1 AND status = 'open'`,
    [imageId, NOW.toISOString()]
  );
}

describe('enqueueConfirmItems', () => {
  it('queues each image once at the level the moderator set', async () => {
    await image(10);
    await image(11, PG);
    await enqueueConfirmItems(
      [
        { imageId: 10, level: R },
        { imageId: 11, level: PG },
      ],
      7,
      NOW
    );

    expect(await items()).toMatchObject([
      { imageId: 10, firstLevel: R, firstModId: 7, status: 'open' },
      { imageId: 11, firstLevel: PG, firstModId: 7, status: 'open' },
    ]);
  });

  it('keeps one open item per image when the level changes again before anyone confirms', async () => {
    await image(10);
    await enqueueConfirmItems([{ imageId: 10, level: R }], 7, NOW);
    await enqueueConfirmItems([{ imageId: 10, level: PG }], 8, NOW);

    expect(await items()).toMatchObject([{ imageId: 10, firstLevel: R, firstModId: 7 }]);
  });

  it('queues the image again once the earlier item has been answered', async () => {
    await image(10);
    await agreeItem(10);
    await enqueueConfirmItems([{ imageId: 10, level: R }], 7, NOW);

    expect((await items()).map((i) => i.status)).toEqual(['agreed', 'open']);
  });

  it('keeps blocked and unrated levels out of the queue', async () => {
    await image(10);
    await image(11);
    await enqueueConfirmItems(
      [
        { imageId: 10, level: BLOCKED },
        { imageId: 11, level: 0 },
      ],
      7,
      NOW
    );

    expect(await items()).toEqual([]);
  });
});

describe('markPooled', () => {
  const agreedItem = async (imageId = 10) => {
    await image(imageId);
    await agreeItem(imageId);
    const [item] = await confirmStore.agreedUnpooled();
    return item;
  };

  it('stamps pooledAt and records both judgments under their refs', async () => {
    const item = await agreedItem();

    expect(await confirmStore.markPooled(item, NOW)).toBe(true);

    expect((await items())[0].pooledAt).not.toBeNull();
    const refs = (await holder.db.query<{ ref: string }>(`SELECT ref FROM label_store.recorded`))
      .rows;
    expect(refs.map((r) => r.ref).sort()).toEqual([
      `KnightsConfirm:${item.id}:first`,
      `KnightsConfirm:${item.id}:second`,
    ]);
  });

  it('rolls pooledAt back when the labels cannot be recorded, then pools on retry', async () => {
    const item = await agreedItem();
    await holder.db.query(`INSERT INTO label_store.fail_for VALUES ($1)`, [item.id]);

    expect(await confirmStore.markPooled(item, NOW)).toBe(false);
    expect((await items())[0].pooledAt).toBeNull();
    expect((await holder.db.query(`SELECT 1 FROM label_store.recorded`)).rows).toEqual([]);

    await holder.db.exec(`TRUNCATE label_store.fail_for`);
    expect(await confirmStore.markPooled(item, NOW)).toBe(true);
    expect((await items())[0].pooledAt).not.toBeNull();
  });

  it('is a no-op for an item another run already pooled', async () => {
    const item = await agreedItem();
    await confirmStore.markPooled(item, NOW);
    await holder.db.exec(`TRUNCATE label_store.recorded`);

    expect(await confirmStore.markPooled(item, NOW)).toBe(true);
    expect((await holder.db.query(`SELECT 1 FROM label_store.recorded`)).rows).toEqual([]);
  });
});

describe('agreedUnpooled, markStale, markExpired, pooledActive', () => {
  it('serves agreed unpooled items with the image current level', async () => {
    await image(10, PG);
    await agreeItem(10);

    expect(await confirmStore.agreedUnpooled()).toMatchObject([
      { imageId: 10, url: 'key-10', firstLevel: R, imageLevel: PG },
    ]);
  });

  it('stops offering an item after it failed to pool too many times', async () => {
    await image(10);
    await agreeItem(10);
    const [item] = await confirmStore.agreedUnpooled();

    for (let i = 0; i < MAX_POOL_ATTEMPTS - 1; i++) await confirmStore.markPoolFailed([item.id]);
    expect(await confirmStore.agreedUnpooled()).toHaveLength(1);

    await confirmStore.markPoolFailed([item.id]);
    expect(await confirmStore.agreedUnpooled()).toEqual([]);
  });

  it('marks only unpooled items stale', async () => {
    await image(10);
    await image(11);
    await agreeItem(10);
    await agreeItem(11);
    const [a, b] = await confirmStore.agreedUnpooled();
    await confirmStore.markPooled(b, NOW);

    await confirmStore.markStale([a.id, b.id], NOW);

    const rows = await items();
    expect(rows[0].expiredAt).not.toBeNull();
    expect(rows[1].expiredAt).toBeNull();
    expect(await confirmStore.agreedUnpooled()).toEqual([]);
  });

  it('lists pooled items until they are expired', async () => {
    await image(10);
    await agreeItem(10);
    const [item] = await confirmStore.agreedUnpooled();
    await confirmStore.markPooled(item, NOW);
    expect(await confirmStore.pooledActive()).toMatchObject([{ id: item.id, imageId: 10 }]);

    await confirmStore.markExpired([item.id], NOW);
    expect(await confirmStore.pooledActive()).toEqual([]);
  });
});

describe('runConfirmSync against the real store', () => {
  const fakePools = () => {
    const members = new Set<number>();
    return {
      members,
      pools: {
        add: vi.fn(async (ids: number[]) => ids.forEach((i) => members.add(i))),
        remove: vi.fn(async (ids: number[]) => ids.forEach((i) => members.delete(i))),
      },
    };
  };

  it('leaves a failing item out of the pool and gives up on it after the attempt cap', async () => {
    await image(10);
    await image(11);
    await agreeItem(10);
    await agreeItem(11);
    await holder.db.exec(`INSERT INTO label_store.fail_for VALUES (1)`);
    const { members, pools } = fakePools();

    for (let i = 0; i < MAX_POOL_ATTEMPTS + 1; i++) {
      await runConfirmSync({ store: confirmStore, pools, now: NOW });
    }

    expect([...members]).toEqual([11]);
    const rows = await items();
    expect(rows[0]).toMatchObject({ pooledAt: null, poolAttempts: MAX_POOL_ATTEMPTS });
    expect(rows[1].pooledAt).not.toBeNull();
  });

  it('keeps a shared image in the pool when only the older item expires', async () => {
    await image(10);
    await agreeItem(10);
    await runConfirmSync({ store: confirmStore, pools: fakePools().pools, now: NOW });
    await agreeItem(10);
    const { members, pools } = fakePools();
    const later = new Date(NOW.getTime() + 20 * 86_400_000);
    await holder.db.query(`UPDATE "KnightsConfirmItem" SET "secondAt" = $1 WHERE id = 2`, [
      later.toISOString(),
    ]);

    await runConfirmSync({ store: confirmStore, pools, now: later });

    const rows = await items();
    expect(rows[0].expiredAt).not.toBeNull();
    expect(rows[1].expiredAt).toBeNull();
    expect(pools.remove).not.toHaveBeenCalled();
    expect(members.has(10)).toBe(true);
  });
});
