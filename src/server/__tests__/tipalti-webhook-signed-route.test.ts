import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver';

import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as UserPaymentConfigurationService from '~/server/services/user-payment-configuration.service';
import type * as CreatorProgramService from '~/server/services/creator-program.service';

const SECRET = 'test-webhook-secret';

const { updateByTipaltiAccount, updateCashWithdrawal, bust } = vi.hoisted(() => ({
  updateCashWithdrawal: vi.fn(async () => undefined),
  updateByTipaltiAccount: vi.fn(async () => ({ userId: 7 })),
  bust: vi.fn(async () => undefined),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
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
let url: string;
let tokenUrl: string;
beforeAll(async () => {
  url = `${await listen(route)}/api/webhooks/tipalti`;
  tokenUrl = `${await listen(tokenEndpoint)}/token`;
});
afterAll(async () => {
  await Promise.all(
    [route, tokenEndpoint].map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  tokenEndpointUp = true;
  tokenRequests = 0;
  // The access token is held on the class; start each case without one.
  (TipaltiCaller as unknown as { acessToken?: unknown }).acessToken = undefined;
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
});
