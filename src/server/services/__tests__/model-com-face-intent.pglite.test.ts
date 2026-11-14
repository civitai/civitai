import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLag from '~/server/db/db-lag-helpers';

/** The listing intent lock's own SQL against PGlite: which rows it may lock. Ids are invented. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLag>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));

const { lockForComFaceIntent, recordComFaceIntent } = await import(
  '~/server/services/model-com-face-intent.service'
);

const MODEL = 5;
let db: PGlite;
const activities: unknown[] = [];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY,
      "lockedProperties" text[],
      nsfw boolean NOT NULL DEFAULT true,
      poi boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false,
      "sfwOnly" boolean NOT NULL DEFAULT false,
      meta jsonb
    );
  `);
  const raw = pgliteRaw(db);
  const tx = {
    $executeRaw: raw.executeRaw,
    modActivity: { create: async (args: unknown) => activities.push(args) },
  };
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
    fn(tx)) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  activities.length = 0;
  await db.exec(`DELETE FROM "Model"`);
});

async function seed(fields: Record<string, unknown> = {}) {
  const row = { nsfw: true, poi: false, minor: false, sfwOnly: false, locked: null, ...fields };
  await db.query(
    `INSERT INTO "Model" (id, "lockedProperties", nsfw, poi, minor, "sfwOnly", meta) VALUES ($1, $2, $3, $4, $5, $6, '{}')`,
    [MODEL, row.locked, row.nsfw, row.poi, row.minor, row.sfwOnly]
  );
  await recordComFaceIntent(MODEL, { detected: true, textHash: 'h', reason: 'r' });
}

const row = async () =>
  (
    await db.query<{ lockedProperties: string[] | null; meta: Record<string, any> }>(
      `SELECT "lockedProperties", meta FROM "Model" WHERE id = $1`,
      [MODEL]
    )
  ).rows[0];

describe('lockForComFaceIntent', () => {
  it('locks a mature model on its stored detection, with the system marker and an activity', async () => {
    await seed();

    expect(await lockForComFaceIntent(MODEL, 'h')).toBe(true);

    const { lockedProperties, meta } = await row();
    expect(lockedProperties).toEqual(['nsfw']);
    expect(meta.systemNsfwLock.source).toBe('com-face-intent');
    expect(meta.comFaceIntent).toMatchObject({ detected: true, textHash: 'h', reason: 'r' });
    expect(activities).toHaveLength(1);
  });

  it("keeps the scan's rating marker it replaces on the verdict", async () => {
    await seed();
    const scan = { source: 'text-scan', at: '2026-01-01T00:00:00.000Z' };
    await db.query(
      `UPDATE "Model" SET meta = meta || jsonb_build_object('systemNsfwLock', $2::jsonb) WHERE id = $1`,
      [MODEL, JSON.stringify(scan)]
    );

    expect(await lockForComFaceIntent(MODEL, 'h')).toBe(true);

    const { meta } = await row();
    expect(meta.systemNsfwLock.source).toBe('com-face-intent');
    expect(meta.comFaceIntent.priorSystemNsfwLock).toEqual(scan);
  });

  it.each([
    ['not mature', { nsfw: false }],
    ['flagged a minor', { minor: true }],
    ['flagged a real person', { poi: true }],
    ['SFW-only', { sfwOnly: true }],
    ['already locked', { locked: ['nsfw'] }],
  ])('leaves a model that is %s alone', async (_, fields) => {
    await seed(fields);
    const before = await row();

    expect(await lockForComFaceIntent(MODEL, 'h')).toBe(false);

    expect((await row()).lockedProperties).toEqual(before.lockedProperties);
    expect(activities).toHaveLength(0);
  });

  it('does not lock for a verdict on other text, or one since overturned', async () => {
    await seed();
    expect(await lockForComFaceIntent(MODEL, 'other')).toBe(false);

    await db.query(
      `UPDATE "Model" SET meta = jsonb_set(meta, '{comFaceIntent,overturnedAt}', '"x"') WHERE id = $1`,
      [MODEL]
    );
    expect(await lockForComFaceIntent(MODEL, 'h')).toBe(false);
    expect((await row()).lockedProperties).toBeNull();
  });
});
