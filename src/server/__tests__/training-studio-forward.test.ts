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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import handler, { config } from '~/pages/api/training-studio/studio/[route]';
import { studioOrigin } from '~/server/services/training-studio-forward.service';

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
    // Followed, a Studio redirect to sign-in would come back as that page instead of a 401.
    expect(init.redirect).toBe('manual');
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
    ['edit-image', {}, { prompt: 'p' }, 'https://studio.example/api/edit-image'],
    [
      'suggest-instruction',
      {},
      { beforeUrl: 'a' },
      'https://studio.example/api/suggest-instruction',
    ],
    [
      'epoch-archive',
      { id: 'wf', kind: 'weights' },
      {},
      'https://studio.example/api/epoch-archive?id=wf&kind=weights',
    ],
  ])('forwards a %s submit, with its query', async (route, query, body, url) => {
    const res = await call({ route, query, body });
    expect(res.statusCode).toBe(200);
    const [sent, init] = outbound();
    expect(sent).toBe(url);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  // Their quotes and polls stay browser calls; only the submit is forwarded.
  it.each(['edit-image', 'suggest-instruction', 'epoch-archive'])(
    'sends nothing for a GET to %s',
    async (route) => {
      const res = await call({ route, method: 'GET' });
      expect(res.statusCode).toBe(405);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

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

  it.each([
    ["the Studio's closed-beta page as a run that never started", 403, 403, /didn't start/],
    ['a 2xx page as an unconfirmed submit', 200, 502, /check your runs/],
    ['any other page as an unconfirmed submit', 503, 502, /check your runs/],
  ])('answers %s', async (_label, upstream, status, message) => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>page</html>', {
        status: upstream,
        headers: { 'content-type': 'text/html' },
      })
    );
    const res = await call({ route: 'train' });
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ message: expect.stringMatching(message) });
  });

  it('answers a 2xx whose body breaks off mid-read as an unconfirmed submit', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"workflowIds":['));
        controller.error(new Error('connection reset'));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    const res = await call({ route: 'train' });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ message: expect.stringMatching(/check your runs/) });
  });

  it("sends the session cookie's bytes as the browser sent them", async () => {
    const raw = '__Host-civ-token=a%2fb.c';
    await call({ route: 'train', headers: { cookie: `x=1; ${raw}` } });
    expect(outbound()[1].headers.cookie).toBe(raw);
  });

  it('never sends the session to a local Studio outside development', () => {
    expect(() => studioOrigin('http://localhost:5174')).toThrow();
    expect(() => studioOrigin('http://studio.example')).toThrow();
    expect(studioOrigin('https://studio.example/x')).toBe('https://studio.example');
  });

  it('answers a Studio that cannot be reached, or times out, as unconfirmed', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    const res = await call({ route: 'train' });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ message: expect.stringMatching(/check your runs/) });
  });

  it('reads a Studio redirect as a session it did not accept', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://hub.example/login' } })
    );
    const res = await call({ route: 'train' });
    expect(res.statusCode).toBe(401);
  });
});

describe('/api/training-studio/studio/[route] body limit', () => {
  // Each limit in the one spelling its own parser reads: Next's `bytes` takes "16mb" (and reads "16m"
  // as 16 bytes); adapter-node takes "16M" (and refuses "16MB" at startup).
  const forward = /^(\d+)mb$/.exec(config.api.bodyParser.sizeLimit);
  const dockerfile = readFileSync(
    resolve(process.cwd(), 'apps/training-studio/Dockerfile'),
    'utf8'
  );
  const runtimeStage = dockerfile.slice(dockerfile.search(/^FROM .* AS runtime$/m));
  const studio = /^ENV BODY_SIZE_LIMIT=(\d+)M$/m.exec(runtimeStage);
  // The Studio's own caps on a Start, read from its source: its modules do not load here.
  const studioConst = (file: string, name: string) =>
    Number(
      new RegExp(`export const ${name} = ([0-9]+);`).exec(
        readFileSync(resolve(process.cwd(), 'apps/training-studio/src/lib', file), 'utf8')
      )?.[1]
    );
  const MAX_RUNS = studioConst('submit-limits.ts', 'MAX_RUNS');
  const MAX_DATASET_BLOBS = studioConst('orchestrator-core.ts', 'MAX_DATASET_BLOBS');

  it("matches the Studio server's own limit, set in the image it runs", () => {
    expect(forward).not.toBeNull();
    expect(dockerfile.search(/^FROM .* AS runtime$/m)).toBeGreaterThan(0);
    expect(studio).not.toBeNull();
    expect(Number(studio![1])).toBe(Number(forward![1]));
  });

  // 16 MB is chosen to hold a maximal Start at realistic captions; longer ones get the "too large" answer.
  it('the 16 MB limit holds the largest Start the Studio accepts, at 1,000-character captions', () => {
    const item = {
      air: `urn:air:other:other:orchestrator:blob@${'A'.repeat(26)}.jpeg`,
      caption: 'c'.repeat(1000),
    };
    const run = {
      items: Array.from({ length: MAX_DATASET_BLOBS }, () => item),
      prompts: ['p'.repeat(500)],
    };
    const body = JSON.stringify({ runs: Array.from({ length: MAX_RUNS }, () => run) });
    // Read from source: a missed read would size an empty body and pass.
    expect(MAX_RUNS).toBeGreaterThan(0);
    expect(MAX_DATASET_BLOBS).toBeGreaterThan(0);
    expect(Buffer.byteLength(body)).toBeLessThan(Number(forward![1]) * 1024 * 1024);
  });
});
