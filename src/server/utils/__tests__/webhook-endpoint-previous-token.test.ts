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
const { webhookTokenMatchCounter, CALLER_FAMILIES } = await import(
  '~/server/prom/webhook-token.metrics'
);
const { webhookTokenValues } = await import('~/server/utils/webhook-token');

const CURRENT = 'c'.repeat(40);
const PREVIOUS = 'p'.repeat(40);

const inner = vi.fn(async () => undefined);
const endpoint = WebhookEndpoint(inner) as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

// Each test uses its own path so its counter series and its log throttle start empty.
async function call(path: string, auth: { query?: string; bearer?: string }, userAgent?: string) {
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json: () => res,
  } as unknown as NextApiResponse;
  const query = auth.query === undefined ? {} : { token: auth.query };
  const req = {
    method: 'POST',
    url: auth.query === undefined ? path : `${path}?token=${auth.query}`,
    query,
    headers: {
      ...(auth.bearer === undefined ? {} : { authorization: `Bearer ${auth.bearer}` }),
      ...(userAgent === undefined ? {} : { 'user-agent': userAgent }),
    },
  };
  await endpoint(req as unknown as NextApiRequest, res);
  return status;
}

async function matches(path: string, slot: 'current' | 'previous') {
  const { values } = await webhookTokenMatchCounter.get();
  return (
    values.find((v) => v.labels.slot === slot && v.labels.route === `POST ${path}`)?.value ?? 0
  );
}

beforeEach(() => {
  resetEnv();
  setEnv({ WEBHOOK_TOKEN: CURRENT, WEBHOOK_TOKEN_PREVIOUS: PREVIOUS });
  inner.mockClear();
  logToAxiom.mockClear();
});

describe('WebhookEndpoint with WEBHOOK_TOKEN_PREVIOUS', () => {
  it('accepts the current and the previous value, by query or Bearer, and counts each slot', async () => {
    const path = '/api/webhooks/slot-count';
    expect(await call(path, { query: CURRENT })).toBe(200);
    expect(await call(path, { bearer: PREVIOUS })).toBe(200);
    expect(await call(path, { query: PREVIOUS })).toBe(200);
    expect(inner).toHaveBeenCalledTimes(3);

    expect(await matches(path, 'current')).toBe(1);
    expect(await matches(path, 'previous')).toBe(2);
  });

  it('refuses a value that is neither, and counts nothing', async () => {
    const path = '/api/webhooks/wrong-value';
    expect(await call(path, { query: 'x'.repeat(40) })).toBe(401);
    expect(await call(path, { bearer: 'x'.repeat(40) })).toBe(401);
    expect(inner).not.toHaveBeenCalled();
    expect(await matches(path, 'current')).toBe(0);
    expect(await matches(path, 'previous')).toBe(0);
  });

  it('with PREVIOUS unset, refuses the old value exactly as before', async () => {
    setEnv({ WEBHOOK_TOKEN_PREVIOUS: undefined });
    expect(await call('/api/webhooks/unset', { query: PREVIOUS })).toBe(401);
    expect(await call('/api/webhooks/unset', { query: CURRENT })).toBe(200);
  });

  it('a blank PREVIOUS matches nothing, not an empty token', async () => {
    for (const blank of ['', '   ']) {
      setEnv({ WEBHOOK_TOKEN_PREVIOUS: blank });
      expect(await call('/api/webhooks/blank', { query: blank })).toBe(401);
      expect(await call('/api/webhooks/blank', { bearer: blank })).toBe(401);
    }
    expect(inner).not.toHaveBeenCalled();
  });

  it('PREVIOUS alone does not configure the endpoint', async () => {
    setEnv({ WEBHOOK_TOKEN: '' });
    expect(await call('/api/webhooks/unconfigured', { query: PREVIOUS })).toBe(503);
    expect(inner).not.toHaveBeenCalled();
  });

  it('logs a previous-value match with its slot and route, at most once a minute per route, never the value', async () => {
    const path = '/api/webhooks/previous-log';
    await call(path, { query: PREVIOUS });
    await call(path, { query: PREVIOUS });
    await call(path, { query: CURRENT });

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    const [line] = logToAxiom.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(line).toMatchObject({ slot: 'previous', route: `POST ${path}` });
    expect(JSON.stringify(line)).not.toContain(PREVIOUS);
  });
});

describe('caller label', () => {
  async function series(path: string) {
    const { values } = await webhookTokenMatchCounter.get();
    return values.filter((v) => v.labels.route === `POST ${path}`);
  }

  it.each([
    ['kube-probe/1.31', 'kube-probe'],
    ['Prometheus/3.1.0', 'prometheus'],
    ['node-fetch/1.0 (+https://github.com/bitinn/node-fetch)', 'node'],
    ['undici', 'node'],
    ['node', 'node'],
    ['axios/1.7.9', 'node'],
    ['got (https://github.com/sindresorhus/got)', 'node'],
    ['python-requests/2.32.3', 'python'],
    ['python-httpx/0.27.0', 'python'],
    ['Python-urllib/3.12', 'python'],
    ['Python/3.12 aiohttp/3.10.5', 'python'],
    ['aiohttp/3.10.5', 'python'],
    ['Go-http-client/1.1', 'go'],
    ['curl/8.5.0', 'curl'],
    ['okhttp/4.12.0', 'java'],
    ['Java-http-client/21.0.4', 'java'],
    ['Java/17.0.2', 'java'],
    ['Apache-HttpClient/4.5.14 (Java/17.0.2)', 'java'],
    ['Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0', 'browser'],
    ['my-uploader/2.0 build 8f3a9c', 'other'],
    [undefined, 'none'],
    ['   ', 'none'],
  ])('user-agent %j is counted as caller %s, with slot and route as before', async (ua, family) => {
    const path = `/api/webhooks/caller-${family}-${String(ua).length}`;
    expect(await call(path, { query: PREVIOUS }, ua)).toBe(200);

    const [only, ...rest] = await series(path);
    expect(rest).toHaveLength(0);
    expect(only.labels).toEqual({ slot: 'previous', route: `POST ${path}`, caller: family });
    expect(only.value).toBe(1);
  });

  it('never carries the user-agent or the token into a label', async () => {
    const path = '/api/webhooks/caller-hostile';
    const hostile = [
      `curl/8 ${PREVIOUS}`,
      PREVIOUS,
      `x-${'a'.repeat(500)}`,
      '203.0.113.7',
      'user 12345',
    ];
    for (const ua of hostile) await call(path, { bearer: PREVIOUS }, ua);
    await call(path, { query: CURRENT }, `Mozilla/5.0 ${CURRENT}`);

    const values = (await webhookTokenMatchCounter.get()).values;
    for (const { labels } of values) {
      expect(CALLER_FAMILIES).toContain(labels.caller);
      expect(JSON.stringify(labels)).not.toContain(PREVIOUS);
      expect(JSON.stringify(labels)).not.toContain(CURRENT);
    }
    expect((await series(path)).map((v) => v.labels.caller).sort()).toEqual([
      'browser',
      'curl',
      'other',
    ]);
  });
});

describe('webhookTokenValues', () => {
  it('lists the previous value alongside the current one, and drops a blank or unset one', () => {
    expect(webhookTokenValues()).toEqual([CURRENT, PREVIOUS]);
    for (const blank of ['', '   ', undefined]) {
      setEnv({ WEBHOOK_TOKEN_PREVIOUS: blank });
      expect(webhookTokenValues()).toEqual([CURRENT]);
    }
  });
});
