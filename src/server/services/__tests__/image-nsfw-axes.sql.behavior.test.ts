import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as Flipt from '~/server/flipt/client';
import type * as ImageService from '~/server/services/image.service';

// The real SQL of the scan's verdict UPDATE with its nsfwAxes term, against the real migration.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite, promptBlocked: false }));
const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: mockIsFlipt,
}));
vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditPostImageMeta: vi.fn(() =>
    holder.promptBlocked ? { success: false, blockedFor: ['prompt'] } : { success: true }
  ),
  includesInappropriate: vi.fn(() => false),
  includesPoi: vi.fn(() => false),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: vi.fn(async (text: string) => text),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () => []),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { resolveScanOutcome, type ScanImage } from '../image-scan-pipeline';
import {
  isNsfwAxesMissing,
  MODERATOR_BIT,
  packNsfwAxes,
  unpackNsfwAxes,
  type NsfwAxes,
  type RatingAxes,
} from '../image-nsfw-axes';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const migration = readFileSync(
  join(
    process.cwd(),
    'packages/civitai-db-schema/prisma/migrations/20270105130000_image_nsfw_axes/migration.sql'
  ),
  'utf8'
);

const ID = 1;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "updatedAt" timestamp(3),
      "pHash" bigint,
      ingestion "ImageIngestionStatus",
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "needsReview" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "scannedAt" timestamp(3),
      metadata jsonb,
      "scanJobs" jsonb
    );
  `);
  await holder.db.exec(migration);
});

beforeEach(async () => {
  vi.clearAllMocks();
  holder.promptBlocked = false;
  mockIsFlipt.mockResolvedValue(true);
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
    return affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.appeal.findMany.mockResolvedValue([] as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      // Tag levels that make the prompt audit run.
      return [
        {
          id: 10,
          name: 'tag',
          type: 'Label',
          nsfwLevel: holder.promptBlocked ? 16 : 1,
          confidence: 90,
        },
      ];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  await holder.db.exec(`TRUNCATE "Image"`);
});

const axes = (sexual: number, violence = 0): RatingAxes => ({
  sexual,
  violence,
  rater: 'radio-alpha',
  raterVersion: 'c0ffee',
});
const stored = (over: Partial<NsfwAxes>) =>
  packNsfwAxes({
    sexual: null,
    violence: null,
    language: null,
    sexualHighWater: null,
    moderator: false,
    ...over,
  });

/** An image row last submitted for `current` (null: never stamped), holding `nsfwAxes`. */
const seed = async ({
  current,
  nsfwAxes = null,
}: {
  current: string | null;
  nsfwAxes?: number | null;
}) =>
  holder.db.query(
    `INSERT INTO "Image" (id, ingestion, "nsfwLevel", "scanJobs", "nsfwAxes") VALUES ($1, 'Pending', 0, $2, $3)`,
    [ID, current === null ? null : JSON.stringify({ workflowId: current }), nsfwAxes]
  );

const image = () =>
  ({
    id: ID,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt: 'a landscape' },
    metadata: {},
    postId: null,
    nsfwLevelLocked: false,
    nsfwLevel: 0,
    ingestion: 'Pending',
    blockedFor: null,
    needsReview: null,
  } as unknown as ScanImage);

const scan = (workflowId: string, rating?: RatingAxes, over: { blocked?: boolean } = {}) =>
  resolveScanOutcome({
    image: image(),
    workflowId,
    prompt: 'a landscape',
    axes: rating,
    blocked: over.blocked ? { reason: 'legacy' } : undefined,
  });

const row = async () =>
  (
    await holder.db.query<{ nsfwAxes: number | null; ingestion: string; workflowId: string }>(
      `SELECT "nsfwAxes", ingestion, "scanJobs"->>'workflowId' AS "workflowId" FROM "Image" WHERE id = $1`,
      [ID]
    )
  ).rows[0];
const axesOfRow = async () => unpackNsfwAxes((await row()).nsfwAxes);

/** Every SQL text and value the verdict wrote, for comparing two runs. */
const writtenSql = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map(([strings, ...values]) => {
    const sql = Prisma.sql(strings as unknown as TemplateStringsArray, ...(values as never[]));
    // updatedAt is the time of the call.
    return { text: sql.text, values: sql.values.filter((v) => !(v instanceof Date)) };
  });

describe('nsfwAxes bit layout', () => {
  it.each([
    ['sexual', 5],
    ['violence', 5],
    ['language', 3],
    ['sexualHighWater', 5],
  ] as const)('round-trips every %s level on its own', (group, size) => {
    for (let level = 0; level < size; level++) {
      const value = stored({ [group]: level });
      expect(value.toString(2).split('1').length - 1, `${group}=${level}`).toBe(1);
      expect(unpackNsfwAxes(value)).toEqual({
        sexual: null,
        violence: null,
        language: null,
        sexualHighWater: null,
        moderator: false,
        [group]: level,
      });
    }
  });

  it('keeps the groups apart: bit offsets 0, 5, 10, 13 and the moderator bit 18', () => {
    expect(stored({ sexual: 0 })).toBe(1 << 0);
    expect(stored({ violence: 0 })).toBe(1 << 5);
    expect(stored({ language: 0 })).toBe(1 << 10);
    expect(stored({ sexualHighWater: 0 })).toBe(1 << 13);
    expect(stored({ moderator: true })).toBe(MODERATOR_BIT);
    expect(MODERATOR_BIT).toBe(1 << 18);
    const all = { sexual: 4, violence: 3, language: 2, sexualHighWater: 4, moderator: true };
    expect(unpackNsfwAxes(packNsfwAxes(all))).toEqual(all);
  });

  it('reads NULL as not rated and an empty group as no value', () => {
    expect(unpackNsfwAxes(null)).toBeNull();
    expect(unpackNsfwAxes(0)).toEqual({
      sexual: null,
      violence: null,
      language: null,
      sexualHighWater: null,
      moderator: false,
    });
  });

  it('refuses a level outside its group and a group with two bits set', () => {
    expect(() => stored({ sexual: 5 })).toThrow('sexual level out of range');
    expect(() => stored({ language: 3 })).toThrow('language level out of range');
    expect(() => unpackNsfwAxes(0b11)).toThrow('sexual has more than one bit set');
  });
});

describe('the scan verdict writes nsfwAxes', () => {
  it('rates an unrated row: the levels, and a high-water at the sexual level', async () => {
    await seed({ current: 'wf-1' });
    await scan('wf-1', axes(2, 1));

    expect(await axesOfRow()).toEqual({
      sexual: 2,
      violence: 1,
      language: null,
      sexualHighWater: 2,
      moderator: false,
    });
  });

  it('lets the newer result win', async () => {
    await seed({
      current: 'wf-2',
      nsfwAxes: stored({ sexual: 1, violence: 0, sexualHighWater: 1 }),
    });
    await scan('wf-2', axes(3, 2));

    expect(await axesOfRow()).toMatchObject({ sexual: 3, violence: 2, sexualHighWater: 3 });
  });

  // 🔴 The ordering guard. An older result can arrive after a newer one (a slow or redelivered
  // webhook). The verdict itself still writes as it always has; only nsfwAxes holds.
  it.each([
    ['lower', 1],
    ['higher, so the high-water holds too', 4],
  ])(
    'keeps nsfwAxes when an older result arrives last (%s), and still writes the verdict',
    async (_, sexual) => {
      const newer = stored({ sexual: 3, violence: 1, sexualHighWater: 3 });
      await seed({ current: 'wf-2', nsfwAxes: newer });
      await scan('wf-1', axes(sexual, 4));

      expect(await row()).toEqual({ nsfwAxes: newer, ingestion: 'Scanned', workflowId: 'wf-1' });
    }
  );

  it('writes no axes to a row with no submitted workflowId', async () => {
    await seed({ current: null });
    await scan('wf-1', axes(3));

    expect(await row()).toEqual({ nsfwAxes: null, ingestion: 'Scanned', workflowId: 'wf-1' });
  });

  // 🔴 Bit 18 covers the whole value by design: a moderator's value protects every axis, the
  // high-water included, from every later scan. Do not narrow this to the sexual axis.
  it('never changes any axis of a moderator value', async () => {
    const moderator = stored({ sexual: 0, violence: 0, sexualHighWater: 0, moderator: true });
    await seed({ current: 'wf-1', nsfwAxes: moderator });
    await scan('wf-1', axes(4, 4));

    expect((await row()).nsfwAxes).toBe(moderator);
  });

  it('keeps the sexual high-water when a newer scan rates lower', async () => {
    await seed({
      current: 'wf-2',
      nsfwAxes: stored({ sexual: 3, violence: 0, sexualHighWater: 3 }),
    });
    await scan('wf-2', axes(1));

    expect(await axesOfRow()).toMatchObject({ sexual: 1, sexualHighWater: 3 });
  });

  it('keeps a past high-water above both the stored and the new sexual level', async () => {
    await seed({
      current: 'wf-2',
      nsfwAxes: stored({ sexual: 1, violence: 0, sexualHighWater: 4 }),
    });
    await scan('wf-2', axes(2));

    expect(await axesOfRow()).toMatchObject({ sexual: 2, sexualHighWater: 4 });
  });

  it('raises the sexual high-water when a newer scan rates higher', async () => {
    await seed({
      current: 'wf-2',
      nsfwAxes: stored({ sexual: 1, violence: 0, sexualHighWater: 2 }),
    });
    await scan('wf-2', axes(4));

    expect(await axesOfRow()).toMatchObject({ sexual: 4, sexualHighWater: 4 });
  });

  it('writes the axes when the verdict is a prompt block', async () => {
    holder.promptBlocked = true;
    await seed({ current: 'wf-1' });
    const outcome = await scan('wf-1', axes(2));

    expect(outcome.ingestion).toBe('Blocked');
    expect(await axesOfRow()).toMatchObject({ sexual: 2, sexualHighWater: 2 });
  });

  it('writes the axes on the legacy blocked branch, under the same guard', async () => {
    await seed({ current: 'wf-1' });
    await scan('wf-1', axes(2), { blocked: true });
    expect(await axesOfRow()).toMatchObject({ sexual: 2, sexualHighWater: 2 });

    await scan('wf-0', axes(4), { blocked: true });
    expect(await axesOfRow()).toMatchObject({ sexual: 2, sexualHighWater: 2 });
  });
});

describe('the nsfwAxes write never changes the scan', () => {
  it('writes the same SQL with the flag off as with no axes, and evaluates the flag per image', async () => {
    await seed({ current: 'wf-1' });
    await scan('wf-1');
    const withoutAxes = writtenSql();
    expect(mockIsFlipt).not.toHaveBeenCalled();

    dbMock.dbWrite.$executeRaw.mockClear();
    mockIsFlipt.mockResolvedValue(false);
    await scan('wf-1', axes(3));

    expect(mockIsFlipt).toHaveBeenCalledWith(expect.anything(), String(ID));
    expect(writtenSql()).toEqual(withoutAxes);
    expect(JSON.stringify(withoutAxes)).not.toContain('nsfwAxes');
    expect((await row()).nsfwAxes).toBeNull();
  });

  it('writes the verdict without axes when Flipt is unreachable', async () => {
    mockIsFlipt.mockRejectedValue(new Error('flipt down'));
    await seed({ current: 'wf-1' });
    await scan('wf-1', axes(3));

    expect(await row()).toEqual({ nsfwAxes: null, ingestion: 'Scanned', workflowId: 'wf-1' });
  });

  describe('before the migration is applied', () => {
    beforeEach(() => holder.db.exec(`ALTER TABLE "Image" DROP COLUMN "nsfwAxes"`));
    // Re-adds the column with the real migration, twice: it is safe to re-run.
    afterEach(async () => {
      await holder.db.exec(migration);
      await holder.db.exec(migration);
    });

    it.each([
      ['the verdict', false, 'Scanned', null],
      ['the legacy blocked branch', true, 'Blocked', 'Pending'],
    ])(
      'writes %s without the axes, and logs it, with the flag on',
      async (_, blocked, outcomeIngestion, rowIngestion) => {
        await holder.db.query(
          `INSERT INTO "Image" (id, ingestion, "scanJobs") VALUES ($1, 'Pending', '{"workflowId":"wf-0"}')`,
          [ID]
        );
        const outcome = await scan('wf-1', axes(3), { blocked });

        expect(outcome.ingestion).toBe(outcomeIngestion);
        const { rows } = await holder.db.query<{ ingestion: string; workflowId: string }>(
          `SELECT ingestion, "scanJobs"->>'workflowId' AS "workflowId" FROM "Image" WHERE id = $1`,
          [ID]
        );
        // The write landed: the legacy branch stamps only scanJobs, the verdict its ingestion too.
        expect(rows[0]).toEqual({
          ingestion: rowIngestion ?? outcomeIngestion,
          workflowId: 'wf-1',
        });
        expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'image-nsfw-axes', imageId: ID, workflowId: 'wf-1' }),
          'webhooks'
        );
      }
    );
  });

  it('propagates any other failure of the verdict write, without a second write', async () => {
    await seed({ current: 'wf-1' });
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('connection reset'));

    await expect(scan('wf-1', axes(3))).rejects.toThrow('connection reset');
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('isNsfwAxesMissing', () => {
  it.each([
    [
      'the driver error',
      { code: '42703', message: 'column "nsfwAxes" of relation "Image" does not exist' },
    ],
    [
      'the Prisma raw-query error',
      {
        code: 'P2010',
        meta: { code: '42703' },
        message:
          'Raw query failed. Code: `42703`. Message: `column "nsfwAxes" of relation "Image" does not exist`',
      },
    ],
  ])('recognises %s', (_, error) => {
    expect(isNsfwAxesMissing(error)).toBe(true);
  });

  it.each([
    ['another missing column', { code: '42703', message: 'column "nsfwLevel" does not exist' }],
    [
      'another error naming the column',
      { code: '22003', message: 'nsfwAxes: integer out of range' },
    ],
    ['a non-error', 'nsfwAxes'],
  ])('refuses %s', (_, error) => {
    expect(isNsfwAxesMissing(error)).toBe(false);
  });
});
