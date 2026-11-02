import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { writeAutoNsfw } from '~/server/services/auto-nsfw';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const ID = 1;
const metaPatch = { profanityMatches: ['x'], profanityEvaluation: { reason: 'r', metrics: {} } };
let pg: PGlite;
let db: { $executeRaw: ReturnType<typeof pgliteRaw>['executeRaw'] };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, nsfw bool NOT NULL DEFAULT false,
      "lockedProperties" text[] NOT NULL DEFAULT '{}', meta jsonb, "updatedAt" timestamp(3));
  `);
  db = { $executeRaw: pgliteRaw(pg).executeRaw };
});

beforeEach(() => pg.exec(`TRUNCATE "Model"`));

const seed = (row: { locked?: string[]; meta?: unknown }) =>
  pg.query(
    `INSERT INTO "Model" (id, "lockedProperties", meta, "updatedAt")
     VALUES ($1, $2, $3, '2026-01-01')`,
    [ID, row.locked ?? [], row.meta === undefined ? null : JSON.stringify(row.meta)]
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

    await writeAutoNsfw(db, { id: ID, metaPatch, lock: true });

    const m = await read();
    expect(m).toMatchObject({ nsfw: true, lockedProperties: ['nsfw'], bumped: true });
    expect(m.meta).toMatchObject({
      cannotPromote: true,
      profanityMatches: ['x'],
      systemNsfwLock: { source: 'profanity-filter', at: expect.any(String) },
    });
    expect(Number.isNaN(Date.parse((m.meta!.systemNsfwLock as { at: string }).at))).toBe(false);
  });

  it('records only the detection when an nsfw lock is already there', async () => {
    await seed({ locked: ['nsfw'], meta: { cannotPromote: true } });

    await writeAutoNsfw(db, { id: ID, metaPatch, lock: true });

    const m = await read();
    expect(m).toMatchObject({ nsfw: false, lockedProperties: ['nsfw'], bumped: true });
    expect(m.meta).toEqual({ cannotPromote: true, ...metaPatch });
  });

  it('records only the detection when the caller has nothing to lock', async () => {
    await seed({});

    await writeAutoNsfw(db, { id: ID, metaPatch, lock: false });

    const m = await read();
    expect(m).toMatchObject({ nsfw: false, lockedProperties: [], bumped: true });
    expect(m.meta).toEqual(metaPatch);
  });

  it('repairs a JSON-null meta instead of concatenating onto it', async () => {
    await seed({ meta: null });
    await pg.exec(`UPDATE "Model" SET meta = 'null'::jsonb`);

    await writeAutoNsfw(db, { id: ID, metaPatch, lock: true });

    expect((await read()).meta).toMatchObject({ profanityMatches: ['x'] });
  });
});
