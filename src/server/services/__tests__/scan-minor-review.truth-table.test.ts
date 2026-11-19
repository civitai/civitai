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
import { loggingMock } from '~/__tests__/mocks/logging.mock';

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

async function minorReview(stored: Partial<ScanImage> = {}) {
  const outcome = await resolveScanOutcome({ image: { ...image, ...stored }, workflowId: 'wf' });
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

describe('minor routing does not depend on a locked rating', () => {
  it.each([
    ['locked with no rating', { nsfwLevelLocked: true, nsfwLevel: 0 }],
    ['locked at PG', { nsfwLevelLocked: true, nsfwLevel: PG }],
  ])('routes an X scan with a minor signal when the image is %s', async (_, stored) => {
    scan.tags = [{ name: 'scene', nsfwLevel: X }];
    scan.associatedMinor = true;
    expect(await minorReview(stored as Partial<ScanImage>)).toBe(true);
  });
});

describe('the count of what a scan newly sets after a moderator review', () => {
  // The minor column the outcome write sets, read from its parameters.
  function writtenMinor() {
    const call = vi
      .mocked(dbMock.dbWrite.$executeRaw)
      .mock.calls.find(([strings]) =>
        (strings as TemplateStringsArray).join('').includes('"minor" = ')
      );
    if (!call) return undefined;
    const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
    return values[strings.findIndex((s) => s.includes('"minor" = '))];
  }
  const lines = () =>
    loggingMock.logToAxiom.mock.calls
      .map(([line]) => line as { name: string; payload?: Record<string, unknown> })
      .filter((line) => line.name === 'scan-outcome-after-review');
  // The line is written after the outcome resolves, off the scan's path.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const reviewed = (yes: boolean) =>
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([{ reviewed: yes }] as never);

  beforeEach(() => {
    loggingMock.logToAxiom.mockClear();
    scan.tags = [{ name: 'scene', nsfwLevel: NsfwLevel.R }];
    scan.associatedMinor = true;
  });

  it('logs a reviewed image the scan newly marks minor, and the minor write lands', async () => {
    reviewed(true);
    await resolveScanOutcome({ image: { ...image, minor: false }, workflowId: 'wf' });
    await settle();
    expect(lines()).toEqual([
      {
        name: 'scan-outcome-after-review',
        type: 'info',
        payload: {
          priorReview: true,
          sampled: false,
          newlyBlocked: false,
          newlyMinor: true,
          newlyPoi: false,
          newlyNeedsReview: expect.any(Boolean),
        },
      },
    ]);
    expect(writtenMinor()).toBe(true);
  });

  it('does not count a minor flag the image already had', async () => {
    reviewed(true);
    await resolveScanOutcome({ image: { ...image, minor: true }, workflowId: 'wf' });
    await settle();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].payload).toMatchObject({ newlyMinor: false });
  });

  it('logs nothing for an unreviewed image outside the sample', async () => {
    reviewed(false);
    await resolveScanOutcome({ image: { ...image, id: 7 }, workflowId: 'wf' });
    await settle();
    expect(lines()).toEqual([]);
  });

  it('logs a sampled unreviewed image, flagged as sampled', async () => {
    reviewed(false);
    await resolveScanOutcome({ image: { ...image, id: 300 }, workflowId: 'wf' });
    await settle();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].payload).toMatchObject({ priorReview: false, sampled: true });
  });

  it('still writes the outcome when the review lookup fails, with no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.mocked(dbMock.dbRead.$queryRaw).mockRejectedValue(new Error('replica down'));
    await resolveScanOutcome({ image: { ...image, minor: false }, workflowId: 'wf' });
    await settle();
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    await settle();
    expect(writtenMinor()).toBe(true);
    expect(lines()).toEqual([]);
  });

  it('does not credit the scan with a CSAM block that landed on the row during the scan', async () => {
    reviewed(true);
    scan.associatedMinor = false;
    const base = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation() as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      strings.join('').includes('SELECT "blockedFor" FROM "Image"')
        ? Promise.resolve([{ blockedFor: 'CSAM' }])
        : base(strings, ...values)) as never);
    await resolveScanOutcome({
      image: { ...image, ingestion: 'Scanned' },
      workflowId: 'wf',
    } as never);
    await settle();
    expect(lines()).toHaveLength(1);
    expect(lines()[0].payload).toMatchObject({ priorReview: true, newlyBlocked: false });
  });

  it('does not hold the outcome for a slow review lookup', async () => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockReturnValue(new Promise(() => undefined) as never);
    await resolveScanOutcome({ image: { ...image, minor: false }, workflowId: 'wf' });
    expect(writtenMinor()).toBe(true);
  });

  it('still writes the outcome when the log line throws', async () => {
    reviewed(true);
    loggingMock.logToAxiom.mockImplementationOnce(() => {
      throw new Error('log down');
    });
    await resolveScanOutcome({ image: { ...image, minor: false }, workflowId: 'wf' });
    expect(writtenMinor()).toBe(true);
  });
});
