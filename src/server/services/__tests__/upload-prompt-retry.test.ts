import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockIsFlipt, mockRecordFlag, mockHasFlag } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockIsFlipt: vi.fn(),
  mockRecordFlag: vi.fn(),
  mockHasFlag: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: mockRequest,
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { SCAN_LABEL_QUEUE_WRITER: 'scan-label-queue-writer' },
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/services/scan-label-flag.service', () => ({
  recordScanLabelFlag: mockRecordFlag,
  hasScanLabelFlag: mockHasFlag,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  retryUploadPromptScans,
  type RetryUploadPromptScansDeps,
} from '~/server/jobs/retry-upload-prompt-scans';
import {
  queueUploadPromptRetry,
  takeDueUploadPromptRetries,
  UPLOAD_PROMPT_MAX_RETRIES,
  type UploadPromptRetryStore,
} from '~/server/services/upload-prompt-retry.service';
import { labelUploadPrompt } from '~/server/services/upload-prompt-scan.service';

const HOUR = 60 * 60_000;

/** A sorted set and a hash with Redis's semantics; members come back as Buffers, as Sentinel does. */
function fakeStore() {
  const zset = new Map<string, number>();
  const hash = new Map<string, string>();
  const store = {
    hSet: async (_key: string, field: string, value: string) => (hash.set(field, value), 1),
    hGet: async (_key: string, field: string) => hash.get(field) ?? null,
    hDel: async (_key: string, field: string) => (hash.delete(field) ? 1 : 0),
    zAdd: async (_key: string, { score, value }: { score: number; value: string }) => {
      if (Number.isNaN(score)) throw new Error('ERR value is not a valid float');
      zset.set(value, score);
      return 1;
    },
    zRem: async (_key: string, member: string) => (zset.delete(member) ? 1 : 0),
    // BY: 'SCORE' reads min/max as scores; without it Redis reads them as ranks (positions).
    zRange: async (
      _key: string,
      min: number,
      max: number,
      opts?: { BY?: string; LIMIT?: { offset: number; count: number } }
    ) => {
      const sorted = [...zset].sort((a, b) => a[1] - b[1]);
      const inRange =
        opts?.BY === 'SCORE'
          ? sorted.filter(([, score]) => score >= min && score <= max)
          : sorted.slice(min, max === -1 ? undefined : max + 1);
      const limit = opts?.LIMIT;
      return (limit ? inRange.slice(limit.offset, limit.offset + limit.count) : inRange).map(
        ([member]) => Buffer.from(member)
      );
    },
  };
  return { zset, hash, store: store as unknown as UploadPromptRetryStore, raw: store };
}

describe('upload prompt retry queue', () => {
  const T0 = 1_800_000_000_000;

  it('hands an entry back once it is due, and only once', async () => {
    const { store } = fakeStore();
    expect(await queueUploadPromptRetry({ imageId: 5, attempt: 1, now: T0, store })).toBe(true);

    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + 60_000, store })).toEqual([]);
    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + 14 * 60_000, store })).toEqual(
      []
    );
    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + 15 * 60_000, store })).toEqual([
      { imageId: 5, attempt: 1 },
    ]);
    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + HOUR, store })).toEqual([]);
  });

  it('waits longer before each later retry', async () => {
    const { store } = fakeStore();
    await queueUploadPromptRetry({ imageId: 4, attempt: 2, now: T0, store });
    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + 59 * 60_000, store })).toEqual(
      []
    );
    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + HOUR, store })).toEqual([
      { imageId: 4, attempt: 2 },
    ]);

    await queueUploadPromptRetry({ imageId: 5, attempt: 3, now: T0, store });

    expect(
      await takeDueUploadPromptRetries({ limit: 10, now: T0 + 4 * HOUR - 60_000, store })
    ).toEqual([]);
    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + 4 * HOUR, store })).toEqual([
      { imageId: 5, attempt: 3 },
    ]);
  });

  it('queues nothing past the cap', async () => {
    const { store, zset } = fakeStore();
    expect(
      await queueUploadPromptRetry({
        imageId: 5,
        attempt: UPLOAD_PROMPT_MAX_RETRIES + 1,
        now: T0,
        store,
      })
    ).toBe(false);
    expect(zset.size).toBe(0);
  });

  it('gives two runs racing for the same entry one copy of it', async () => {
    const { store } = fakeStore();
    await queueUploadPromptRetry({ imageId: 5, attempt: 1, now: T0, store });

    const runs = await Promise.all([
      takeDueUploadPromptRetries({ limit: 10, now: T0 + HOUR, store }),
      takeDueUploadPromptRetries({ limit: 10, now: T0 + HOUR, store }),
    ]);
    expect(runs.flat()).toEqual([{ imageId: 5, attempt: 1 }]);
  });

  it('treats an entry whose attempt was lost as the last retry', async () => {
    const { store, hash } = fakeStore();
    await queueUploadPromptRetry({ imageId: 5, attempt: 1, now: T0, store });
    hash.clear();

    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + HOUR, store })).toEqual([
      { imageId: 5, attempt: UPLOAD_PROMPT_MAX_RETRIES },
    ]);
  });

  it('takes no more than the limit, leaving the rest queued', async () => {
    const { store, zset } = fakeStore();
    for (const imageId of [1, 2, 3])
      await queueUploadPromptRetry({ imageId, attempt: 1, now: T0, store });

    expect(await takeDueUploadPromptRetries({ limit: 2, now: T0 + HOUR, store })).toHaveLength(2);
    expect(zset.size).toBe(1);
  });

  it('still hands back an entry whose attempt cannot be read, as the last retry', async () => {
    const { store, raw } = fakeStore();
    await queueUploadPromptRetry({ imageId: 5, attempt: 1, now: T0, store });
    raw.hGet = async () => {
      throw new Error('deadline');
    };

    expect(await takeDueUploadPromptRetries({ limit: 10, now: T0 + HOUR, store })).toEqual([
      { imageId: 5, attempt: UPLOAD_PROMPT_MAX_RETRIES },
    ]);
  });

  it('reports a failed write as not queued instead of throwing', async () => {
    const { store, raw } = fakeStore();
    raw.hSet = async () => {
      throw new Error('redis down');
    };
    expect(await queueUploadPromptRetry({ imageId: 5, attempt: 1, now: T0, store })).toBe(false);
  });
});

describe('retrying upload prompt scans end to end', () => {
  let fake: ReturnType<typeof fakeStore>;
  const workflow = (triggered: boolean) => ({
    id: 'xg-1',
    steps: [
      {
        $type: 'xGuardModeration',
        output: { results: [{ label: 'young', score: 0.1, threshold: 0.5, triggered }] },
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    mockIsFlipt.mockResolvedValue(true);
    mockHasFlag.mockResolvedValue(false);
    fake = fakeStore();
    for (const cmd of ['hSet', 'hGet', 'hDel', 'zAdd', 'zRem', 'zRange'] as const)
      redisMock.sysRedis[cmd].mockImplementation(fake.raw[cmd]);
  });
  afterEach(() => vi.useRealTimers());

  const deps = (over: Partial<RetryUploadPromptScansDeps> = {}): RetryUploadPromptScansDeps => ({
    take: (limit) => takeDueUploadPromptRetries({ limit }),
    loadImages: async (ids) =>
      ids.map((id) => ({ id, userId: 2, prompt: 'a prompt', negativePrompt: null })),
    label: labelUploadPrompt,
    requeue: queueUploadPromptRetry,
    now: Date.now,
    ...over,
  });

  /** Runs the job every 5 hours of fake time until the queue empties, capped so a loop shows. */
  async function drain(d = deps()) {
    let runs = 0;
    while (fake.zset.size && runs < 20) {
      vi.setSystemTime(Date.now() + 5 * HOUR);
      await retryUploadPromptScans(d);
      runs++;
    }
    return runs;
  }

  it('scans a prompt that never gets a verdict 1 + the retry cap times, then stops', async () => {
    mockRequest.mockRejectedValue(new Error('orchestrator down'));

    await labelUploadPrompt({ imageId: 9, userId: 2, prompt: 'a prompt' });
    const runs = await drain();

    expect(mockRequest).toHaveBeenCalledTimes(1 + UPLOAD_PROMPT_MAX_RETRIES);
    expect(runs).toBe(UPLOAD_PROMPT_MAX_RETRIES);
    expect(fake.zset.size).toBe(0);
    expect(fake.hash.size).toBe(0);
    expect(mockRecordFlag).not.toHaveBeenCalled();
  });

  it('labels a prompt the retry flags, and queues it no further', async () => {
    mockRequest.mockRejectedValueOnce(new Error('timed out')).mockResolvedValue(workflow(true));

    await labelUploadPrompt({ imageId: 9, userId: 2, prompt: 'a prompt' });
    await drain();

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRecordFlag).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 9, source: 'xguard-prompt', workflowId: 'xg-1' })
    );
    expect(fake.zset.size).toBe(0);
  });

  it('queues nothing for a prompt with a verdict', async () => {
    mockRequest.mockResolvedValue(workflow(false));

    await labelUploadPrompt({ imageId: 9, userId: 2, prompt: 'a prompt' });

    expect(fake.zset.size).toBe(0);
  });

  it('queues a retry when the pre-scan checks fail', async () => {
    mockHasFlag.mockRejectedValueOnce(new Error('db down'));

    await labelUploadPrompt({ imageId: 9, userId: 2, prompt: 'a prompt' });

    expect([...fake.zset.keys()]).toEqual(['9']);
    expect(fake.hash.get('9')).toBe('1');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('counts a failed pre-scan check against the cap', async () => {
    mockHasFlag.mockRejectedValue(new Error('db down'));

    await labelUploadPrompt({ imageId: 9, userId: 2, prompt: 'a prompt' });
    const runs = await drain();

    expect(runs).toBe(UPLOAD_PROMPT_MAX_RETRIES);
    expect(fake.zset.size).toBe(0);
  });

  it('drops an image that is gone or has no prompt, without scanning', async () => {
    await queueUploadPromptRetry({ imageId: 1, attempt: 1 });
    await queueUploadPromptRetry({ imageId: 2, attempt: 1 });
    vi.setSystemTime(Date.now() + 5 * HOUR);

    const result = await retryUploadPromptScans(
      deps({ loadImages: async () => [{ id: 2, userId: 3, prompt: '  ', negativePrompt: null }] })
    );

    expect(result).toEqual({ taken: 2, scanned: 0, dropped: 2 });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(fake.zset.size).toBe(0);
  });

  it('puts entries back as their next attempt when the images cannot be read', async () => {
    await queueUploadPromptRetry({ imageId: 1, attempt: 1 });
    vi.setSystemTime(Date.now() + 5 * HOUR);

    await expect(
      retryUploadPromptScans(
        deps({
          loadImages: async () => {
            throw new Error('replica down');
          },
        })
      )
    ).rejects.toThrow('replica down');

    expect(fake.hash.get('1')).toBe('2');
    expect(fake.zset.has('1')).toBe(true);
  });

  it('starts no new batch once the run is cancelled', async () => {
    mockRequest.mockResolvedValue(workflow(false));
    for (const imageId of [1, 2, 3, 4, 5, 6, 7])
      await queueUploadPromptRetry({ imageId, attempt: 1 });
    vi.setSystemTime(Date.now() + 5 * HOUR);
    let canceled = false;

    const result = await retryUploadPromptScans(
      deps({
        label: async (args) => {
          canceled = true;
          return labelUploadPrompt(args);
        },
        isCanceled: () => canceled,
      })
    );

    expect(result.taken).toBe(5);
    expect(fake.zset.size).toBe(2);
  });

  it('starts no new batch once the run budget is spent', async () => {
    mockRequest.mockResolvedValue(workflow(false));
    for (const imageId of [1, 2, 3, 4, 5, 6, 7])
      await queueUploadPromptRetry({ imageId, attempt: 1 });
    vi.setSystemTime(Date.now() + 5 * HOUR);
    let clock = Date.now();

    const result = await retryUploadPromptScans(deps({ now: () => (clock += 4 * 60 * 1000) }));

    // The first batch starts inside the budget; the second would start past it.
    expect(result.taken).toBe(5);
    expect(fake.zset.size).toBe(2);
  });
});
