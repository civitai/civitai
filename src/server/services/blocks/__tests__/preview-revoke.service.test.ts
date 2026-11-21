import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import {
  buildPreviewRevokeRequest,
  clearQueuedBanRevoke,
  drainPreviewRevokeQueue,
  PREVIEW_REVOKE_MAX_AGE_MS,
  revokePreviewSession,
  revokePreviewsForBannedUser,
} from '~/server/services/blocks/preview-revoke.service';

/**
 * App Assistant direct preview: the revoke civitai sends the sandbox service, and its retry
 * queue. The signature is pinned against literals computed by an independent implementation
 * (Python hmac/hashlib) of the canonical scheme the sandbox service verifies; the queue runs in
 * the real Lua harness, so "queued", "kept" and "removed" are read back from Redis state.
 */

// TEST-ONLY secret and base URL.
const SECRET = 'test-only-preview-revoke-secret';
const BASE = 'https://sandbox.test';
const NOW_MS = 1795046400_000;
const USER = 4101;
const PID = '0123456789abcdeffedcba9876543210';
const QUEUE = `${REDIS_KEYS.BLOCKS.DEV_TUNNEL_USER}:preview-revoke-queue`;

let lua: LuaRedis;
let fetchMock: ReturnType<typeof vi.fn>;
const answer = (status: number) => fetchMock.mockResolvedValue(new Response('{}', { status }));
const sentBodies = () =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
/** Each logToAxiom payload, without its free-text message. */
const logged = () =>
  loggingMock.logToAxiom.mock.calls.map((c) => {
    const { message: _message, ...rest } = c[0] as Record<string, unknown>;
    return rest;
  });
const queued = () =>
  Object.fromEntries(
    Object.entries(lua.hash(QUEUE) ?? {}).map(([k, v]) => [k, JSON.parse(v) as unknown])
  );

beforeEach(() => {
  setEnv({ APP_ASSISTANT_SANDBOX_URL: BASE, PREVIEW_REVOKE_HMAC_SECRET: SECRET });
  lua = createLuaRedis(NOW_MS, { integerArgs: true });
  const r = redisMock.redis;
  r.eval.mockImplementation((script: string, opts: { keys: string[]; arguments: string[] }) =>
    lua.eval(script, opts)
  );
  r.hGetAll.mockImplementation(async (k: string) => lua.hash(k) ?? {});
  r.hDel.mockImplementation((k: string, f: string) =>
    lua.eval("return redis.call('HDEL', KEYS[1], ARGV[1])", { keys: [k], arguments: [f] })
  );
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('the signed revoke request (wire contract)', () => {
  it('a "*" revoke: exact body bytes, timestamp in seconds, and the independently computed signature', () => {
    const req = buildPreviewRevokeRequest(
      { userId: USER, previewId: '*', issuedAt: 1795046520000, reason: 'ban' },
      SECRET,
      NOW_MS
    );
    expect(req.body).toBe(
      '{"userId":4101,"previewId":"*","issuedAt":1795046520000,"reason":"ban"}'
    );
    expect(req.headers['x-preview-revoke-timestamp']).toBe('1795046400');
    expect(req.headers['x-preview-revoke-signature']).toBe(
      'v1=7d6102549f198f59ad8870c1f66e8c64e1077e58f1cb038a3bf41e9cfe8c9de7'
    );
  });

  it('a per-session revoke carries no issuedAt', () => {
    const req = buildPreviewRevokeRequest(
      { userId: USER, previewId: PID, issuedAt: 1, reason: 'teardown:stop' },
      SECRET,
      NOW_MS
    );
    expect(req.body).toBe(`{"userId":4101,"previewId":"${PID}","reason":"teardown:stop"}`);
    expect(req.headers['x-preview-revoke-signature']).toBe(
      'v1=d19c49b1cd2f4672c820f7ae0cb78c45cbaa90b016dece023fb9518eefcb7c92'
    );
  });
});

describe('delivery: once inline, then the queue', () => {
  it('a 200 is sent and leaves nothing queued; the request goes to the revoke path', async () => {
    answer(200);
    expect(await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS)).toBe(
      'sent'
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/internal/v1/previews/revoke`);
    expect(queued()).toEqual({});
  });

  it.each([404, 503, 401, 409, 502])(
    'a %i is retryable: queued unsigned under its user and id',
    async (status) => {
      answer(status);
      expect(
        await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS)
      ).toBe('retry');
      expect(queued()).toEqual({
        [`${USER}:${PID}`]: { userId: USER, previewId: PID, reason: 'r', queuedAt: NOW_MS },
      });
    }
  );

  it('a network failure, or no secret configured, queues too (a configuration gap never loses one)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS);
    setEnv({ PREVIEW_REVOKE_HMAC_SECRET: undefined });
    await revokePreviewsForBannedUser(USER + 1, NOW_MS);
    expect(Object.keys(queued()).sort()).toEqual([`${USER}:${PID}`, `${USER + 1}:*`]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 400 is dropped, not queued: the request itself is wrong and would be refused forever', async () => {
    answer(400);
    expect(await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS)).toBe(
      'drop'
    );
    expect(queued()).toEqual({});
  });

  it('a ban sends "*" with issuedAt = the first attempt + 120 s', async () => {
    answer(200);
    await revokePreviewsForBannedUser(USER, NOW_MS);
    expect(sentBodies()).toEqual([
      { userId: USER, previewId: '*', issuedAt: NOW_MS + 120_000, reason: 'ban' },
    ]);
  });
});

describe('the reaper drains the queue', () => {
  it('a queued "*" is signed when it is SENT and keeps its first issuedAt', async () => {
    answer(503);
    await revokePreviewsForBannedUser(USER, NOW_MS);
    fetchMock.mockClear();
    answer(200);
    const later = NOW_MS + 600_000; // well past the 300 s signature window of the first attempt
    expect(await drainPreviewRevokeQueue(later)).toEqual({
      sent: 1,
      dropped: 0,
      retrying: 0,
      lastStatus: 200,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(JSON.parse(String(init.body))).toEqual({
      userId: USER,
      previewId: '*',
      issuedAt: NOW_MS + 120_000,
      reason: 'ban',
    });
    expect(init.headers['x-preview-revoke-timestamp']).toBe(String(later / 1000));
    expect(init.headers['x-preview-revoke-signature']).toBe(
      buildPreviewRevokeRequest(
        { userId: USER, previewId: '*', issuedAt: NOW_MS + 120_000, reason: 'ban' },
        SECRET,
        later
      ).headers['x-preview-revoke-signature']
    );
    expect(queued()).toEqual({});
  });

  it('a gateway 404 keeps it queued (direct preview switched off at the gateway), then it goes', async () => {
    answer(404);
    await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS);
    expect(await drainPreviewRevokeQueue(NOW_MS + 1000)).toEqual({
      sent: 0,
      dropped: 0,
      retrying: 1,
      lastStatus: 404,
    });
    expect(Object.keys(queued())).toEqual([`${USER}:${PID}`]);
    answer(200);
    expect((await drainPreviewRevokeQueue(NOW_MS + 2000)).sent).toBe(1);
    expect(queued()).toEqual({});
  });

  it('one older than the 8 h cap is dropped unsent, and the drop is logged', async () => {
    answer(503);
    await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS);
    fetchMock.mockClear();
    loggingMock.logToAxiom.mockClear();
    expect(await drainPreviewRevokeQueue(NOW_MS + PREVIEW_REVOKE_MAX_AGE_MS + 1)).toEqual({
      sent: 0,
      dropped: 1,
      retrying: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queued()).toEqual({});
    expect(logged()).toEqual([
      {
        type: 'app-assistant.preview-revoke.expired',
        userId: USER,
        reason: 'r',
        payload: { ageMs: PREVIEW_REVOKE_MAX_AGE_MS + 1 },
      },
    ]);
  });
});

describe('a failed revoke is visible in the logs', () => {
  beforeEach(() => loggingMock.logToAxiom.mockClear());

  it('a retried 503, 401 or network failure is logged with its status, never the signature', async () => {
    answer(503);
    await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS);
    answer(401);
    await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await revokePreviewsForBannedUser(USER, NOW_MS);
    expect(logged()).toEqual([
      { type: 'app-assistant.preview-revoke.retry', userId: USER, status: 503, reason: 'r' },
      { type: 'app-assistant.preview-revoke.retry', userId: USER, status: 401, reason: 'r' },
      {
        type: 'app-assistant.preview-revoke.retry',
        userId: USER,
        status: 'network',
        reason: 'ban',
      },
    ]);
    const everything = JSON.stringify(loggingMock.logToAxiom.mock.calls);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('v1=');
  });

  it('a 404 (the gateway rolled back) stays quiet, inline and in the drain', async () => {
    answer(404);
    await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS);
    await drainPreviewRevokeQueue(NOW_MS + 1000);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});

describe('unban', () => {
  it('clears a queued "*" for that user and leaves everything else queued', async () => {
    answer(503);
    await revokePreviewsForBannedUser(USER, NOW_MS);
    await revokePreviewsForBannedUser(USER + 1, NOW_MS);
    await revokePreviewSession({ userId: USER, previewId: PID, reason: 'r' }, NOW_MS);
    fetchMock.mockClear();
    await clearQueuedBanRevoke(USER);
    expect(Object.keys(queued()).sort()).toEqual([`${USER}:${PID}`, `${USER + 1}:*`]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
