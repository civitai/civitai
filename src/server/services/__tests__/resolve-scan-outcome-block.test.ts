import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditMetaData: vi.fn(() => ({ success: false, blockedFor: ['prompt'] })),
  includesInappropriate: vi.fn(() => false),
  includesPoi: vi.fn(() => true),
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
    meta: { prompt: 'blocked prompt' },
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
    return [{ poi: false, minor: true, hasResource: false }];
  }) as never);
});

describe('resolveScanOutcome on a prompt block', () => {
  it('blocks the image', async () => {
    const outcome = await resolveScanOutcome({ image: image(), workflowId: 'wf', prompt: 'p' });

    expect(outcome.ingestion).toBe('Blocked');
    const columns = writtenColumns();
    expect(columns.ingestion).toBe('Blocked');
    expect(columns.nsfwLevel).toBe(32);
  });

  it("keeps the scan's content flags and scannedAt instead of clearing them", async () => {
    await resolveScanOutcome({ image: image(), workflowId: 'wf', prompt: 'p' });

    const columns = writtenColumns();
    expect(columns.poi).toBe(true);
    expect(columns.minor).toBe(true);
    expect(columns.scannedAt).toEqual(SCANNED_AT);
  });

  it('stamps scannedAt on a first scan that ends in a block', async () => {
    await resolveScanOutcome({ image: image({ scannedAt: null }), workflowId: 'wf', prompt: 'p' });

    expect(writtenColumns().scannedAt).toBeInstanceOf(Date);
  });
});
