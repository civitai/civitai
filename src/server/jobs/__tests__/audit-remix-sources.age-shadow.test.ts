import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * With `shadow-age-prompt` on, an age-check hit on a remix source is decided by the external
 * classifier; with it off, or when the classifier gives no clean answer, the regex flags it as
 * before. The real audit runs; I/O, Flipt and the classifier are mocked.
 */

const { moderatePrompt, chQuery, isFlipt } = vi.hoisted(() => ({
  moderatePrompt: vi.fn(),
  chQuery: vi.fn(async () => [{ remixOfId: 101 }]),
  isFlipt: vi.fn(),
}));

vi.mock('~/server/jobs/job', () => ({
  createJob: (_name: string, _cron: string, fn: (ctx: unknown) => Promise<unknown>) => ({
    name: _name,
    cron: _cron,
    run: () => ({
      result: fn({ checkIfCanceled: () => undefined }),
      cancel: () => Promise.resolve(),
    }),
    options: {},
  }),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: chQuery } }));
vi.mock('~/server/integrations/moderation', () => ({ extModeration: { moderatePrompt } }));
vi.mock('~/server/services/post.service', () => ({ bustCachesForPosts: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));

import { auditRemixSourcesJob } from '~/server/jobs/audit-remix-sources';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { AGE_PROMPT_SHADOW_EVENT } from '~/server/services/age-prompt-shadow.service';

const AGE_PROMPT = 'portrait of a 14 year old, studio light';

const findUnique = dbMock.dbRead.image.findUnique;
const update = dbMock.dbWrite.image.updateManyAndReturn;

const runJob = async () => {
  await auditRemixSourcesJob.run({} as never).result;
};

const flagged = () => update.mock.calls.length > 0;

function shadowEvents() {
  return loggingMock.logToAxiom.mock.calls
    .map(([event]) => event as Record<string, unknown>)
    .filter((event) => event?.name === AGE_PROMPT_SHADOW_EVENT);
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.get.mockResolvedValue(null);
  update.mockResolvedValue([{ postId: null }] as never);
  findUnique.mockResolvedValue({
    id: 101,
    meta: { prompt: AGE_PROMPT },
    metadata: null,
    userId: 7,
    needsReview: null,
    ingestion: 'Scanned',
  } as never);
  moderatePrompt.mockResolvedValue({ flagged: false, categories: [] });
  isFlipt.mockImplementation(
    async (flag: string) => flag === FLIPT_FEATURE_FLAGS.SHADOW_AGE_PROMPT
  );
  setEnv({
    EXTERNAL_MODERATION_ENDPOINT: 'https://classifier.test',
    EXTERNAL_MODERATION_TOKEN: 't',
  });
});

describe('audit-remix-sources — age check behind shadow-age-prompt', () => {
  it('flag off: the age hit flags the source without asking the classifier, and logs no shadow event', async () => {
    isFlipt.mockResolvedValue(false);
    await runJob();
    expect(flagged()).toBe(true);
    expect(moderatePrompt).not.toHaveBeenCalled();
    expect(shadowEvents()).toHaveLength(0);
  });

  it('flag on, classifier clean: not flagged, classifier asked once, shadow event logged', async () => {
    await runJob();
    expect(flagged()).toBe(false);
    expect(moderatePrompt).toHaveBeenCalledTimes(1);
    expect(moderatePrompt).toHaveBeenCalledWith(AGE_PROMPT, 'remixAudit');
    expect(shadowEvents()).toEqual([
      expect.objectContaining({
        surface: 'remix-source',
        ageBucket: '13-17',
        classifierVerdict: 'clean',
        classifierStatus: 'ok',
        blocked: false,
      }),
    ]);
  });

  it('flag on, classifier flags: flagged', async () => {
    moderatePrompt.mockResolvedValue({ flagged: true, categories: ['minor'] });
    await runJob();
    expect(flagged()).toBe(true);
    expect(shadowEvents()[0]).toMatchObject({ classifierVerdict: 'flagged', blocked: true });
  });

  it('flag on, classifier throws: the regex flags it, event says failed', async () => {
    moderatePrompt.mockRejectedValue(new Error('timeout'));
    await runJob();
    expect(flagged()).toBe(true);
    expect(shadowEvents()[0]).toMatchObject({
      classifierStatus: 'failed',
      classifierVerdict: 'none',
      blocked: true,
    });
  });

  it('flag on, classifier not configured: the regex flags it, event says skipped', async () => {
    setEnv({ EXTERNAL_MODERATION_TOKEN: undefined });
    await runJob();
    expect(flagged()).toBe(true);
    expect(moderatePrompt).not.toHaveBeenCalled();
    expect(shadowEvents()[0]).toMatchObject({ classifierStatus: 'skipped', blocked: true });
  });

  it('flag on, classifier clean: another regex hit in the same prompt still flags it', async () => {
    findUnique.mockResolvedValue({
      id: 101,
      meta: { prompt: `${AGE_PROMPT}, tom cruise` },
      metadata: null,
      userId: 7,
      needsReview: null,
      ingestion: 'Scanned',
    } as never);
    await runJob();
    expect(flagged()).toBe(true);
  });

  it('the shadow event carries no prompt, user or image field', async () => {
    await runJob();
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
    expect(JSON.stringify(event)).not.toContain('101');
  });
});
