import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { AdminTokenEndpoint, WebhookEndpoint } = await import('~/server/utils/endpoint-helpers');
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
const RESET = 'r'.repeat(40);
const PROBE = 'b'.repeat(40);
const JOB = 'j'.repeat(40);

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(
  handler: unknown,
  opts: {
    path: string;
    query?: Record<string, string>;
    bearer?: string;
    adminToken?: string;
    webhookHeader?: string;
    method?: string;
    body?: unknown;
  }
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
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    url: qs ? `${opts.path}?${qs}` : opts.path,
    query,
    body: opts.body,
    socket: { remoteAddress: '10.0.0.9' },
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'cf-ray': 'abc123-DFW',
      'user-agent': 'curl/8.4.0',
      ...(opts.bearer === undefined ? {} : { authorization: `Bearer ${opts.bearer}` }),
      ...(opts.adminToken === undefined ? {} : { 'x-admin-token': opts.adminToken }),
      ...(opts.webhookHeader === undefined ? {} : { 'x-webhook-token': opts.webhookHeader }),
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

// The refused-call cap is per process; each test starts in a fresh window.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.advanceTimersByTime(60_000);
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
    const path = '/api/admin/test-action';
    expect(await call(audited, { path, bearer: WRONG, query: { token: WRONG } })).toBe(401);

    const record = onlyAuditRecord();
    expect(record).toMatchObject({
      action: 'test-action',
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

  it('records the previous slot and the body', async () => {
    const path = '/api/admin/test-action';
    expect(await call(audited, { path, bearer: PREVIOUS, body: { userIds: [] } })).toBe(200);

    const record = onlyAuditRecord();
    expect(record).toMatchObject({
      action: 'test-action',
      slot: 'previous',
      presented: ['bearer'],
      outcome: 'accepted',
      status: 200,
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
    const path = '/api/admin/test-action';
    await call(audited, { path, bearer: CURRENT, body: `{"t":"${WRONG}"}` });
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

describe('session-reset routes', () => {
  const resetPath = '/api/admin/refresh-sessions';
  const userPath = '/api/admin/refresh-user-sessions';

  beforeEach(() => setEnv({ SESSION_RESET_TOKEN: RESET, PROBE_TOKEN: PROBE, JOB_TOKEN: JOB }));

  const resetAudited = AdminTokenEndpoint(
    'SESSION_RESET_TOKEN',
    async (_req, res) => {
      res.status(200).json({ ok: true });
    },
    { audit: 'reset-action' }
  );

  it('accepts SESSION_RESET_TOKEN in x-admin-token and records it without the value', async () => {
    const path = '/api/admin/reset-action';
    const body = { note: RESET, job: JOB, probe: PROBE };
    expect(await call(resetAudited, { path, adminToken: RESET, body })).toBe(200);
    const record = onlyAuditRecord();
    expect(record).toMatchObject({
      action: 'reset-action',
      slot: 'admin',
      presented: ['admin-header'],
      outcome: 'accepted',
      status: 200,
    });
    const serialized = JSON.stringify(record);
    for (const secret of [RESET, JOB, PROBE]) expect(serialized).not.toContain(secret);
  });

  it('refuses GET on refresh-user-sessions', async () => {
    expect(await call(refreshUserSessions, { path: userPath, adminToken: RESET })).toBe(405);
  });

  it('lets SESSION_RESET_TOKEN through to refresh-user-sessions', async () => {
    // An empty list is refused by the route's schema before any session is touched.
    const status = await call(refreshUserSessions, {
      path: userPath,
      adminToken: RESET,
      body: { userIds: [] },
    });
    expect(status).toBe(400);
    expect(onlyAuditRecord()).toMatchObject({
      action: 'refresh-user-sessions',
      slot: 'admin',
      outcome: 'accepted',
      status: 400,
    });
  });

  it.each([
    ['the current webhook token in x-admin-token', { adminToken: CURRENT }, 401],
    ['the previous webhook token in x-admin-token', { adminToken: PREVIOUS }, 401],
    ['the current webhook token as a bearer', { bearer: CURRENT }, 401],
    ['the previous webhook token as a bearer', { bearer: PREVIOUS }, 401],
    ['the webhook token in x-webhook-token', { webhookHeader: CURRENT }, 401],
    ['the probe token in x-admin-token', { adminToken: PROBE }, 401],
    ['the job token in x-admin-token', { adminToken: JOB }, 401],
    ['SESSION_RESET_TOKEN as a bearer', { bearer: RESET }, 401],
    ['SESSION_RESET_TOKEN in x-webhook-token', { webhookHeader: RESET }, 401],
    ['the webhook token in the query string', { query: { token: CURRENT } }, 400],
    ['SESSION_RESET_TOKEN in the query string', { query: { token: RESET } }, 400],
  ] as const)('refuses %s and records it', async (_name, opts, status) => {
    expect(await call(refreshSessions, { path: resetPath, ...opts })).toBe(status);
    const record = onlyAuditRecord();
    expect(record).toMatchObject({ slot: 'none', outcome: 'rejected', status });
    const serialized = JSON.stringify(record);
    for (const secret of [CURRENT, PREVIOUS, RESET, PROBE, JOB])
      expect(serialized).not.toContain(secret);
  });

  it.each([
    ['unset', undefined],
    ['equal to the current webhook token', CURRENT],
    ['equal to the previous webhook token', PREVIOUS],
    ['shorter than 32 characters', 'r'.repeat(31)],
    ['padded with whitespace', ` ${RESET}`],
    ['equal to the probe token', PROBE],
    ['equal to the job token', JOB],
    [
      'equal to another admin endpoint token',
      'k'.repeat(40),
      { SYSTEM_ACCOUNT_KEY_TOKEN: 'k'.repeat(40) },
    ],
    ['equal to another token but for a trailing newline', JOB, { JOB_TOKEN: `${JOB}\n` }],
  ] as [string, string | undefined, Record<string, string>?][])(
    'answers 404 while SESSION_RESET_TOKEN is %s, and records it',
    async (_name, value, extra) => {
      setEnv({ SESSION_RESET_TOKEN: value, ...extra });
      const presented = value ?? RESET;
      expect(await call(refreshSessions, { path: resetPath, adminToken: presented })).toBe(404);
      expect(
        await call(refreshUserSessions, {
          path: userPath,
          adminToken: presented,
          body: { userIds: [1] },
        })
      ).toBe(404);
      expect(auditRecords()).toMatchObject([
        { action: 'refresh-sessions', outcome: 'rejected', status: 404 },
        { action: 'refresh-user-sessions', outcome: 'rejected', status: 404 },
      ]);
    }
  );
});

describe('refused-call cap', () => {
  it('writes the first 20 refused calls in a minute, then one count when the minute ends', async () => {
    for (let i = 0; i < 25; i++)
      await call(audited, { path: '/api/admin/test-action', query: { token: WRONG } });
    expect(auditRecords()).toHaveLength(20);

    vi.advanceTimersByTime(60_000);
    const records = auditRecords();
    expect(records).toHaveLength(21);
    expect(records[20]).toMatchObject({
      summary: true,
      outcome: 'rejected',
      dropped: 5,
      byKey: { 'test-action': 5 },
      clientIps: ['203.0.113.7'],
    });
  });

  it('starts each minute with a full allowance, and writes no summary when nothing was dropped', async () => {
    for (let i = 0; i < 25; i++)
      await call(audited, { path: '/api/admin/test-action', query: { token: WRONG } });
    vi.advanceTimersByTime(60_000);
    logToAxiom.mockClear();

    for (let i = 0; i < 20; i++)
      await call(audited, { path: '/api/admin/test-action', query: { token: WRONG } });
    vi.advanceTimersByTime(60_000);
    const records = auditRecords();
    expect(records).toHaveLength(20);
    expect(records.some((record) => record.summary)).toBe(false);
  });

  it('never drops an accepted call', async () => {
    for (let i = 0; i < 25; i++)
      await call(audited, { path: '/api/admin/test-action', query: { token: CURRENT } });
    vi.advanceTimersByTime(60_000);
    const records = auditRecords();
    expect(records).toHaveLength(25);
    expect(records.every((record) => record.outcome === 'accepted')).toBe(true);
  });
});
