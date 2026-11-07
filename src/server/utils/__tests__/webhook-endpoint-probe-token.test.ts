import fs from 'node:fs';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

vi.mock('@civitai/next-axiom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withAxiom: (handler: unknown) => handler,
}));
vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  instrumentApiResponse: () => undefined,
}));

const { WebhookEndpoint } = await import('~/server/utils/endpoint-helpers');
const { webhookTokenMatchCounter } = await import('~/server/prom/webhook-token.metrics');

const CURRENT = 'c'.repeat(40);
const PROBE = 'r'.repeat(40);

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

async function call(endpoint: Handler, path: string, auth: { query?: string; bearer?: string }) {
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json: () => res,
  } as unknown as NextApiResponse;
  const req = {
    method: 'GET',
    url: auth.query === undefined ? path : `${path}?token=${auth.query}`,
    query: auth.query === undefined ? {} : { token: auth.query },
    headers: auth.bearer === undefined ? {} : { authorization: `Bearer ${auth.bearer}` },
  };
  await endpoint(req as unknown as NextApiRequest, res);
  return status;
}

async function probeMatches(path: string) {
  const { values } = await webhookTokenMatchCounter.get();
  return (
    values.find((v) => v.labels.slot === 'probe' && v.labels.route === `GET ${path}`)?.value ?? 0
  );
}

const ok = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
  res.status(200).json({});
});
const healthRoute = WebhookEndpoint(ok, { acceptProbeToken: true }) as unknown as Handler;
const otherRoute = WebhookEndpoint(ok) as unknown as Handler;

beforeEach(() => {
  resetEnv();
  setEnv({ WEBHOOK_TOKEN: CURRENT, PROBE_TOKEN: PROBE });
  ok.mockClear();
});

describe('PROBE_TOKEN', () => {
  it('opens an endpoint that accepts it, by query or Bearer, and counts slot probe', async () => {
    const path = '/api/probe-count';
    expect(await call(healthRoute, path, { query: PROBE })).toBe(200);
    expect(await call(healthRoute, path, { bearer: PROBE })).toBe(200);
    expect(await call(healthRoute, path, { query: CURRENT })).toBe(200);
    expect(await probeMatches(path)).toBe(2);
  });

  it('is refused by a webhook endpoint that does not accept it', async () => {
    expect(await call(otherRoute, '/api/webhooks/other', { query: PROBE })).toBe(401);
    expect(await call(otherRoute, '/api/webhooks/other', { bearer: PROBE })).toBe(401);
    expect(await call(otherRoute, '/api/webhooks/other', { query: CURRENT })).toBe(200);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('matches nothing while blank or unset', async () => {
    for (const blank of ['', '   ', undefined]) {
      setEnv({ PROBE_TOKEN: blank });
      expect(await call(healthRoute, '/api/probe-blank', { query: blank ?? '' })).toBe(401);
      expect(await call(healthRoute, '/api/probe-blank', { bearer: blank ?? '' })).toBe(401);
      expect(await call(healthRoute, '/api/probe-blank', { query: PROBE })).toBe(401);
    }
    expect(ok).not.toHaveBeenCalled();
  });
});

// Probe manifests carry PROBE_TOKEN as a literal, so it must open the health routes and nothing else.
it('only /api/live, /api/ready and /api/health accept PROBE_TOKEN', () => {
  const root = path.join(process.cwd(), 'src/pages/api');
  const accepting = (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => fs.readFileSync(path.join(root, f), 'utf8').includes('acceptProbeToken: true'))
    .map((f) => f.split(path.sep).join('/'))
    .sort();
  expect(accepting).toEqual(['health.ts', 'live.ts', 'ready.ts']);
});
