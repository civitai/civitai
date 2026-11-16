import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

/** The embed's forward to the Studio server: which requests leave this app, to where, carrying what,
 *  and what comes back to the browser. The outbound request is caught at `fetch`. */

const access = vi.hoisted(() => ({ allow: vi.fn(async (..._args: unknown[]) => true) }));
vi.mock('~/server/utils/training-studio-access', () => ({
  allowTrainingStudio: (...args: unknown[]) => access.allow(...args),
}));
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_TRAINING_STUDIO_URL: 'https://studio.example' },
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { id: 7 }),
}));

import handler from '~/pages/api/training-studio/studio/[route]';

const SESSION = '__Secure-civ-token=jwt.a.b';
const COOKIES = `${SESSION}; other=secret; __Secure-civitai-token=legacy`;

function call({
  route,
  method = 'POST',
  query = {},
  body = { runs: [] },
  headers = {},
}: {
  route: unknown;
  method?: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    setHeader(name: string, value: unknown) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const req = {
    method,
    query: { ...query, route },
    body,
    headers: {
      cookie: COOKIES,
      'content-type': 'application/json',
      authorization: 'Bearer user-key',
      'x-forwarded-host': 'evil.example',
      ...headers,
    },
  };
  return Promise.resolve(
    (handler as unknown as (q: unknown, s: unknown) => unknown)(req, res)
  ).then(() => res);
}

const fetchMock = vi.fn();
beforeEach(() => {
  access.allow.mockReset().mockResolvedValue(true);
  fetchMock.mockReset().mockResolvedValue(Response.json({ workflowIds: ['wf-1'] }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const outbound = () =>
  fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];

describe('/api/training-studio/studio/[route]', () => {
  it("sends a submit to the Studio's fixed origin with the session cookie and nothing else", async () => {
    const res = await call({ route: 'train', body: { runs: [{ trigger: 'x' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ workflowIds: ['wf-1'] });
    const [url, init] = outbound();
    expect(url).toBe('https://studio.example/api/train');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ runs: [{ trigger: 'x' }] });
    expect(init.headers.cookie).toBe(SESSION);
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toEqual(
      expect.arrayContaining(['authorization'])
    );
    expect(JSON.stringify(init.headers)).not.toContain('evil.example');
  });

  it("answers with the Studio's refusal, so the embed can show the mature confirm", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { message: 'confirm', matureCount: 2 },
        { status: 409, headers: { 'set-cookie': 'studio=1' } }
      )
    );
    const res = await call({ route: 'train' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'confirm', matureCount: 2 });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it("prices a continuation with the caller's query, minus the route", async () => {
    await call({
      route: 'continue-training',
      method: 'GET',
      body: undefined,
      query: { id: 'wf', fromEpoch: '1', addEpochs: '2', currencies: ['green', 'yellow'] },
    });
    const [url, init] = outbound();
    expect(url).toBe(
      'https://studio.example/api/continue-training?id=wf&fromEpoch=1&addEpochs=2&currencies=green&currencies=yellow'
    );
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it.each([
    ['a Studio route outside the list', 'rename'],
    ['a path', 'train/../rename'],
    ['an encoded path', 'train%2F..%2Frename'],
    ['an inherited key', '__proto__'],
    ['an inherited key', 'constructor'],
    ['several segments', ['train', 'x']],
  ])('sends nothing for %s (%j)', async (_label, route) => {
    const res = await call({ route });
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a method the route does not take', { route: 'train', method: 'GET' }, 405],
    ['a body that is not JSON', { route: 'train', headers: { 'content-type': 'text/plain' } }, 415],
    ['a caller with no session cookie', { route: 'train', headers: { cookie: 'other=1' } }, 401],
  ] as const)('sends nothing for %s', async (_label, input, status) => {
    const res = await call(input);
    expect(res.statusCode).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing for a user the embed's own gates refuse", async () => {
    access.allow.mockImplementationOnce(async (...args: unknown[]) => {
      (args[1] as { status: (n: number) => { json: (b: unknown) => void } })
        .status(403)
        .json({ error: 'no' });
      return false;
    });
    const res = await call({ route: 'train' });
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a Studio redirect as a session it did not accept', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://hub.example/login' } })
    );
    const res = await call({ route: 'train' });
    expect(res.statusCode).toBe(401);
  });
});
