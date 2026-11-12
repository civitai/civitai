import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';
import { NsfwLevel } from '~/server/common/enums';
import { styleTags, tagsNeedingReview } from '~/libs/tags';
import { poiWords } from '@civitai/mod-utils/prompt-audit/lists';

/**
 * The scan logs, and never routes, an unrated scan that would take the newer minor review routing.
 * Routing must be the same whether or not the log call succeeds.
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

import {
  resolveScanOutcome,
  UNRATED_MINOR_REVIEW_EVENT,
  type ScanImage,
} from '../image-scan-pipeline';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { includesInappropriate } from '~/utils/metadata/audit';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const logToAxiom = loggingMock.logToAxiom as unknown as ReturnType<typeof vi.fn>;

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

type Scan = {
  tags: { name: string; nsfwLevel: number }[];
  associatedMinor: boolean;
  promptMinor: boolean;
};
let scan: Scan;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return scan.tags.map((tag, i) => ({ id: 10 + i, type: 'Label', confidence: 90, ...tag }));
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: scan.associatedMinor, hasResource: scan.associatedMinor }];
  }) as never);
  // The prompt's minor check matches only when it runs as if the image were rated mature.
  vi.mocked(includesInappropriate).mockImplementation(((_: unknown, nsfw?: boolean) =>
    scan.promptMinor && nsfw ? 'minor' : false) as never);
});

async function run(s: Scan) {
  scan = s;
  const outcome = await resolveScanOutcome({ image, workflowId: 'wf', prompt: 'a quiet field' });
  const arms = vi
    .mocked(logToAxiom)
    .mock.calls.map(([event]) => event as { name: string; arm?: string })
    .filter((event) => event.name === UNRATED_MINOR_REVIEW_EVENT)
    .map((event) => event.arm);
  return { minorReview: outcome.audit?.minorReview, reviewKey: outcome.reviewKey, arms };
}

const minorTag = tagsNeedingReview[0];
const styleTag = styleTags[0];
const poiTag = poiWords[0];

const CASES: [string, Scan, { minorReview: boolean; arms: string[] }][] = [
  [
    'unrated, resource',
    { tags: [{ name: 'scene', nsfwLevel: 0 }], associatedMinor: true, promptMinor: false },
    { minorReview: false, arms: ['resource'] },
  ],
  [
    'unrated, tag',
    {
      tags: [
        { name: minorTag, nsfwLevel: 0 },
        { name: styleTag, nsfwLevel: 0 },
      ],
      associatedMinor: false,
      promptMinor: false,
    },
    { minorReview: false, arms: ['tag'] },
  ],
  // The prompt check is gated by the general NSFW flag, not the minor rule: not counted.
  [
    'unrated, prompt',
    { tags: [{ name: 'scene', nsfwLevel: 0 }], associatedMinor: false, promptMinor: true },
    { minorReview: false, arms: [] },
  ],
  // Already routed, or not a candidate: nothing logged.
  [
    'unrated, minor tag without a style tag',
    { tags: [{ name: minorTag, nsfwLevel: 0 }], associatedMinor: false, promptMinor: false },
    { minorReview: true, arms: [] },
  ],
  [
    'unrated, minor and adult tags',
    {
      tags: [
        { name: minorTag, nsfwLevel: 0 },
        { name: styleTag, nsfwLevel: 0 },
        { name: 'adult', nsfwLevel: 0 },
      ],
      associatedMinor: false,
      promptMinor: false,
    },
    { minorReview: false, arms: [] },
  ],
  [
    'unrated, resource on an image routed to the person queue',
    { tags: [{ name: poiTag, nsfwLevel: 0 }], associatedMinor: true, promptMinor: false },
    { minorReview: false, arms: [] },
  ],
  [
    'unrated, no signal',
    { tags: [{ name: 'scene', nsfwLevel: 0 }], associatedMinor: false, promptMinor: false },
    { minorReview: false, arms: [] },
  ],
  [
    'mature, resource',
    {
      tags: [{ name: 'scene', nsfwLevel: NsfwLevel.R }],
      associatedMinor: true,
      promptMinor: false,
    },
    { minorReview: true, arms: [] },
  ],
  [
    'safe, resource',
    {
      tags: [{ name: 'scene', nsfwLevel: NsfwLevel.PG }],
      associatedMinor: true,
      promptMinor: false,
    },
    { minorReview: false, arms: [] },
  ],
];

describe('unrated minor review candidates', () => {
  it.each(CASES)('%s: routes as before and logs %o', async (_, s, expected) => {
    const result = await run(s);
    expect(result.minorReview).toBe(expected.minorReview);
    expect(result.arms).toEqual(expected.arms);
  });

  it.each(CASES)('%s: routing is the same when the log call fails', async (_, s) => {
    const logged = await run(s);
    vi.clearAllMocks();
    logToAxiom.mockRejectedValue(new Error('log sink down'));
    const failed = await run(s);
    expect({ minorReview: failed.minorReview, reviewKey: failed.reviewKey }).toEqual({
      minorReview: logged.minorReview,
      reviewKey: logged.reviewKey,
    });
  });

  it('logs only the image id, the arm and a time', async () => {
    await run(CASES[0][1]);
    const event = vi
      .mocked(logToAxiom)
      .mock.calls.map(([e]) => e as Record<string, unknown>)
      .find((e) => e.name === UNRATED_MINOR_REVIEW_EVENT);
    expect(Object.keys(event ?? {}).sort()).toEqual(['arm', 'at', 'imageId', 'name', 'type']);
  });
});
