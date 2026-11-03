import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The live dev preview's error store (`preview-errors.service.ts`): what is redacted and capped
 * before it is kept, that nothing is kept without a live dev tunnel of the caller's (a production
 * block has none), and the key, cap and TTL it is kept under.
 */

const m = vi.hoisted(() => {
  const pipeline = {
    lPush: vi.fn(),
    lPopCount: vi.fn(),
    lTrim: vi.fn(),
    expire: vi.fn(),
    // A MULTI's replies, one per queued command (the fold reads the LPOP's).
    exec: vi.fn(async (): Promise<unknown[]> => []),
  };
  return {
    pipeline,
    tunnel: vi.fn<(userId: number, blockId: string) => Promise<unknown>>(),
  };
});

vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: m.tunnel,
}));

const { REDACTED, readPreviewErrors, redactSecrets, sanitizePreviewError, storePreviewErrors } =
  await import('~/server/services/app-assistant/preview-errors.service');

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
// TEST-ONLY placeholders shaped like credentials: none is a real one.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJlLXRlc3Qtb25seQ';
const SK = 'sk-test0nly0placeholder0key0000';

// The canonical redis mock (registered in src/__tests__/setup.ts): a pipeline of our own on `multi`.
const { multi, lRange } = redisMock.sysRedis;

beforeEach(() => {
  vi.clearAllMocks();
  multi.mockReturnValue(m.pipeline);
  m.pipeline.exec.mockResolvedValue([]);
  m.tunnel.mockResolvedValue(null);
});

describe('redactSecrets', () => {
  it.each([
    [`token ${JWT} rejected`, `token ${REDACTED} rejected`],
    [
      `Authorization: Bearer abcdef0123456789xyz failed`,
      `Authorization: Bearer ${REDACTED} failed`,
    ],
    [`OpenAI said 401 for key ${SK}.`, `OpenAI said 401 for key ${REDACTED}.`],
    [`sk_live_abcdefghijklmnop1234 leaked`, `${REDACTED} leaked`],
    [
      'GET https://dev-1.apps.example/?dev=abc.def-ghi&x=1 404',
      `GET https://dev-1.apps.example/?dev=${REDACTED}&x=1 404`,
    ],
    [
      'fetch /api?api_key=s3cr3t&token=t0k failed',
      `fetch /api?api_key=${REDACTED}&token=${REDACTED} failed`,
    ],
  ])('redacts %j', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('leaves ordinary error text alone (the control)', () => {
    const text =
      "TypeError: Cannot read properties of undefined (reading 'url') at next (slideshow.ts:41:9) — task-list skipped, risk 0.3";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('sanitizePreviewError', () => {
  it('caps the message at 2,000 and the stack at 4,000 characters, after redacting', () => {
    const out = sanitizePreviewError(
      { message: `${JWT} ${'m'.repeat(3000)}`, stack: 's'.repeat(5000), at: NOW - 1000 },
      NOW
    );
    expect(out.message.startsWith(`${REDACTED} mmm`)).toBe(true);
    expect(out.message).toHaveLength(2000 + '… (cut)'.length);
    expect(out.stack).toHaveLength(4000 + '… (cut)'.length);
    expect(out.at).toBe('2026-10-30T11:59:59.000Z');
  });

  it('reads an old SDK’s bare report: no source, no stack, no time', () => {
    expect(sanitizePreviewError({ message: 'boom' }, NOW)).toEqual({
      kind: 'error',
      at: '2026-10-30T12:00:00.000Z',
      source: 'reported',
      fatal: false,
      message: 'boom',
      stack: null,
    });
  });

  it('keeps a known source, drops an unknown one, and clamps a time into the window', () => {
    expect(sanitizePreviewError({ message: 'x', source: 'console' }, NOW).source).toBe('console');
    expect(sanitizePreviewError({ message: 'x', source: 'eval-me' }, NOW).source).toBe('reported');
    expect(sanitizePreviewError({ message: 'x', at: NOW + 3_600_000 }, NOW).at).toBe(
      '2026-10-30T12:00:00.000Z'
    );
    expect(sanitizePreviewError({ message: 'x', at: 0 }, NOW).at).toBe('2026-10-30T10:00:00.000Z');
  });
});

describe('storePreviewErrors', () => {
  it('keeps nothing without a live dev tunnel of the caller’s: a production block stores nothing', async () => {
    m.tunnel.mockResolvedValue(null);
    expect(
      await storePreviewErrors({
        userId: 41,
        blockId: 'slideshow',
        reports: [{ message: 'boom' }],
        now: NOW,
      })
    ).toEqual({ status: 'not-found' });
    expect(m.tunnel).toHaveBeenCalledWith(41, 'slideshow');
    expect(multi).not.toHaveBeenCalled();
  });

  it('keeps them redacted, newest at the head, capped at 200, for 2 hours, under the user and app', async () => {
    m.tunnel.mockResolvedValue({ userId: 41, blockId: 'slideshow' });
    const out = await storePreviewErrors({
      userId: 41,
      blockId: 'slideshow',
      reports: [
        { message: 'newer', at: NOW - 1_000 },
        { message: `older ${SK}`, at: NOW - 5_000, source: 'error' },
      ],
      now: NOW,
    });
    expect(out).toEqual({ status: 'stored', stored: 2 });
    const key = 'system:blocks:dev-preview-errors:41:slideshow';
    const pushed = m.pipeline.lPush.mock.calls[0] as unknown as [string, string[]];
    expect(pushed[0]).toBe(key);
    // LPUSH pushes in order, so the oldest goes first and the newest ends at the head.
    expect(pushed[1].map((raw) => JSON.parse(raw).message)).toEqual([`older ${REDACTED}`, 'newer']);
    expect(m.pipeline.lTrim).toHaveBeenCalledWith(key, 0, 199);
    expect(m.pipeline.expire).toHaveBeenCalledWith(key, 7200);
    expect(m.pipeline.exec).toHaveBeenCalledTimes(1);
  });

  it('takes at most 20 reports from one call', async () => {
    m.tunnel.mockResolvedValue({ userId: 41, blockId: 'slideshow' });
    const reports = Array.from({ length: 25 }, (_, i) => ({ message: `e${i}`, at: NOW - i }));
    expect(
      await storePreviewErrors({ userId: 41, blockId: 'slideshow', reports, now: NOW })
    ).toEqual({
      status: 'stored',
      stored: 20,
    });
  });
});

describe('storePreviewErrors folds repeats', () => {
  // A loop error at the SDK's 20/min filled the 200-entry list in about 10 minutes and pushed the
  // first (root-cause) error out. Identical consecutive errors are now one entry with a count.
  const KEY = 'system:blocks:dev-preview-errors:41:slideshow';
  const STACK = 'TypeError: x is undefined\n    at next (a.ts:41:9)\n    at tick (a.ts:1:1)';
  const loop = (at: number) => ({
    message: 'TypeError: x is undefined',
    source: 'error',
    stack: STACK,
    at,
  });
  const pushed = () =>
    (m.pipeline.lPush.mock.calls[0] as unknown as [string, string[]])[1].map((raw) =>
      JSON.parse(raw)
    );

  beforeEach(() => {
    m.tunnel.mockResolvedValue({ userId: 41, blockId: 'slideshow' });
    lRange.mockResolvedValue([]);
  });

  it('folds identical consecutive reports in one batch, keeping the count and first and last times', async () => {
    const out = await storePreviewErrors({
      userId: 41,
      blockId: 'slideshow',
      reports: [
        loop(NOW - 1_000),
        loop(NOW - 3_000),
        { message: 'root cause', at: NOW - 9_000 },
        loop(NOW - 2_000),
      ],
      now: NOW,
    });
    expect(out).toEqual({ status: 'stored', stored: 2 });
    expect(pushed()).toEqual([
      {
        kind: 'error',
        at: new Date(NOW - 9_000).toISOString(),
        source: 'reported',
        fatal: false,
        message: 'root cause',
        stack: null,
      },
      {
        kind: 'error',
        at: new Date(NOW - 1_000).toISOString(),
        firstAt: new Date(NOW - 3_000).toISOString(),
        count: 3,
        source: 'error',
        fatal: false,
        message: 'TypeError: x is undefined',
        stack: STACK,
      },
    ]);
    expect(m.pipeline.lPopCount).not.toHaveBeenCalled();
  });

  it('folds into the newest kept entry when it is the same error, replacing it', async () => {
    const head = JSON.stringify({
      kind: 'error',
      at: new Date(NOW - 60_000).toISOString(),
      firstAt: new Date(NOW - 600_000).toISOString(),
      count: 40,
      source: 'error',
      fatal: false,
      message: 'TypeError: x is undefined',
      stack: STACK,
    });
    lRange.mockResolvedValue([head]);
    m.pipeline.exec.mockResolvedValue([[head], 1, 'OK', 1]);
    await storePreviewErrors({
      userId: 41,
      blockId: 'slideshow',
      reports: [loop(NOW - 2_000), loop(NOW - 1_000)],
      now: NOW,
    });
    expect(lRange).toHaveBeenCalledWith(KEY, 0, 0);
    expect(m.pipeline.lPopCount).toHaveBeenCalledWith(KEY, 1);
    expect(pushed()).toEqual([
      {
        kind: 'error',
        at: new Date(NOW - 1_000).toISOString(),
        firstAt: new Date(NOW - 600_000).toISOString(),
        count: 42,
        source: 'error',
        fatal: false,
        message: 'TypeError: x is undefined',
        stack: STACK,
      },
    ]);
    // Only the one replaced entry was taken: nothing to put back.
    expect(m.pipeline.lPush).toHaveBeenCalledTimes(1);
  });

  it('leaves the newest kept entry alone when it is another error', async () => {
    lRange.mockResolvedValue([
      JSON.stringify({
        kind: 'error',
        at: new Date(NOW - 60_000).toISOString(),
        source: 'error',
        fatal: false,
        message: 'other',
        stack: null,
      }),
    ]);
    await storePreviewErrors({
      userId: 41,
      blockId: 'slideshow',
      reports: [loop(NOW - 1_000)],
      now: NOW,
    });
    expect(m.pipeline.lPopCount).not.toHaveBeenCalled();
    expect(pushed()).toHaveLength(1);
  });

  it('puts back an entry another write pushed between the read and the replace', async () => {
    const head = JSON.stringify({
      kind: 'error',
      at: new Date(NOW - 60_000).toISOString(),
      source: 'error',
      fatal: false,
      message: 'TypeError: x is undefined',
      stack: STACK,
    });
    const raced = JSON.stringify({
      kind: 'error',
      at: new Date(NOW - 30_000).toISOString(),
      source: 'console',
      fatal: false,
      message: 'raced',
      stack: null,
    });
    lRange.mockResolvedValue([head]);
    m.pipeline.exec.mockResolvedValueOnce([[raced], 1, 'OK', 1]);
    await storePreviewErrors({
      userId: 41,
      blockId: 'slideshow',
      reports: [loop(NOW - 1_000)],
      now: NOW,
    });
    expect(m.pipeline.lPush).toHaveBeenCalledTimes(2);
    expect(m.pipeline.lPush.mock.calls[1]).toEqual([KEY, [raced]]);
  });
});

describe('readPreviewErrors', () => {
  it('keeps a folded entry’s count and first time', async () => {
    lRange.mockResolvedValue([
      JSON.stringify({
        kind: 'error',
        at: '2026-10-30T11:59:00.000Z',
        firstAt: '2026-10-30T11:50:00.000Z',
        count: 12,
        source: 'error',
        fatal: false,
        message: 'loop',
        stack: null,
      }),
    ]);
    expect(await readPreviewErrors({ userId: 41, blockId: 'slideshow' })).toEqual([
      {
        kind: 'error',
        at: '2026-10-30T11:59:00.000Z',
        firstAt: '2026-10-30T11:50:00.000Z',
        count: 12,
        source: 'error',
        fatal: false,
        message: 'loop',
        stack: null,
      },
    ]);
  });

  it('reads the user’s own list and skips entries that do not parse', async () => {
    lRange.mockResolvedValue([
      JSON.stringify({
        kind: 'error',
        at: '2026-10-30T11:59:00.000Z',
        source: 'console',
        fatal: false,
        message: 'a',
        stack: null,
      }),
      'not json',
      JSON.stringify({ at: 5 }),
      Buffer.from(
        JSON.stringify({
          at: '2026-10-30T11:58:00.000Z',
          source: 'nope',
          fatal: true,
          message: 'b',
          stack: 'at x',
        })
      ),
    ]);
    expect(await readPreviewErrors({ userId: 41, blockId: 'slideshow' })).toEqual([
      {
        kind: 'error',
        at: '2026-10-30T11:59:00.000Z',
        source: 'console',
        fatal: false,
        message: 'a',
        stack: null,
      },
      {
        kind: 'error',
        at: '2026-10-30T11:58:00.000Z',
        source: 'reported',
        fatal: true,
        message: 'b',
        stack: 'at x',
      },
    ]);
    expect(lRange).toHaveBeenCalledWith('system:blocks:dev-preview-errors:41:slideshow', 0, 199);
  });
});
