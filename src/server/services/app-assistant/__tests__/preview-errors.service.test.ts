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
    lTrim: vi.fn(),
    expire: vi.fn(),
    exec: vi.fn(async () => []),
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

describe('readPreviewErrors', () => {
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
