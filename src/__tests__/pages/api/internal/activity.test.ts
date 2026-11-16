import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `/api/internal/activity` is unauthenticated on purpose (the browser's ActivityReportingProvider
// posts to it), and every accepted entry becomes one ClickHouse row. These cases pin that a request
// the client can never produce is refused BEFORE any row is written.
//
// The limits are pinned as LITERALS, not imported from the constants module, so a change to the
// contract has to be made here on purpose rather than flowing through silently.

const mocks = vi.hoisted(() => ({
  activity: vi.fn(),
  checkActivityRateLimit: vi.fn<(ip: string) => Promise<unknown>>(),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    activity = mocks.activity;
  },
}));

// The limiter's own suite (`src/server/utils/__tests__/activity-rate-limit.test.ts`) pins its store
// and numbers; here only its verdict matters.
vi.mock('~/server/utils/activity-rate-limit', () => ({
  checkActivityRateLimit: mocks.checkActivityRateLimit,
}));

import handler from '~/pages/api/internal/activity';

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
}

async function post(body: unknown) {
  const res = makeRes();
  const req = {
    method: 'POST',
    body,
    headers: {},
    query: {},
    socket: { remoteAddress: '192.0.2.10' },
  } as unknown as NextApiRequest;
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activity.mockResolvedValue(true);
  mocks.checkActivityRateLimit.mockResolvedValue({ allowed: true });
});

describe('/api/internal/activity', () => {
  it('writes one row per entry for a valid batch', async () => {
    const res = await post({ activities: ['remix:image', 'copy:prompt', 'tool-click:42'] });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ count: 3 });
    expect(mocks.activity.mock.calls).toEqual([
      ['remix:image'],
      ['copy:prompt'],
      ['tool-click:42'],
    ]);
  });

  it('accepts a batch of exactly 200 entries (the cap)', async () => {
    const res = await post({ activities: Array.from({ length: 200 }, () => 'remix:image') });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.activity).toHaveBeenCalledTimes(200);
  });

  it('rejects an oversized batch with 400 and writes nothing', async () => {
    const res = await post({ activities: Array.from({ length: 201 }, () => 'remix:image') });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('rejects a batch with a non-string entry with 400 and writes nothing', async () => {
    const res = await post({ activities: ['remix:image', 42] });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('rejects an entry longer than 100 characters with 400 and writes nothing', async () => {
    const res = await post({ activities: ['remix:image', `tool-click:${'x'.repeat(90)}`] });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('rejects an empty entry with 400 and writes nothing', async () => {
    const res = await post({ activities: [''] });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('rejects a body with no activities array with 400', async () => {
    const res = await post({});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('answers a refused batch with the shared REST error envelope', async () => {
    const res = await post({ activities: Array.from({ length: 201 }, () => 'remix:image') });

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BAD_REQUEST', message: 'Invalid activity batch' })
    );
  });

  it('checks the rate limit for a valid batch, keyed on the caller address', async () => {
    await post({ activities: ['remix:image'] });

    expect(mocks.checkActivityRateLimit).toHaveBeenCalledWith('192.0.2.10');
  });

  it('answers 429 with Retry-After and writes nothing when the caller is over the limit', async () => {
    mocks.checkActivityRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });

    const res = await post({ activities: ['remix:image', 'copy:prompt'] });

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '17');
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('does not spend rate-limit budget on a batch it refuses as malformed', async () => {
    await post({ activities: [42] });

    expect(mocks.checkActivityRateLimit).not.toHaveBeenCalled();
  });
});
