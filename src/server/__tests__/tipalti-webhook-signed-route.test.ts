import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver';

import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FliptClient from '~/server/flipt/client';
import type * as KyselyDb from '~/server/db/kyselyDb';
import { PGlite } from '@electric-sql/pglite';
import type * as UserPaymentConfigurationService from '~/server/services/user-payment-configuration.service';
import type * as CreatorProgramService from '~/server/services/creator-program.service';

const SECRET = 'test-webhook-secret';

const { updateByTipaltiAccount, updateCashWithdrawal, bust } = vi.hoisted(() => ({
  updateCashWithdrawal: vi.fn(async () => undefined),
  updateByTipaltiAccount: vi.fn(async () => ({ userId: 7 })),
  bust: vi.fn(async () => undefined),
}));

const { isFlipt, h } = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => false),
  // A Postgres without the IdempotencyKey table: the claim store is unavailable when the flag is on.
  h: { pg: null as unknown as PGlite },
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/db/kyselyDb', async (importOriginal) => {
  const { pgliteKysely } = await import('~/__tests__/pglite-kysely');
  return { ...(await importOriginal<typeof KyselyDb>()), kyselyWrite: pgliteKysely(() => h.pg) };
});
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));
vi.mock('~/server/clickhouse/client', () => ({
  trackWebhookEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/services/user-payment-configuration.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPaymentConfigurationService>()),
  updateByTipaltiAccount,
}));
vi.mock('~/server/services/creator-program.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorProgramService>()),
  userCashCache: { bust },
  updateCashWithdrawal,
}));

const routeModule = await import('~/pages/api/webhooks/tipalti');
const { default: tipaltiCaller, TipaltiCaller } = await import(
  '~/server/http/tipalti/tipalti.caller'
);

// Tipalti signs `${t}-${rawBody}` with HMAC-SHA256 and sends `t=<unix seconds>,v=<hex>`.
const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
  `t=${t},v=${createHmac('sha256', secret).update(`${t}-${body}`).digest('hex')}`;

const body = JSON.stringify({
  id: 'evt-1',
  type: 'payeeDetailsChanged',
  createdDate: new Date().toISOString(),
  isTest: true,
  version: '1',
  traceId: 'trace-1',
  eventData: { payeeId: '7', status: 'Active', isPayable: true, paymentMethod: 'PayPal' },
});

// The route runs through Next's own API resolver, so `config.api.bodyParser: false` is honoured
// and the handler reads the raw request stream, as it does when deployed.
// Token requests (paymentError's payment lookup, the cache case) go to a local stand-in, so
// nothing here reaches Tipalti.
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const route = createServer((req, res) => {
  void apiResolver(req, res, {}, routeModule, {} as never, false);
});
let tokenEndpointUp = true;
let tokenRequests = 0;
const tokenEndpoint = createServer((_req, res) => {
  tokenRequests++;
  res.setHeader('Content-Type', 'application/json');
  if (!tokenEndpointUp) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_grant' }));
    return;
  }
  res.end(JSON.stringify({ access_token: 'access', expires_in: 3600 }));
});
// Stands in for the Tipalti API with every token rejected.
const rejectingApi = createServer((_req, res) => {
  res.statusCode = 401;
  res.end();
});
let url: string;
let tokenUrl: string;
let rejectingApiUrl: string;
beforeAll(async () => {
  h.pg = new PGlite();
  url = `${await listen(route)}/api/webhooks/tipalti`;
  tokenUrl = `${await listen(tokenEndpoint)}/token`;
  rejectingApiUrl = await listen(rejectingApi);
});
afterAll(async () => {
  await h.pg?.close();
  await Promise.all(
    [route, tokenEndpoint, rejectingApi].map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve()))
    )
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  tokenEndpointUp = true;
  tokenRequests = 0;
  // The access token is held on the class; start each case without one.
  (TipaltiCaller as unknown as { acessToken?: unknown }).acessToken = undefined;
  isFlipt.mockResolvedValue(false);
  // The idempotency keys' sysRedis, as a key/value store whose expiry follows Date.now().
  const sys = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = sys.get(key);
    if (entry && entry.expiresAt <= Date.now()) sys.delete(key);
    return sys.get(key);
  };
  redisMock.sysRedis.set.mockReset().mockImplementation((async (
    key: string,
    value: string,
    opts?: { NX?: boolean; EX?: number }
  ) => {
    if (opts?.NX && live(key)) return null;
    sys.set(key, { value, expiresAt: Date.now() + (opts?.EX ?? 86_400) * 1000 });
    return 'OK';
  }) as never);
  redisMock.sysRedis.get
    .mockReset()
    .mockImplementation((async (key: string) => live(key)?.value ?? null) as never);
  redisMock.sysRedis.del
    .mockReset()
    .mockImplementation((async (key: string) => (sys.delete(key) ? 1 : 0)) as never);
  setEnv({
    TIPALTI_WEBTOKEN_SECRET: SECRET,
    TIPALTI_API_URL: 'http://127.0.0.1:9',
    TIPALTI_API_TOKEN_URL: tokenUrl,
    TIPALTI_API_CLIENT_ID: 'id',
    TIPALTI_API_SECRET: 'secret',
    TIPALTI_API_REFRESH_TOKEN: 'refresh',
    TIPALTI_API_CODE_VERIFIER: 'verifier',
  });
});

const post = (signature: string | undefined, payload = body) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature ? { 'Tipalti-Signature': signature } : {}),
    },
    body: payload,
  });

describe('POST /api/webhooks/tipalti with a signed event', () => {
  it('accepts a correctly signed event and records it', async () => {
    const res = await post(sign(body));

    expect(res.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, tipaltiAccountStatus: 'Active' })
    );
  });

  // An API token problem must not turn a genuine event into a 400 that Tipalti counts as failed.
  it('accepts a correctly signed event while the API token cannot be fetched', async () => {
    tokenEndpointUp = false;

    const res = await post(sign(body));

    expect(res.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
  });

  it('records a signed payout outcome while the API token cannot be fetched', async () => {
    tokenEndpointUp = false;
    const refCode = 'CW7_abc123';
    dbMock.dbWrite.cashWithdrawal.findMany.mockResolvedValue([
      { id: 'abc123-full', userId: 7, status: 'Cleared', metadata: { paymentRefCode: refCode } },
    ]);
    const payout = JSON.stringify({
      id: 'evt-2',
      type: 'paymentCompleted',
      createdDate: new Date().toISOString(),
      isTest: true,
      version: '1',
      traceId: 'trace-2',
      eventData: { refCode, paymentStatus: 'Paid' },
    });

    const res = await post(sign(payout), payout);

    expect(res.status).toBe(200);
    expect(updateCashWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawalId: 'abc123-full', status: 'Paid' })
    );
  });

  it('rejects a signature made with the wrong secret', async () => {
    const res = await post(sign(body, undefined, 'not-the-secret'));

    expect(res.status).toBe(400);
    expect(updateByTipaltiAccount).not.toHaveBeenCalled();
  });

  it('rejects a body that differs from the one signed', async () => {
    const res = await post(sign(body), body.replace('"Active"', '"Blocked"'));

    expect(res.status).toBe(400);
    expect(updateByTipaltiAccount).not.toHaveBeenCalled();
  });

  it('rejects a missing signature', async () => {
    const res = await post(undefined);

    expect(res.status).toBe(400);
    expect(updateByTipaltiAccount).not.toHaveBeenCalled();
  });

  it('rejects a signature older than five minutes', async () => {
    const res = await post(sign(body, Math.floor(Date.now() / 1000) - 6 * 60));

    expect(res.status).toBe(400);
    expect(updateByTipaltiAccount).not.toHaveBeenCalled();
  });

  it.each(['not-a-time', `${Math.floor(Date.now() / 1000)}abc`, ''])(
    'rejects a non-numeric timestamp %j',
    async (t) => {
      const v = createHmac('sha256', SECRET).update(`${t}-${body}`).digest('hex');

      const res = await post(`t=${t},v=${v}`);

      expect(res.status).toBe(400);
      expect(updateByTipaltiAccount).not.toHaveBeenCalled();
    }
  );

  it('rejects a timestamp more than a minute in the future', async () => {
    const res = await post(sign(body, Math.floor(Date.now() / 1000) + 90));

    expect(res.status).toBe(400);
    expect(updateByTipaltiAccount).not.toHaveBeenCalled();
  });

  it('accepts a timestamp slightly ahead of our clock', async () => {
    const res = await post(sign(body, Math.floor(Date.now() / 1000) + 30));

    expect(res.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/webhooks/tipalti delivered more than once', () => {
  const withId = (id: string) => body.replace('"evt-1"', JSON.stringify(id));

  it('processes an event once when the same event id arrives twice', async () => {
    const first = await post(sign(body));
    const second = await post(sign(body));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
  });

  it('still treats a copy as a duplicate late in its signature lifetime', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      // Signed at the furthest accepted clock skew, so it stays valid the longest.
      const signature = sign(body, Math.floor(start / 1000) + 60);
      await post(signature);
      now.mockReturnValue(start + 355_000);
      const copy = await post(signature);

      expect(copy.status).toBe(200);
      expect(await copy.json()).toMatchObject({ duplicate: true });
      expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('treats a copy Tipalti signs again after the signature lifetime as a duplicate', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await post(sign(body));
      now.mockReturnValue(start + 60 * 60 * 1000);
      const resent = await post(sign(body, Math.floor((start + 60 * 60 * 1000) / 1000)));

      expect(resent.status).toBe(200);
      expect(await resent.json()).toMatchObject({ duplicate: true });
      expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('processes events with different ids', async () => {
    await post(sign(withId('evt-a')), withId('evt-a'));
    await post(sign(withId('evt-b')), withId('evt-b'));

    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(2);
  });

  it('processes a redelivery of an event whose first delivery failed', async () => {
    updateByTipaltiAccount.mockRejectedValueOnce(new Error('db down'));

    const first = await post(sign(body));
    const second = await post(sign(body));

    expect(first.status).toBe(400);
    expect(second.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(2);
  });

  it('asks for a retry of a copy that arrives while the first is processing, and processes it once the first fails', async () => {
    let failFirst!: (error: Error) => void;
    updateByTipaltiAccount.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failFirst = reject))
    );

    const first = post(sign(body));
    await vi.waitFor(() => expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1));
    const during = await post(sign(body));
    failFirst(new Error('db down'));
    const retried = await post(sign((await first, body)));

    expect(during.status).toBe(409);
    expect((await first).status).toBe(400);
    expect(retried.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(2);
  });

  it('processes an event once, and logs it, while the dedupe store is unavailable', async () => {
    redisMock.sysRedis.set.mockRejectedValue(new Error('redis down'));

    const res = await post(sign(body));

    expect(res.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'tipalti-webhook-dedupe-unavailable',
        payload: { eventId: 'evt-1' },
      }),
      'webhooks'
    );
  });

  it('processes an event once while the Postgres dedupe store is unavailable', async () => {
    isFlipt.mockResolvedValue(true);

    const res = await post(sign(body));

    expect(res.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'tipalti-webhook-dedupe-unavailable',
        message: expect.stringContaining('idempotency keys'),
      }),
      'webhooks'
    );
  });

  it('processes a signed event after an invalid request carrying the same id', async () => {
    await post(sign(body, undefined, 'not-the-secret'));
    await post(sign(body, Math.floor(Date.now() / 1000) + 5 * 60));
    const res = await post(sign(body));

    expect(res.status).toBe(200);
    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
  });
});

describe('Tipalti API access token', () => {
  // expires_in is in seconds.
  it('reuses the token for later calls within its lifetime', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await tipaltiCaller();
      now.mockReturnValue(start + 60_000);
      await tipaltiCaller();
      expect(tokenRequests).toBe(1);

      now.mockReturnValue(start + 3601_000);
      await tipaltiCaller();
      expect(tokenRequests).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('fetches a new token after the API rejects the current one', async () => {
    setEnv({ TIPALTI_API_URL: rejectingApiUrl });

    const caller = await tipaltiCaller();
    await caller.getPayeeByRefCode('7');
    await tipaltiCaller();

    expect(tokenRequests).toBe(2);
  });
});
