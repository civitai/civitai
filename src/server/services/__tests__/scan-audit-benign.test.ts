import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  nsfwPromptWords,
  nsfwWordsPaddle,
  nsfwWordsSoft,
  youngWords,
} from '@civitai/mod-utils/prompt-audit/lists';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';
import { includesInappropriate, includesNsfw } from '~/utils/metadata/audit';

const strip = vi.hoisted(() => ({ phrase: '' }));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: async (text: string) =>
    strip.phrase ? text.split(strip.phrase).join(' ').trim() : text,
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

beforeEach(() => {
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails')) return [];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
});

/** Two words the audit flags together but not apart. */
function pickPair() {
  for (const n of [...nsfwPromptWords, ...nsfwWordsSoft, ...nsfwWordsPaddle]) {
    if (!/^[a-z]+$/.test(n) || !includesNsfw(n)) continue;
    for (const y of youngWords.nouns) {
      if (!/^[a-z]+$/.test(y) || includesInappropriate({ prompt: y })) continue;
      if (includesInappropriate({ prompt: `${n} ${y}` }) === 'minor') return { n, y };
    }
  }
  throw new Error('no word pair found');
}

const minorReview = async (prompt: string) =>
  (await resolveScanOutcome({ image, workflowId: 'wf', prompt })).audit?.minorReview;

describe('the scan prompt audit with benign phrases', () => {
  const { n, y } = pickPair();

  it('reviews the pair when nothing is stripped', async () => {
    strip.phrase = '';
    expect(await minorReview(`${n} ${y}`)).toBe(true);
  });

  it('decides which checks run from the prompt as written', async () => {
    strip.phrase = n;
    expect(await minorReview(`${n} ${y}`)).toBe(true);
  });

  it('does not review the second word alone', async () => {
    strip.phrase = '';
    expect(await minorReview(y)).toBe(false);
  });
});
