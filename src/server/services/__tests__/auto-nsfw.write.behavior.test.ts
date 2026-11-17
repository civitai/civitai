import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { writeAutoNsfw, type AutoNsfwResult } from '~/server/services/auto-nsfw';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const ID = 1;
const metaPatch = {
  profanityMatches: ['x'],
  profanityEvaluation: { reason: 'r', metrics: {} },
} as unknown as AutoNsfwResult['metaPatch'];
const attribution: AutoNsfwResult['attribution'] = {
  fields: ['name'],
  category: 'mature-language',
  textHash: 'hash-placeholder',
};
let pg: PGlite;
let db: { $executeRaw: ReturnType<typeof pgliteRaw>['executeRaw'] };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, nsfw bool NOT NULL DEFAULT false,
      "lockedProperties" text[] NOT NULL DEFAULT '{}', meta jsonb, "updatedAt" timestamp(3),
      minor bool NOT NULL DEFAULT false, poi bool NOT NULL DEFAULT false,
      "sfwOnly" bool NOT NULL DEFAULT false, availability text NOT NULL DEFAULT 'Public');
  `);
  db = { $executeRaw: pgliteRaw(pg).executeRaw };
});

beforeEach(() => pg.exec(`TRUNCATE "Model"`));

const seed = (row: {
  locked?: string[];
  meta?: unknown;
  flag?: 'minor' | 'poi' | 'sfwOnly';
  availability?: 'Public' | 'Private';
}) =>
  pg.query(
    `INSERT INTO "Model" (id, "lockedProperties", meta, "updatedAt", minor, poi, "sfwOnly", availability)
     VALUES ($1, $2, $3, '2026-01-01', $4, $5, $6, $7)`,
    [
      ID,
      row.locked ?? [],
      row.meta === undefined ? null : JSON.stringify(row.meta),
      row.flag === 'minor',
      row.flag === 'poi',
      row.flag === 'sfwOnly',
      row.availability ?? 'Public',
    ]
  );

const read = async () =>
  (
    await pg.query<{
      nsfw: boolean;
      lockedProperties: string[];
      meta: Record<string, unknown> | null;
      bumped: boolean;
    }>(
      `SELECT nsfw, "lockedProperties", meta, "updatedAt" > '2026-01-01' AS bumped
       FROM "Model" WHERE id = $1`,
      [ID]
    )
  ).rows[0];

describe('writeAutoNsfw', () => {
  it('locks nsfw, marks the lock the system’s and merges into the meta that is there now', async () => {
    await seed({ meta: { cannotPromote: true } });

    await writeAutoNsfw(db, { id: ID, metaPatch, attribution, lock: true });

    const m = await read();
    expect(m).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'], bumped: true });
    expect(m.meta).toMatchObject({
      cannotPromote: true,
      profanityMatches: ['x'],
      systemNsfwLock: { source: 'profanity-filter', at: expect.any(String), ...attribution },
    });
    expect(Number.isNaN(Date.parse((m.meta!.systemNsfwLock as { at: string }).at))).toBe(false);
  });

  it('records only the detection when an nsfw lock is already there', async () => {
    await seed({ locked: ['nsfw'], meta: { cannotPromote: true } });

    await writeAutoNsfw(db, { id: ID, metaPatch, attribution, lock: true });

    const m = await read();
    expect(m).toMatchObject({ nsfw: false, lockedProperties: ['nsfw'], bumped: true });
    expect(m.meta).toEqual({ cannotPromote: true, ...metaPatch });
  });

  it.each(['minor', 'poi', 'sfwOnly'] as const)(
    'records only the detection on a %s model, as the model save does',
    async (flag) => {
      await seed({ flag, meta: { cannotPromote: true } });

      await writeAutoNsfw(db, { id: ID, metaPatch, attribution, lock: true });

      const m = await read();
      expect(m).toMatchObject({ nsfw: false, lockedProperties: [], bumped: true });
      expect(m.meta).toEqual({ cannotPromote: true, ...metaPatch });
    }
  );

  it('records only the detection when the caller has nothing to lock', async () => {
    await seed({});

    await writeAutoNsfw(db, { id: ID, metaPatch, attribution, lock: false });

    const m = await read();
    expect(m).toMatchObject({ nsfw: false, lockedProperties: [], bumped: true });
    expect(m.meta).toEqual(metaPatch);
  });

  it('keeps a Private model SFW and holds the detection as a lead for when it leaves Private', async () => {
    await seed({ availability: 'Private', meta: { cannotPromote: true } });

    await writeAutoNsfw(db, { id: ID, metaPatch, attribution, lock: true });

    const m = await read();
    expect(m).toMatchObject({ nsfw: false, lockedProperties: [], bumped: true });
    expect(m.meta).toEqual({
      cannotPromote: true,
      ...metaPatch,
      restrictedNsfwVerdict: {
        source: 'profanity-filter',
        at: expect.any(String),
        restriction: 'sfwOnly',
      },
    });
  });

  it('holds no lead on a Private model that is also minor: the detection only, as before', async () => {
    await seed({ availability: 'Private', flag: 'minor' });

    await writeAutoNsfw(db, { id: ID, metaPatch, attribution, lock: true });

    expect((await read()).meta).toEqual(metaPatch);
  });

  it('holds no lead on a Private model whose nsfw a moderator already ruled on', async () => {
    await seed({ availability: 'Private', locked: ['nsfw'] });

    await writeAutoNsfw(db, { id: ID, metaPatch, attribution, lock: true });

    expect((await read()).meta).toEqual(metaPatch);
  });

  // A publish that commits while the write is under way: the model must end rated or with the lead
  // waiting for the publish to apply, never with neither.
  it('leaves the rating or the lead when the model is published while it writes', async () => {
    await seed({ availability: 'Private' });
    let published = false;
    const interleaved = {
      $executeRaw: async (...args: Parameters<typeof db.$executeRaw>) => {
        const written = await db.$executeRaw(...args);
        if (!published) {
          published = true;
          await pg.exec(`UPDATE "Model" SET availability = 'Public'`);
        }
        return written;
      },
    };

    await writeAutoNsfw(interleaved, { id: ID, metaPatch, attribution, lock: true });

    const m = await read();
    expect(m.nsfw || 'restrictedNsfwVerdict' in (m.meta ?? {})).toBe(true);
  });

  it('repairs a JSON-null meta instead of concatenating onto it', async () => {
    await seed({ meta: null });
    await pg.exec(`UPDATE "Model" SET meta = 'null'::jsonb`);

    await writeAutoNsfw(db, { id: ID, metaPatch, attribution, lock: true });

    expect((await read()).meta).toMatchObject({ profanityMatches: ['x'] });
  });
});
