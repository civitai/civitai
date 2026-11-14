import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blockedNSFW, blockedNSFWOverridable } from '@civitai/mod-utils/prompt-audit/lists';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as ImageService from '~/server/services/image.service';
import type * as Moderation from '~/server/integrations/moderation';

/**
 * With `shadow-age-prompt` on, an age-check hit in the post-scan prompt check is decided by the
 * external classifier; with it off, or when the classifier gives no clean answer, the regex blocks
 * the image as before. The real audit runs.
 */

const { moderatePrompt, isFlipt } = vi.hoisted(() => ({
  moderatePrompt: vi.fn(),
  isFlipt: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));
vi.mock('~/server/integrations/moderation', async (importOriginal) => ({
  ...(await importOriginal<typeof Moderation>()),
  extModeration: { moderatePrompt },
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
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { AGE_PROMPT_SHADOW_EVENT } from '~/server/services/age-prompt-shadow.service';

const AGE_PROMPT = 'portrait of a 14 year old, studio light';
const overridable = new Set(blockedNSFWOverridable);
const hardWord = blockedNSFW.find((w) => /^[a-z]+$/.test(w) && !overridable.has(w));
if (!hardWord) throw new Error('no hard-blocked word to test with');

const image = () =>
  ({
    id: 1,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt: AGE_PROMPT },
    metadata: {},
    postId: null,
    nsfwLevelLocked: false,
    nsfwLevel: 0,
    ingestion: 'Pending',
  } as unknown as ScanImage);

const scan = (prompt = AGE_PROMPT) =>
  resolveScanOutcome({ image: image(), workflowId: 'wf', prompt });

function shadowEvents() {
  return loggingMock.logToAxiom.mock.calls
    .map(([event]) => event as Record<string, unknown>)
    .filter((event) => event?.name === AGE_PROMPT_SHADOW_EVENT);
}

beforeEach(() => {
  vi.clearAllMocks();
  // An R-rated tag, so the scan runs the nsfw prompt checks.
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: 16, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  moderatePrompt.mockResolvedValue({ flagged: false, categories: [] });
  isFlipt.mockImplementation(
    async (flag: string) => flag === FLIPT_FEATURE_FLAGS.SHADOW_AGE_PROMPT
  );
  setEnv({
    EXTERNAL_MODERATION_ENDPOINT: 'https://classifier.test',
    EXTERNAL_MODERATION_TOKEN: 't',
  });
});

describe('post-scan prompt check — age check behind shadow-age-prompt', () => {
  it('flag off: the age hit blocks the image without asking the classifier, and logs no shadow event', async () => {
    isFlipt.mockResolvedValue(false);
    const outcome = await scan();
    expect(outcome.ingestion).toBe('Blocked');
    expect(moderatePrompt).not.toHaveBeenCalled();
    expect(shadowEvents()).toHaveLength(0);
  });

  it('flag on, classifier clean: not blocked, shadow event logged', async () => {
    const outcome = await scan();
    expect(outcome.ingestion).not.toBe('Blocked');
    expect(moderatePrompt).toHaveBeenCalledTimes(1);
    expect(shadowEvents()).toEqual([
      expect.objectContaining({
        surface: 'post-scan',
        ageBucket: '13-17',
        classifierVerdict: 'clean',
        classifierStatus: 'ok',
        blocked: false,
      }),
    ]);
  });

  it('flag on, classifier flags: blocked', async () => {
    moderatePrompt.mockResolvedValue({ flagged: true, categories: ['minor'] });
    const outcome = await scan();
    expect(outcome.ingestion).toBe('Blocked');
    expect(shadowEvents()[0]).toMatchObject({ classifierVerdict: 'flagged', blocked: true });
  });

  it('flag on, classifier throws: the regex blocks it, event says failed', async () => {
    moderatePrompt.mockRejectedValue(new Error('timeout'));
    const outcome = await scan();
    expect(outcome.ingestion).toBe('Blocked');
    expect(shadowEvents()[0]).toMatchObject({
      classifierStatus: 'failed',
      classifierVerdict: 'none',
      blocked: true,
    });
  });

  it('flag on, classifier not configured: the regex blocks it, event says skipped', async () => {
    setEnv({ EXTERNAL_MODERATION_ENDPOINT: undefined });
    const outcome = await scan();
    expect(outcome.ingestion).toBe('Blocked');
    expect(moderatePrompt).not.toHaveBeenCalled();
    expect(shadowEvents()[0]).toMatchObject({ classifierStatus: 'skipped', blocked: true });
  });

  it('flag on, classifier clean: another regex hit in the same prompt still blocks it', async () => {
    const outcome = await scan(`${AGE_PROMPT}, ${hardWord}`);
    expect(outcome.ingestion).toBe('Blocked');
    expect(shadowEvents()[0]).toMatchObject({ blocked: true });
  });

  it('control: that word alone blocks', async () => {
    expect((await scan(hardWord)).ingestion).toBe('Blocked');
  });

  it('buckets an age under 13 as <13', async () => {
    await scan('portrait of a 12 year old, studio light');
    expect(shadowEvents()[0]).toMatchObject({ ageBucket: '<13' });
  });

  it('the shadow event carries no prompt, user or image field', async () => {
    await scan();
    const [event] = shadowEvents();
    expect(Object.keys(event).sort()).toEqual(
      [
        'ageBucket',
        'blocked',
        'classifierStatus',
        'classifierVerdict',
        'name',
        'surface',
        'type',
      ].sort()
    );
    expect(JSON.stringify(event)).not.toContain('14 year');
  });
});
