import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';
import { NsfwLevel } from '~/server/common/enums';
import { styleTags, tagsNeedingReview } from '~/libs/tags';

/**
 * RESTRICT site of the minor content rule: which scanned images the scan sends to the minor review
 * queue. Expected values are the rule as it stood before the gates shared it.
 */

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

const image = {
  id: 1,
  userId: 2,
  createdAt: new Date('2025-12-01T00:00:00.000Z'),
  scannedAt: new Date('2026-01-01T00:00:00.000Z'),
  type: 'image',
  meta: {},
  metadata: {},
  postId: null,
  nsfwLevelLocked: false,
  nsfwLevel: 0,
  ingestion: 'Pending',
} as unknown as ScanImage;

const scan = { tags: [] as { name: string; nsfwLevel: number }[], associatedMinor: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return scan.tags.map((tag, i) => ({ id: 10 + i, type: 'Label', confidence: 90, ...tag }));
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: scan.associatedMinor, hasResource: scan.associatedMinor }];
  }) as never);
});

async function minorReview() {
  const outcome = await resolveScanOutcome({ image, workflowId: 'wf' });
  return outcome.audit?.minorReview;
}

const { PG, PG13, R, X, XXX } = NsfwLevel;
const RATINGS: [number, boolean][] = [
  // An unrated scan keeps its earlier routing: the rule's unrated arm does not reach this queue yet.
  [0, false],
  [PG, false],
  [PG13, false],
  [R, true],
  [X, true],
  [XXX, true],
];

describe('the scan sends an image to minor review', () => {
  it.each(RATINGS)(
    'resource arm: rating %s routes per the minor rule (%s)',
    async (nsfwLevel, expected) => {
      scan.tags = [{ name: 'scene', nsfwLevel }];
      scan.associatedMinor = true;
      expect(await minorReview()).toBe(expected);
    }
  );

  it.each(RATINGS)(
    'tag arm: rating %s routes per the minor rule (%s)',
    async (nsfwLevel, expected) => {
      scan.tags = [
        { name: tagsNeedingReview[0], nsfwLevel },
        { name: styleTags[0], nsfwLevel },
      ];
      scan.associatedMinor = false;
      expect(await minorReview()).toBe(expected);
    }
  );

  it.each(RATINGS)('no minor signal: rating %s is never routed', async (nsfwLevel) => {
    scan.tags = [{ name: 'scene', nsfwLevel }];
    scan.associatedMinor = false;
    expect(await minorReview()).toBe(false);
  });
});
