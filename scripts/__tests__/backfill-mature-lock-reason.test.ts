import { PGlite } from '@electric-sql/pglite';
import { existsSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

// A stand-in filter: any text holding the placeholder token counts as a match.
const TOKEN = 'PLACEHOLDER_TOKEN';
vi.mock('~/libs/profanity-simple', () => ({
  createProfanityFilter: () => ({
    evaluateContent: (text: string) => {
      const matchCount = text.split(TOKEN).length - 1;
      return {
        shouldMarkNSFW: matchCount > 0,
        reason: 'placeholder reason',
        suggestedLevel: 1,
        metrics: { matchCount, uniqueWords: matchCount, totalWords: text.split(' ').length },
        matchedWords: matchCount ? [TOKEN] : [],
      };
    },
  }),
}));

import { storedMatureLockReason } from '~/server/services/mature-lock-reason.service';
import {
  classify,
  run,
  SCRIPT_BASENAME,
  updatedAtPinsLock,
  type Candidate,
} from '../oneoffs/backfill-mature-lock-reason';

const FANOUT_AT = '2026-01-01T00:00:00.123456+00:00';
const UPSERT_AT = '2026-01-01T00:00:00.123Z';
const ms = (iso: string) => new Date(iso);
const NAME = `name ${TOKEN}`;
const DESCRIPTION = 'clean';
// What the filter stored when it set the lock on NAME + DESCRIPTION.
const STORED = {
  profanityMatches: [TOKEN],
  profanityEvaluation: { metrics: { matchCount: 1, uniqueWords: 1, totalWords: 3 } },
};

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 1,
  name: NAME,
  description: DESCRIPTION,
  updatedAt: ms(UPSERT_AT),
  meta: { systemNsfwLock: { source: 'profanity-filter', at: UPSERT_AT }, ...STORED },
  ...overrides,
});

describe('updatedAtPinsLock', () => {
  it('pins a fan-out lock to the millisecond its own statement rounds to', () => {
    expect(updatedAtPinsLock(FANOUT_AT, ms('2026-01-01T00:00:00.123Z'))).toBe(true);
    expect(updatedAtPinsLock(FANOUT_AT, ms('2026-01-01T00:00:00.124Z'))).toBe(true);
    expect(updatedAtPinsLock(FANOUT_AT, ms('2026-01-01T00:00:00.125Z'))).toBe(false);
  });

  it('does not pin a stamp written after the last save (a held lock applied later)', () => {
    expect(updatedAtPinsLock(FANOUT_AT, ms('2025-12-31T00:00:00.000Z'))).toBe(false);
  });

  it('pins an upsert lock only to the same millisecond', () => {
    expect(updatedAtPinsLock(UPSERT_AT, ms('2026-01-01T00:00:00.123Z'))).toBe(true);
    expect(updatedAtPinsLock(UPSERT_AT, ms('2026-01-01T00:00:00.124Z'))).toBe(false);
  });

  it('a malformed stamp proves nothing', () => {
    expect(updatedAtPinsLock('not a date', ms('2020-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('classify', () => {
  it('attributes a pinned lock whose detection today matches the stored one', () => {
    expect(classify(candidate()).attribution).toMatchObject({
      fields: ['name'],
      category: 'mature-language',
    });
  });

  it('attributes nothing once the model was saved after the lock', () => {
    expect(classify(candidate({ updatedAt: ms('2026-01-02T00:00:00Z') })).attribution).toBeNull();
  });

  it('attributes nothing on a model a blurb can rewrite without a save', () => {
    expect(classify(candidate({ blurbLinked: true })).attribution).toBeNull();
  });

  it('attributes nothing when the text differs from what the lock stored, even if pinned', () => {
    const result = classify(candidate({ description: 'rewritten with more words' }));
    expect(result).toMatchObject({ pinned: true, sameDetection: false, attribution: null });
  });

  it("attributes nothing when today's filter no longer marks the text", () => {
    expect(classify(candidate({ name: 'clean' })).attribution).toBeNull();
  });
});

describe('run', () => {
  const fakeDb = (batches: Candidate[][]) => {
    const queue = [...batches];
    return {
      $queryRaw: vi.fn(async () => queue.shift() ?? []),
      $executeRaw: vi.fn(async () => 1),
    };
  };

  it('a dry run writes nothing', async () => {
    const db = fakeDb([[candidate(), candidate({ id: 2, updatedAt: ms('2026-02-01T00:00:00Z') })]]);

    const counts = await run(db as never, { write: false });

    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(counts).toMatchObject({
      candidates: 2,
      updatedAtPinsLock: 1,
      sameDetectionToday: 2,
      writable: 1,
      written: 0,
    });
  });

  it('counts nsfw-locked models with a stored detection and no marker, and those today clears', async () => {
    const unmarked = (id: number, name: string) => candidate({ id, name, meta: { ...STORED } });
    const db = fakeDb([[], [unmarked(3, NAME), unmarked(4, 'clean')]]);

    const counts = await run(db as never, { write: true });

    expect(counts).toMatchObject({
      nsfwLockedWithStoredDetectionNoMarker: 2,
      ofThoseNoDetectionToday: 1,
    });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('run against Postgres', () => {
  vi.setConfig({ testTimeout: 60_000 });
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Model" (id int PRIMARY KEY, name text, description text, nsfw bool,
        "lockedProperties" text[], meta jsonb, "updatedAt" timestamp(3));
      CREATE TABLE "BlurbReference" ("blurbId" int, "entityType" text, "entityId" int);
    `);
  });

  // As the fan-out wrote a lock before it recorded attribution: one statement, one now().
  const lock = (id: number) =>
    pg.query(
      `INSERT INTO "Model" VALUES ($1, $2, $3, true, ARRAY['nsfw'],
         $4::jsonb || jsonb_build_object('systemNsfwLock',
           jsonb_build_object('source', 'profanity-filter', 'at', now())),
         now())`,
      [id, NAME, DESCRIPTION, JSON.stringify(STORED)]
    );
  const marker = async (id: number) =>
    (
      await pg.query<{ meta: { systemNsfwLock: Record<string, unknown> } }>(
        `SELECT meta FROM "Model" WHERE id = $1`,
        [id]
      )
    ).rows[0].meta.systemNsfwLock;
  const raw = () => pgliteRaw(pg);

  it('writes an attribution the owner-facing reader accepts, onto unchanged locks only', async () => {
    await lock(1);
    await lock(2);
    await lock(3);
    await pg.query(
      `UPDATE "Model" SET "updatedAt" = "updatedAt" + interval '1 second' WHERE id = 2`
    );
    await pg.query(`INSERT INTO "BlurbReference" VALUES (9, 'Model', 3)`);

    const counts = await run(
      { $queryRaw: raw().queryRaw, $executeRaw: raw().executeRaw } as never,
      {
        write: true,
      }
    );

    expect(counts).toMatchObject({ candidates: 3, writable: 1, written: 1 });
    // The reader recomputes the hash from the columns: a wrong one here would show nothing.
    const row = (await pg.query<Record<string, unknown>>(`SELECT * FROM "Model" WHERE id = 1`))
      .rows[0];
    expect(
      storedMatureLockReason({
        ...row,
        userId: 1,
        minor: false,
        poi: false,
        sfwOnly: false,
      } as never)?.reason
    ).toEqual({ fields: ['name'], category: 'mature-language' });
    expect(Object.keys(await marker(2)).sort()).toEqual(['at', 'source']);
    expect(Object.keys(await marker(3)).sort()).toEqual(['at', 'source']);
    // The bound tells the two lock paths apart by this: SQL's stamp never ends in Z, JS's always does.
    expect((await marker(1)).at).not.toMatch(/Z$/);
  });

  // Each is a change the write must see between its read and its UPDATE; the first is the rewrite
  // a blurb fan-out makes, description only with `updatedAt` untouched.
  it.each([
    ['description', `SET description = 'rewritten'`],
    ['name', `SET name = 'renamed'`],
    ['updatedAt', `SET "updatedAt" = "updatedAt" + interval '1 second'`],
    ['nsfw lock', `SET "lockedProperties" = '{}'`],
    [
      'lock stamp',
      `SET meta = jsonb_set(meta, '{systemNsfwLock,at}', '"2020-01-01T00:00:00.000Z"')`,
    ],
    ['attribution', `SET meta = jsonb_set(meta, '{systemNsfwLock,textHash}', '"x"')`],
  ])('leaves a row whose %s changed between the read and the write', async (_, change) => {
    await lock(1);
    const { queryRaw, executeRaw } = raw();
    const racingRead = async (...args: Parameters<typeof queryRaw>) => {
      const rows = await queryRaw(...args);
      if (rows.length) await pg.query(`UPDATE "Model" ${change} WHERE id = 1`);
      return rows;
    };

    const counts = await run({ $queryRaw: racingRead, $executeRaw: executeRaw } as never, {
      write: true,
    });

    expect(counts).toMatchObject({ writable: 1, written: 0 });
    expect(await marker(1)).not.toHaveProperty('fields');
  });
});

it('runs only under its own file name, so a rename cannot turn a run into a silent no-op', () => {
  expect(existsSync(path.join(__dirname, '../oneoffs', `${SCRIPT_BASENAME}.ts`))).toBe(true);
});
