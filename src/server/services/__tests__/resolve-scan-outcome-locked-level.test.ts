import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditPostImageMeta: vi.fn(() => ({ success: true })),
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

const SCANNED_AT = new Date('2026-01-01T00:00:00.000Z');

const image = (over: Partial<ScanImage> = {}) =>
  ({
    id: 1,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: SCANNED_AT,
    type: 'image',
    meta: { prompt: 'a lighthouse' },
    metadata: {},
    postId: null,
    nsfwLevelLocked: false,
    nsfwLevel: 0,
    ingestion: 'Pending',
    ...over,
  } as unknown as ScanImage);

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
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: 16, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
});

describe('resolveScanOutcome on a locked level', () => {
  // A judge's rating in a judge-rated collection locks the level it wrote.
  it('keeps the locked level when the scan rates the image higher', async () => {
    await resolveScanOutcome({
      image: image({ ingestion: 'Rescan', nsfwLevel: 4, nsfwLevelLocked: true }),
      workflowId: 'wf',
      prompt: 'p',
    });

    const columns = writtenColumns();
    expect(columns.ingestion).toBe('Scanned');
    expect(columns.nsfwLevel).toBe(4);
  });

  it('writes the scan level when nothing is locked', async () => {
    await resolveScanOutcome({
      image: image({ ingestion: 'Rescan', nsfwLevel: 4 }),
      workflowId: 'wf',
      prompt: 'p',
    });

    expect(writtenColumns().nsfwLevel).toBe(16);
  });
});
