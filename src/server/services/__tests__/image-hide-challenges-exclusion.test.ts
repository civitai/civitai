import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';

// `hideChallenges` is a boolean the client sends; the SERVER owns the tag id and unions it into
// `excludedTagIds`, which every image query path already filters on. These tests pin that mapping
// at both service entry points, because that is the only place it happens — a path that stopped
// going through getAllImages / getAllImagesIndex would silently serve an unfiltered feed.
//
// Both entry points mutate `input` in place (mirroring enforceBlockedBrowsingTags), so the
// assertions read the input object after the call. The calls are expected to reject once they
// reach real infra; the mapping runs before that, which is exactly what makes this cheap to test.
//
// Mock recipe follows getAllImages-prioritized-guards.test.ts: stub env + infra clients + the
// event-engine-common submodule so importing image.service boots no real infra.

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/client', () => {
  type KeyProxy = (() => string) & { [key: string]: KeyProxy };
  const make = (): KeyProxy => new Proxy((() => 'k') as KeyProxy, { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() } },
    sysRedis: {},
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
  };
});

// The mapping sits directly after this call in both entry points — a non-empty result lets
// execution reach it.
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

import { getAllImages, getAllImagesIndex } from '../image.service';
import { dailyChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

const CHALLENGE_TAG_ID = dailyChallengeConfig.challengeTagId;

type FeedInput = Record<string, unknown>;

// Both entry points reject once they reach real infra; the mapping has already run by then.
const entryPoints: [string, (input: FeedInput) => Promise<unknown>][] = [
  [
    'getAllImages',
    (input) =>
      getAllImages(input as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined),
  ],
  [
    'getAllImagesIndex',
    (input) =>
      getAllImagesIndex(input as unknown as Parameters<typeof getAllImagesIndex>[0]).catch(
        () => undefined
      ),
  ],
];

const baseInput = (): FeedInput => ({ browsingLevel: 1, include: [] });

describe('hideChallenges → excludedTagIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a real tag id, not a placeholder', () => {
    expect(CHALLENGE_TAG_ID).toBe(676575);
  });

  describe.each(entryPoints)('%s', (_name, run) => {
    it('adds the challenge tag id when hideChallenges is true', async () => {
      const input = { ...baseInput(), hideChallenges: true };
      await run(input);

      expect(input.excludedTagIds).toContain(CHALLENGE_TAG_ID);
    });

    it('unions with caller-supplied excludedTagIds rather than replacing them', async () => {
      const input = { ...baseInput(), hideChallenges: true, excludedTagIds: [42] };
      await run(input);

      expect(input.excludedTagIds).toEqual(expect.arrayContaining([42, CHALLENGE_TAG_ID]));
    });

    it('does not add the tag id when hideChallenges is absent', async () => {
      const input = { ...baseInput(), excludedTagIds: [42] };
      await run(input);

      expect(input.excludedTagIds).not.toContain(CHALLENGE_TAG_ID);
    });

    it('does not add the tag id when hideChallenges is false', async () => {
      const input = { ...baseInput(), hideChallenges: false, excludedTagIds: [42] };
      await run(input);

      expect(input.excludedTagIds).not.toContain(CHALLENGE_TAG_ID);
    });
  });
});
