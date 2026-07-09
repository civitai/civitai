import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Readable } from 'stream';

// Tests the civitai.com OAuth shim at src/pages/api/auth/oauth/[...path].ts. It must REDIRECT the browser
// `authorize` flow but transparently reverse-PROXY the server-to-server endpoints — preserving the
// Authorization header + body (a cross-origin 308 would strip Authorization and isn't followed by all
// clients, which is what broke pre-cutover third-party integrations).

const HUB = 'http://hub.test';

// Minimal NextApiRequest stand-in: a readable stream of the body + the fields the handler reads.
function makeReq({
  method = 'POST',
  url = '/api/auth/oauth/token',
  headers = {},
  query = {},
  body = '',
}: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: string;
} = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(stream, { method, url, headers, query }) as never;
}

function makeRes() {
  const out: {
    status: number;
    headers: Record<string, unknown>;
    body?: unknown;
    redirectStatus?: number;
    redirectUrl?: string;
  } = { status: 200, headers: {} };
  const res = {
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
    send(b: unknown) {
      out.body = b;
      return res;
    },
    setHeader(k: string, v: unknown) {
      out.headers[k.toLowerCase()] = v;
      return res;
    },
    redirect(code: number, url: string) {
      out.redirectStatus = code;
      out.redirectUrl = url;
      return res;
    },
    _out: out,
  };
  return res as never;
}

// HUB is read from env at module load → set it before importing the handler.
let handler: (req: never, res: never) => Promise<void>;
beforeAll(async () => {
  process.env.AUTH_JWT_ISSUER = HUB;
  handler = (await import('~/pages/api/auth/oauth/[...path]')).default;
});

beforeEach(() => vi.restoreAllMocks());

describe('oauth shim', () => {
  it('REDIRECTS the browser authorize flow (no proxy) — login/consent must happen on the hub', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const req = makeReq({
      method: 'GET',
      url: '/api/auth/oauth/authorize?client_id=x&state=s',
      query: { path: ['authorize'] },
    });
    const res = makeRes();
    await handler(req, res);

    expect((res as never as { _out: ReturnType<typeof makeRes>['_out'] })._out.redirectStatus).toBe(
      308
    );
    expect((res as never as { _out: ReturnType<typeof makeRes>['_out'] })._out.redirectUrl).toBe(
      `${HUB}/api/auth/oauth/authorize?client_id=x&state=s`
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PROXIES the token POST, preserving the Authorization header + body (client_secret_basic survives)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"access_token":"civitai_abc"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const req = makeReq({
      method: 'POST',
      url: '/api/auth/oauth/token',
      headers: {
        authorization: 'Basic Y2xpZW50OnNlY3JldA==',
        'content-type': 'application/x-www-form-urlencoded',
      },
      query: { path: ['token'] },
      body: 'grant_type=refresh_token&refresh_token=civitai_r',
    });
    const res = makeRes();
    await handler(req, res);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${HUB}/api/auth/oauth/token`);
    expect(init.method).toBe('POST');
    // The header a cross-origin 308 would have stripped is preserved here:
    expect((init.headers as Headers).get('authorization')).toBe('Basic Y2xpZW50OnNlY3JldA==');
    expect(Buffer.from(init.body as Buffer).toString()).toBe(
      'grant_type=refresh_token&refresh_token=civitai_r'
    );
    // Hop-by-hop dropped; host not forwarded.
    expect((init.headers as Headers).has('host')).toBe(false);

    const out = (res as never as { _out: ReturnType<typeof makeRes>['_out'] })._out;
    expect(out.status).toBe(200);
    expect(Buffer.from(out.body as Buffer).toString()).toBe('{"access_token":"civitai_abc"}');
  });

  it('relays a hub 4xx (e.g. invalid_grant) verbatim instead of masking it', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 })
    );
    const req = makeReq({ url: '/api/auth/oauth/token', query: { path: ['token'] }, body: 'x=1' });
    const res = makeRes();
    await handler(req, res);

    const out = (res as never as { _out: ReturnType<typeof makeRes>['_out'] })._out;
    expect(out.status).toBe(400);
    expect(Buffer.from(out.body as Buffer).toString()).toBe('{"error":"invalid_grant"}');
  });

  it('forwards Bearer to userinfo (GET, no body) so it is not stripped', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const req = makeReq({
      method: 'GET',
      url: '/api/auth/oauth/userinfo',
      headers: { authorization: 'Bearer civitai_tok' },
      query: { path: ['userinfo'] },
    });
    await handler(req, makeRes());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get('authorization')).toBe('Bearer civitai_tok');
    expect(init.body).toBeUndefined(); // GET carries no body
  });

  it('returns 502 when the hub proxy fetch fails', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const req = makeReq({ url: '/api/auth/oauth/token', query: { path: ['token'] }, body: 'x=1' });
    const res = makeRes();
    await handler(req, res);

    const out = (res as never as { _out: ReturnType<typeof makeRes>['_out'] })._out;
    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({ error: 'server_error' });
  });
});
