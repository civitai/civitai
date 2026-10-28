import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('~/server/db/kyselyDb', () => ({ kyselyWrite: { tag: 'write' } }));
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
  configured(null);
});

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
