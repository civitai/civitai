import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { enqueue, openCount } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  openCount: vi.fn<(strings: readonly string[], ...values: unknown[]) => Promise<unknown[]>>(),
}));
vi.mock('~/server/db/kyselyDb', async () => ({
  kyselyWrite: { tag: 'write' },
  kyselyRead: (await import('~/test-utils/kysely-raw-fake')).fakeKysely(openCount),
}));
vi.mock('~/server/services/knights/enqueue.service', () => ({ enqueueKnightsItems: enqueue }));

const {
  clearKnightsSourcesConfigCache,
  parseKnightsSourcesConfig,
  queueOwnerRatingForKnights,
  queueScanSampleForKnights,
} = await import('~/server/services/knights/sources');

const configured = (value: unknown) =>
  redisMock.sysRedis.get.mockResolvedValue(value === null ? null : JSON.stringify(value));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  clearKnightsSourcesConfigCache();
  enqueue.mockResolvedValue([]);
  openCount.mockResolvedValue([{ n: '0' }]);
  configured(null);
});

/** The open Knight-stage count the intake reads, as Postgres returns a count. */
const openItems = (n: number) => openCount.mockResolvedValue([{ n: String(n) }]);
const queuedIds = () => enqueue.mock.calls.map(([, input]) => input.items[0].imageId);

describe('parseKnightsSourcesConfig', () => {
  it.each([null, '', 'not json', '[]', '"on"', '{"enabled":"true"}', '{"enabled":1}'])(
    'is off for %j',
    (raw) => {
      expect(parseKnightsSourcesConfig(raw).enabled).toBe(false);
    }
  );

  it('reads the switch and clamps the rates, falling back to the pool defaults', () => {
    expect(parseKnightsSourcesConfig('{"enabled":true,"sfwRate":4,"nsfwRate":"x"}')).toEqual({
      enabled: true,
      sfwRate: 1,
      nsfwRate: 0.3,
    });
    expect(parseKnightsSourcesConfig('{"enabled":true,"sfwRate":-1,"nsfwRate":0.5}')).toEqual({
      enabled: true,
      sfwRate: 0,
      nsfwRate: 0.5,
    });
  });
});

describe('queueScanSampleForKnights', () => {
  it('does nothing while the switch is off or unset', async () => {
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    configured({ enabled: false });
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues a safe-looking scan at priority 1 and an NSFW one at priority 2', async () => {
    configured({ enabled: true });
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0.99);
    await queueScanSampleForKnights({ imageId: 2, nsfw: true }, () => 0.29);

    expect(enqueue).toHaveBeenNthCalledWith(1, expect.anything(), {
      source: 'scan-sample',
      questionKey: 'knights.image.nsfwLevel',
      items: [{ imageId: 1, priority: 1 }],
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, expect.anything(), {
      source: 'scan-sample',
      questionKey: 'knights.image.nsfwLevel',
      items: [{ imageId: 2, priority: 2 }],
    });
  });

  it('samples each pool by its configured rate', async () => {
    configured({ enabled: true, sfwRate: 0.5, nsfwRate: 0.1 });
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0.6);
    await queueScanSampleForKnights({ imageId: 2, nsfw: true }, () => 0.2);
    expect(enqueue).not.toHaveBeenCalled();

    await queueScanSampleForKnights({ imageId: 3, nsfw: false }, () => 0.4);
    await queueScanSampleForKnights({ imageId: 4, nsfw: true }, () => 0.05);
    expect(enqueue.mock.calls.map(([, input]) => input.items[0].imageId)).toEqual([3, 4]);
  });

  it('never throws into the scan when the enqueue or the config read fails', async () => {
    configured({ enabled: true });
    enqueue.mockRejectedValue(new Error('db down'));
    await expect(
      queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0)
    ).resolves.toBeUndefined();

    redisMock.sysRedis.get.mockRejectedValue(new Error('redis down'));
    await expect(
      queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0)
    ).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(2);
  });
});

describe('the switch read', () => {
  it('reads Redis once per half minute, not once per scan', async () => {
    vi.useFakeTimers();
    configured({ enabled: true });

    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    await queueScanSampleForKnights({ imageId: 2, nsfw: false }, () => 0);
    expect(redisMock.sysRedis.get).toHaveBeenCalledTimes(1);

    configured({ enabled: false });
    vi.advanceTimersByTime(31_000);
    await queueScanSampleForKnights({ imageId: 3, nsfw: false }, () => 0);
    expect(redisMock.sysRedis.get).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('treats a Redis that never answers as off instead of stalling the scan', async () => {
    vi.useFakeTimers();
    redisMock.sysRedis.get.mockReturnValue(new Promise(() => undefined));

    const queued = queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    await vi.advanceTimersByTimeAsync(1_000);
    await queued;

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not remember a timed-out read as off, so the next scan reads Redis again', async () => {
    vi.useFakeTimers();
    redisMock.sysRedis.get.mockReturnValueOnce(new Promise(() => undefined));
    const timedOut = queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;

    configured({ enabled: true });
    await queueScanSampleForKnights({ imageId: 2, nsfw: false }, () => 0);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].items[0].imageId).toBe(2);
  });
});

describe('queueOwnerRatingForKnights', () => {
  it('queues an owner self-rating at priority 1 only when the switch is on', async () => {
    await queueOwnerRatingForKnights(7);
    expect(enqueue).not.toHaveBeenCalled();

    clearKnightsSourcesConfigCache();
    configured({ enabled: true, sfwRate: 0, nsfwRate: 0 });
    await queueOwnerRatingForKnights(7);
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), {
      source: 'owner-rating',
      questionKey: 'knights.image.nsfwLevel',
      items: [{ imageId: 7, priority: 1 }],
    });
  });

  it('swallows a failure', async () => {
    configured({ enabled: true });
    enqueue.mockRejectedValue(new Error('db down'));
    await expect(queueOwnerRatingForKnights(7)).resolves.toBeUndefined();
  });
});

describe('intake backpressure', () => {
  it('skips scan samples while more Knight-stage items are open than maxOpen, and still queues owner ratings', async () => {
    configured({ enabled: true, maxOpen: 10 });
    openItems(11);
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    await queueScanSampleForKnights({ imageId: 2, nsfw: true }, () => 0);
    await queueOwnerRatingForKnights(3);

    expect(queuedIds()).toEqual([3]);
    const [strings, ...values] = openCount.mock.calls[0];
    expect(strings.join('?')).toMatch(/"status" = \?.*"minRank" = \?.*limit \?/s);
    expect(values).toEqual(['Open', 'Knight', 11]);
  });

  it('queues scan samples again at the cap', async () => {
    configured({ enabled: true, maxOpen: 10 });
    openItems(10);
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    expect(queuedIds()).toEqual([1]);
  });

  it('caps at 5000 open items when maxOpen is not set', async () => {
    configured({ enabled: true });
    openItems(5001);
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(openCount.mock.calls[0].slice(1)).toEqual(['Open', 'Knight', 5001]);

    clearKnightsSourcesConfigCache();
    openItems(5000);
    await queueScanSampleForKnights({ imageId: 2, nsfw: false }, () => 0);
    expect(queuedIds()).toEqual([2]);
  });

  it('does not count when the sample roll misses or for owner ratings', async () => {
    configured({ enabled: true, sfwRate: 0.5 });
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0.9);
    await queueOwnerRatingForKnights(2);
    expect(openCount).not.toHaveBeenCalled();
    expect(queuedIds()).toEqual([2]);
  });

  it('counts once a minute, not once per scan', async () => {
    vi.useFakeTimers();
    configured({ enabled: true, maxOpen: 10 });
    openItems(11);
    await queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    await queueScanSampleForKnights({ imageId: 2, nsfw: false }, () => 0);
    expect(openCount).toHaveBeenCalledTimes(1);

    openItems(3);
    vi.advanceTimersByTime(61_000);
    await queueScanSampleForKnights({ imageId: 3, nsfw: false }, () => 0);
    expect(openCount).toHaveBeenCalledTimes(2);
    expect(queuedIds()).toEqual([3]);
  });

  it('queues anyway when the count fails, never throws, and counts again on the next scan', async () => {
    configured({ enabled: true, maxOpen: 10 });
    openCount.mockRejectedValueOnce(new Error('db down'));
    await expect(
      queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0)
    ).resolves.toBeUndefined();
    expect(queuedIds()).toEqual([1]);

    openItems(11);
    await queueScanSampleForKnights({ imageId: 2, nsfw: false }, () => 0);
    expect(openCount).toHaveBeenCalledTimes(2);
    expect(queuedIds()).toEqual([1]);
  });

  it('queues anyway when the count never answers, instead of stalling the scan', async () => {
    vi.useFakeTimers();
    configured({ enabled: true, maxOpen: 10 });
    openCount.mockReturnValueOnce(new Promise(() => undefined));

    const queued = queueScanSampleForKnights({ imageId: 1, nsfw: false }, () => 0);
    await vi.advanceTimersByTimeAsync(1_000);
    await queued;
    expect(queuedIds()).toEqual([1]);

    openItems(11);
    await queueScanSampleForKnights({ imageId: 2, nsfw: false }, () => 0);
    expect(openCount).toHaveBeenCalledTimes(2);
    expect(queuedIds()).toEqual([1]);
  });
});
