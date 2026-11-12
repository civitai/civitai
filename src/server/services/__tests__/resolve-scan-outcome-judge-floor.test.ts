import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

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
import { dbMock } from '~/__tests__/mocks/db.mock';
import { auditPostImageMeta } from '~/utils/metadata/audit';

/** A collection judge's rating (`metadata.judgeRating`) is a floor under the scan's level. */

const PG13 = 2;
const R = 4;
const X = 8;
const BLOCKED = 32;

/** The level the scan's tags rate the image at. */
let scanTagLevel = X;

const judgeRated = (nsfwLevel: number) => ({
  judgeRating: { userId: 900, nsfwLevel, ratedAt: '2026-01-01T00:00:00.000Z' },
});

const image = (over: Partial<ScanImage> = {}) =>
  ({
    id: 1,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt: 'a lighthouse' },
    metadata: {},
    postId: null,
    nsfwLevelLocked: false,
    nsfwLevel: 0,
    ingestion: 'Rescan',
    ...over,
  } as unknown as ScanImage);

const scan = (over: Partial<ScanImage>) =>
  resolveScanOutcome({ image: image(over), workflowId: 'wf', prompt: 'p' });

/** Column → bound value of the single UPDATE "Image" the outcome writes. */
function writtenColumns() {
  const call = vi
    .mocked(dbMock.dbWrite.$executeRaw)
    .mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('UPDATE "Image"')
    );
  expect(call, 'resolveScanOutcome never wrote the image').toBeDefined();
  const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
  const stmt = Prisma.sql(strings, ...(values as Prisma.Sql[]));
  const columns: Record<string, unknown> = {};
  for (const [, column, n] of stmt.text.matchAll(/"(\w+)" = \$(\d+)/g)) {
    columns[column] = stmt.values[Number(n) - 1];
  }
  return columns;
}

beforeEach(() => {
  vi.clearAllMocks();
  scanTagLevel = X;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
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
    await scan({ nsfwLevel: R, metadata: judgeRated(R) });

    expect(writtenColumns()).toMatchObject({ ingestion: 'Scanned', nsfwLevel: X });
  });

  it('stays at the judge level when the scan rates lower', async () => {
    scanTagLevel = PG13;
    await scan({ nsfwLevel: R, metadata: judgeRated(R) });

    expect(writtenColumns()).toMatchObject({ ingestion: 'Scanned', nsfwLevel: R });
  });

  it('keeps a moderator lock over both the scan and the judge', async () => {
    scanTagLevel = X;
    await scan({ nsfwLevel: PG13, nsfwLevelLocked: true, metadata: judgeRated(R) });

    expect(writtenColumns().nsfwLevel).toBe(PG13);
  });

  it('blocks on an audit block, whatever the judge rated', async () => {
    vi.mocked(auditPostImageMeta).mockReturnValueOnce({ success: false, blockedFor: ['prompt'] });
    await scan({ nsfwLevel: R, metadata: judgeRated(R) });

    expect(writtenColumns()).toMatchObject({ ingestion: 'Blocked', nsfwLevel: BLOCKED });
  });

  it('ignores a judge rating that is not a level', async () => {
    scanTagLevel = PG13;
    await scan({ metadata: { judgeRating: { nsfwLevel: BLOCKED } } });

    expect(writtenColumns().nsfwLevel).toBe(PG13);
  });

  it('writes the scan level as before when there is no judge rating', async () => {
    for (const level of [PG13, X]) {
      vi.mocked(dbMock.dbWrite.$executeRaw).mockClear();
      scanTagLevel = level;
      await scan({ nsfwLevel: R });
      expect(writtenColumns().nsfwLevel).toBe(level);
    }
  });
});
