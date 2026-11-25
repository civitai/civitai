import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const logToAxiom = loggingMock.logToAxiom;

vi.mock('@civitai/next-axiom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withAxiom: (handler: unknown) => handler,
}));
vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  instrumentApiResponse: () => undefined,
}));

const { WebhookEndpoint } = await import('~/server/utils/endpoint-helpers');
const refreshSessions = (await import('~/server/api-routes/admin/refresh-sessions')).default;
const refreshUserSessions = (await import('~/server/api-routes/admin/refresh-user-sessions'))
  .default;

// The real routes are exercised only on paths that never reach their session writes.
const audited = WebhookEndpoint(
  async (_req, res) => {
    res.status(200).json({ ok: true });
  },
  { audit: 'test-action' }
);

const CURRENT = 'c'.repeat(40);
const PREVIOUS = 'p'.repeat(40);
const WRONG = 'w'.repeat(40);

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(
  handler: unknown,
  opts: { path: string; query?: Record<string, string>; bearer?: string; body?: unknown }
) {
  const res = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json: () => res,
  };
  const query = opts.query ?? {};
  const qs = new URLSearchParams(query).toString();
  const req = {
    method: opts.body === undefined ? 'GET' : 'POST',
    url: qs ? `${opts.path}?${qs}` : opts.path,
    query,
    body: opts.body,
    socket: { remoteAddress: '10.0.0.9' },
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'cf-ray': 'abc123-DFW',
      'user-agent': 'curl/8.4.0',
      ...(opts.bearer === undefined ? {} : { authorization: `Bearer ${opts.bearer}` }),
    },
  };
  await (handler as Handler)(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res.statusCode;
}

function auditRecords() {
  return logToAxiom.mock.calls
    .map(([record]) => record as { name?: string; payload: Record<string, unknown> })
    .filter((record) => record.name === 'admin-endpoint-audit')
    .map((record) => record.payload);
}

function onlyAuditRecord() {
  const records = auditRecords();
  expect(records).toHaveLength(1);
  return records[0];
}

beforeEach(() => {
  resetEnv();
  setEnv({ WEBHOOK_TOKEN: CURRENT, WEBHOOK_TOKEN_PREVIOUS: PREVIOUS });
  logToAxiom.mockClear();
});

describe('admin endpoint audit record', () => {
  it('records an accepted call with its caller, slot and outcome', async () => {
    const path = '/api/admin/test-action';
    expect(await call(audited, { path, query: { token: CURRENT, note: 'x' } })).toBe(200);

    const record = onlyAuditRecord();
    expect(record).toMatchObject({
      action: 'test-action',
      route: `GET ${path}`,
      method: 'GET',
      slot: 'current',
      presented: ['query'],
      outcome: 'accepted',
      status: 200,
      clientIp: '203.0.113.7',
      cfConnectingIp: '203.0.113.7',
      cfRay: 'abc123-DFW',
      userAgent: 'curl/8.4.0',
      socketIp: '10.0.0.9',
    });
    expect(JSON.parse(record.params as string)).toEqual({ query: { note: 'x' } });
    expect(JSON.stringify(record)).not.toContain(CURRENT);
  });

  it('records a rejected token without the presented value or any configured one', async () => {
    const path = '/api/admin/refresh-sessions';
    expect(await call(refreshSessions, { path, bearer: WRONG, query: { token: WRONG } })).toBe(401);

    const record = onlyAuditRecord();
    expect(record).toMatchObject({
      action: 'refresh-sessions',
      slot: 'none',
      presented: ['bearer', 'query'],
      outcome: 'rejected',
      status: 401,
      clientIp: '203.0.113.7',
      userAgent: 'curl/8.4.0',
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(WRONG);
    expect(serialized).not.toContain(CURRENT);
    expect(serialized).not.toContain(PREVIOUS);
  });

  it('records the previous slot and the body of refresh-user-sessions', async () => {
    const path = '/api/admin/refresh-user-sessions';
    // An empty list is refused by the route's schema before any session is touched.
    expect(await call(refreshUserSessions, { path, bearer: PREVIOUS, body: { userIds: [] } })).toBe(
      400
    );

    const record = onlyAuditRecord();
    expect(record).toMatchObject({
      action: 'refresh-user-sessions',
      slot: 'previous',
      presented: ['bearer'],
      outcome: 'accepted',
      status: 400,
    });
    expect(JSON.parse(record.params as string)).toEqual({ query: {}, body: { userIds: [] } });
    expect(JSON.stringify(record)).not.toContain(PREVIOUS);
  });

  it('strips a configured token sent under another parameter name', async () => {
    await call(audited, { path: '/api/admin/test-action', query: { token: CURRENT, t: PREVIOUS } });
    const serialized = JSON.stringify(onlyAuditRecord());
    expect(serialized).not.toContain(PREVIOUS);
    expect(serialized).not.toContain(CURRENT);
  });

  it('caps caller-sized params, keeps the true length, and does not trust a bare cf-connecting-ip', async () => {
    const path = '/api/admin/test-action';
    const padding = 'a'.repeat(100_000);
    await call(audited, { path, query: { token: CURRENT }, body: { padding } });
    const record = onlyAuditRecord();
    expect((record.params as string).length).toBe(2000);
    expect(record.paramsChars).toBeGreaterThan(100_000);
    // The test request carries cf-ray, so the edge address is trusted; without it, the socket peer.
    logToAxiom.mockClear();
    const res = { statusCode: 200, status: () => res, json: () => res };
    await (audited as unknown as Handler)(
      {
        method: 'GET',
        url: `${path}?token=${CURRENT}`,
        query: { token: CURRENT },
        headers: { 'cf-connecting-ip': '198.51.100.1' },
        socket: { remoteAddress: '10.0.0.9' },
      } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    expect(onlyAuditRecord()).toMatchObject({
      clientIp: '10.0.0.9',
      cfConnectingIp: '198.51.100.1',
    });
  });

  it('leaves no fragment of a configured token that straddles the cap', async () => {
    // `{"query":{},"body":{"padding":"` + padding + `","t":"` puts the token at index 1991,
    // so a cut alone would keep 9 of its chars.
    const padding = 'a'.repeat(1953);
    await call(audited, {
      path: '/api/admin/test-action',
      bearer: CURRENT,
      body: { padding, t: PREVIOUS },
    });
    expect(JSON.stringify(onlyAuditRecord())).not.toContain('pppppp');
  });

  it('blanks an unconfigured token under any credential-named or nested key', async () => {
    await call(audited, {
      path: '/api/admin/test-action',
      query: { token: CURRENT, Token: WRONG, webhook_token: WRONG },
      body: { userIds: [1], data: { token: WRONG }, password: WRONG },
    });
    expect(JSON.stringify(onlyAuditRecord())).not.toContain(WRONG);
  });

  it('keeps the sent status when a handler throws after responding', async () => {
    const late = WebhookEndpoint(
      async (_req, res) => {
        res.status(200).json({ ok: true });
        (res as unknown as { headersSent: boolean }).headersSent = true;
        throw new Error('after');
      },
      { audit: 'late' }
    );
    await expect(
      call(late, { path: '/api/admin/late', query: { token: CURRENT } })
    ).rejects.toThrow('after');
    expect(onlyAuditRecord()).toMatchObject({ outcome: 'error', status: 200 });
  });

  it('records a raw text body by type and length only', async () => {
    const path = '/api/admin/refresh-user-sessions';
    await call(refreshUserSessions, { path, bearer: CURRENT, body: `{"t":"${WRONG}"}` });
    const record = onlyAuditRecord();
    expect(JSON.parse(record.params as string).body).toEqual({ unparsed: 'string', length: 48 });
    expect(JSON.stringify(record)).not.toContain(WRONG);
  });

  it('records a handler that throws as an error, and still throws', async () => {
    const failing = WebhookEndpoint(
      async () => {
        throw new Error('boom');
      },
      { audit: 'failing' }
    );
    await expect(
      call(failing, { path: '/api/admin/failing', query: { token: CURRENT } })
    ).rejects.toThrow('boom');
    expect(onlyAuditRecord()).toMatchObject({ action: 'failing', outcome: 'error', status: 500 });
  });

  it('writes nothing for a webhook endpoint that did not opt in', async () => {
    const plain = WebhookEndpoint(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    await call(plain, { path: '/api/webhooks/plain', query: { token: CURRENT } });
    await call(plain, { path: '/api/webhooks/plain', query: { token: WRONG } });
    expect(auditRecords()).toHaveLength(0);
  });
});
