import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

// The real ProbeEndpoint wraps the real /api/metrics handler here, so a scrape is authorized the way
// Prometheus's is.
const poolStub = () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 });
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: poolStub(),
  pgDbWrite: poolStub(),
  pgDbReadLong: poolStub(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: poolStub() }));

const { webhookTokenMatchCounter } = await import('~/server/prom/webhook-token.metrics');

const CURRENT = 'c'.repeat(40);
const PROBE = 'r'.repeat(40);
type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

async function scrape(bearer: string, query?: string) {
  const state = { status: 200, body: undefined as string | undefined };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json: () => res,
    setHeader: () => res,
    send(body: string) {
      state.body = body;
    },
  } as unknown as NextApiResponse;
  const req = {
    method: 'GET',
    url: query === undefined ? '/api/metrics' : `/api/metrics?token=${query}`,
    query: query === undefined ? {} : { token: query },
    headers: { authorization: `Bearer ${bearer}`, 'user-agent': 'Prometheus/3.1.0' },
  };
  const handler = (await import('~/pages/api/metrics')).default as unknown as Handler;
  await handler(req as unknown as NextApiRequest, res);
  return state;
}

async function matches(slot: string) {
  const { values } = await webhookTokenMatchCounter.get();
  return (
    values.find(
      (v) =>
        v.labels.slot === slot &&
        v.labels.route === 'GET /api/metrics' &&
        v.labels.caller === 'prometheus'
    )?.value ?? 0
  );
}

beforeEach(() => {
  resetEnv();
  setEnv({ WEBHOOK_TOKEN: CURRENT, PROBE_TOKEN: PROBE });
  dbMock.dbRead.$metrics.prometheus.mockResolvedValue('');
  dbMock.dbWrite.$metrics.prometheus.mockResolvedValue('');
});

describe('/api/metrics', () => {
  it('serves a scrape that sends PROBE_TOKEN as Bearer, counted as slot probe', async () => {
    const before = await matches('probe');
    const { status, body } = await scrape(PROBE);
    expect(status).toBe(200);
    expect(body).toMatch(/process_cpu_user_seconds_total|nodejs_/);
    expect((await matches('probe')) - before).toBe(1);
  });

  it('still serves a scrape that sends the webhook token, counted as slot current', async () => {
    const before = await matches('current');
    expect((await scrape(CURRENT)).status).toBe(200);
    expect((await matches('current')) - before).toBe(1);
  });

  it('refuses a wrong token', async () => {
    const { status, body } = await scrape('x'.repeat(PROBE.length));
    expect(status).toBe(401);
    expect(body).toBeUndefined();
  });

  it('refuses the probe value while PROBE_TOKEN is unset or blank', async () => {
    for (const blank of [undefined, '', '   ']) {
      setEnv({ PROBE_TOKEN: blank });
      expect((await scrape(PROBE)).status).toBe(401);
      expect((await scrape(blank ?? '')).status).toBe(401);
      expect((await scrape('x'.repeat(PROBE.length), blank ?? '')).status).toBe(401);
    }
  });
});
