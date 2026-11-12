import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

const holder = vi.hoisted(() => ({ holdRule: false }));

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditPostImageMeta: vi.fn((): { success: boolean; blockedFor?: string[] } => ({
    success: true,
  })),
  includesInappropriate: vi.fn(() => false),
  includesPoi: vi.fn(() => false),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: vi.fn(async (text: string) => text),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () =>
    holder.holdRule
      ? [
          {
            id: 7,
            definition: { type: 'tag', tags: ['tag'], match: 'any' },
            action: 'Hold',
            reason: 'r',
          },
        ]
      : []
  ),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { resolveScanOutcome, type ScanImage } from '../image-scan-pipeline';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { auditPostImageMeta } from '~/utils/metadata/audit';

/**
 * A collection judge's rating (`metadata.judgeRating`) is a floor under the scan's level. The
 * scan's writes to "Image" run against a real row; the scan's other reads are stubbed.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const ID = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const BLOCKED = 32;

/** The level the scan's tags rate the image at. */
let scanTagLevel = X;

const judgeRated = (nsfwLevel: number) => ({
  judgeRating: { userId: 900, nsfwLevel, collectionId: 10, ratedAt: '2026-01-01T00:00:00.000Z' },
});

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "updatedAt" timestamp(3),
      "pHash" bigint,
      ingestion "ImageIngestionStatus" NOT NULL,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "needsReview" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "scannedAt" timestamp(3),
      metadata jsonb,
      "scanJobs" jsonb
    );
  `);
});
afterAll(() => db.close());

type Row = { nsfwLevel: number; nsfwLevelLocked?: boolean; metadata?: object | null };

/** Stores `stored` and returns the image as the scan loaded it (`loaded`, default the same). */
async function arrange(stored: Row, loaded: Row = stored) {
  await db.exec(`DELETE FROM "Image"`);
  await db.query(
    `INSERT INTO "Image" (id, ingestion, "nsfwLevel", "nsfwLevelLocked", metadata)
     VALUES ($1, 'Rescan', $2, $3, $4)`,
    [ID, stored.nsfwLevel, stored.nsfwLevelLocked ?? false, stored.metadata ?? null]
  );
  return {
    id: ID,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt: 'a lighthouse' },
    postId: null,
    ingestion: 'Rescan',
    nsfwLevelLocked: false,
    metadata: null,
    ...loaded,
  } as unknown as ScanImage;
}

const scan = async (image: ScanImage) => {
  const outcome = await resolveScanOutcome({ image, workflowId: 'wf', prompt: 'p' });
  const { rows } = await db.query<{
    nsfwLevel: number;
    ingestion: string;
    metadata: Record<string, unknown> | null;
  }>(`SELECT "nsfwLevel", ingestion, metadata FROM "Image" WHERE id = $1`, [ID]);
  return { outcome, row: rows[0] };
};

beforeEach(() => {
  vi.clearAllMocks();
  holder.holdRule = false;
  scanTagLevel = X;
  const raw = pgliteRaw(db);
  const isImageWrite = (strings: unknown) =>
    Array.isArray(strings) && (strings as string[]).join('').includes('UPDATE "Image"');
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => (isImageWrite(strings) ? raw.executeRaw(strings, ...values) : 0)) as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (isImageWrite(strings)) return raw.queryRaw(strings, ...values);
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: scanTagLevel, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
});

describe('resolveScanOutcome with a collection judge rating', () => {
  it('raises the level past the judge when the scan rates higher', async () => {
    scanTagLevel = X;
    const { outcome, row } = await scan(await arrange({ nsfwLevel: R, metadata: judgeRated(R) }));

    expect(row).toMatchObject({ ingestion: 'Scanned', nsfwLevel: X });
    expect(outcome.nsfwLevel).toBe(X);
  });

  it('stays at the judge level when the scan rates lower', async () => {
    scanTagLevel = PG13;
    const { outcome, row } = await scan(await arrange({ nsfwLevel: R, metadata: judgeRated(R) }));

    expect(row).toMatchObject({ ingestion: 'Scanned', nsfwLevel: R });
    expect(outcome.nsfwLevel).toBe(R);
  });

  it('holds the floor for a rating written after the scan loaded the image', async () => {
    scanTagLevel = PG13;
    const loaded = { nsfwLevel: PG13, metadata: null };
    const { outcome, row } = await scan(
      await arrange({ nsfwLevel: R, metadata: judgeRated(R) }, loaded)
    );

    expect(row.nsfwLevel).toBe(R);
    expect(outcome.nsfwLevel).toBe(R);
  });

  it('keeps a legacy rating (no judge recorded) as the floor', async () => {
    scanTagLevel = R;
    const legacy = {
      judgeRating: {
        userId: null,
        nsfwLevel: X,
        ratedAt: '2025-01-02T03:04:05',
        legacy: true,
        collectionId: 10,
      },
    };
    const { outcome, row } = await scan(await arrange({ nsfwLevel: X, metadata: legacy }));

    expect(row.nsfwLevel).toBe(X);
    expect(outcome.nsfwLevel).toBe(X);
  });

  it('keeps a moderator lock over both the scan and the judge', async () => {
    scanTagLevel = X;
    const locked = { nsfwLevel: PG13, nsfwLevelLocked: true, metadata: judgeRated(R) };
    const { row } = await scan(await arrange(locked));

    expect(row.nsfwLevel).toBe(PG13);
  });

  it('blocks on an audit block, whatever the judge rated', async () => {
    vi.mocked(auditPostImageMeta).mockReturnValueOnce({ success: false, blockedFor: ['prompt'] });
    const { outcome, row } = await scan(await arrange({ nsfwLevel: R, metadata: judgeRated(X) }));

    expect(row).toMatchObject({ ingestion: 'Blocked', nsfwLevel: BLOCKED });
    expect(outcome.nsfwLevel).toBe(BLOCKED);
  });

  it('ignores a judge rating that is not a level', async () => {
    scanTagLevel = PG13;
    const { row } = await scan(
      await arrange({ nsfwLevel: 0, metadata: { judgeRating: { nsfwLevel: BLOCKED } } })
    );

    expect(row.nsfwLevel).toBe(PG13);
  });

  it('writes the scan level as before when there is no judge rating', async () => {
    for (const level of [PG13, X]) {
      scanTagLevel = level;
      const { outcome, row } = await scan(await arrange({ nsfwLevel: R }));
      expect(row.nsfwLevel).toBe(level);
      expect(outcome.nsfwLevel).toBe(level);
    }
  });

  it('keeps the judge rating when a moderation rule annotates the metadata', async () => {
    holder.holdRule = true;
    scanTagLevel = PG13;
    // The scan loaded the image before the judge rated it.
    const { row } = await scan(
      await arrange({ nsfwLevel: R, metadata: judgeRated(R) }, { nsfwLevel: PG13, metadata: null })
    );

    expect(row.metadata).toMatchObject({ ...judgeRated(R), ruleId: 7 });
    expect(row.nsfwLevel).toBe(R);
  });
});
