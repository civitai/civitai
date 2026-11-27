import { beforeEach, describe, expect, it } from 'vitest';
// Setup-order import: installs the ~/env/server, db and redis mocks before the middleware loads.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { _internalsForTests, withBlockScope } from '../block-scope.middleware';
import { mintPreviewLabel } from '~/server/services/blocks/preview-session-host';

/**
 * Block CORS for an app running in its preview. A dev tunnel or an App Assistant direct preview
 * serves the app from a per-session origin that is never in the approved-origin allowlist, so
 * without this every block REST call from a preview was refused at the preflight. Such an origin
 * is allowed only while the platform's own session record for that exact host is live; another
 * host under the same domains gets no CORS at all.
 */

const APPS_DOMAIN = 'apps.test';
const PREVIEW_DOMAIN = 'preview.test';
const APPROVED_ORIGIN = 'https://approved-app.example';
const NOW = Math.floor(Date.now() / 1000);

// A made-up session label under a made-up key: never a real one.
const label = (previewId: string) =>
  mintPreviewLabel({ kid: 3, previewId, userId: 4242, exp: NOW + 3600 }, Buffer.alloc(32, 7));
const LIVE_PREVIEW_HOST = `${label('0123456789abcdef0123456789abcdef')}.${PREVIEW_DOMAIN}`;
const UNKNOWN_PREVIEW_HOST = `${label('fedcba9876543210fedcba9876543210')}.${PREVIEW_DOMAIN}`;
const LIVE_TUNNEL_HOST = `dev-0a1b2c3d4e5f6789.${APPS_DOMAIN}`;
const UNKNOWN_TUNNEL_HOST = `dev-9f8e7d6c5b4a3210.${APPS_DOMAIN}`;

type Session = { host: string; hardExpiresAt: number; transport?: 'direct' };
/** The sysRedis records, by key, as `persistSession` writes them. */
let records: Record<string, string>;

function putSession(sessionId: string, s: Session) {
  records[`system:blocks:dev-tunnel:host:${s.host}`] = sessionId;
  records[`system:blocks:dev-tunnel:session:${sessionId}`] = JSON.stringify({
    sessionId,
    userId: 4242,
    blockId: 'blk_preview',
    fingerprint: '',
    createdAt: NOW - 60,
    spendCapBuzz: 0,
    ...s,
  });
}

function makeRes() {
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0,
    headers,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json() {
      return res;
    },
    end() {
      return res;
    },
    setHeader(k: string, v: unknown) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    removeHeader() {
      return res;
    },
    writeHead() {
      return res;
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()];
    },
    on() {
      return res;
    },
  };
  return res;
}

let handlerCalls = 0;
const route = withBlockScope(
  (async (_req: NextApiRequest, res: NextApiResponse) => {
    handlerCalls += 1;
    res.status(200).json({ ok: true });
  }) as never,
  { endpoint: 'me', allowOpaqueOrigin: true }
);

async function call(method: 'OPTIONS' | 'GET', origin: string) {
  const res = makeRes();
  await route(
    {
      method,
      headers: {
        origin,
        ...(method === 'OPTIONS'
          ? {
              'access-control-request-method': 'GET',
              'access-control-request-headers': 'authorization',
            }
          : {}),
      },
      query: {},
      url: '/api/v1/blocks/me',
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
    res as never
  );
  return res;
}

beforeEach(() => {
  _internalsForTests.resetOriginCache();
  handlerCalls = 0;
  setEnv({ APPS_DOMAIN, APP_ASSISTANT_PREVIEW_DOMAIN: PREVIEW_DOMAIN });
  dbMock.dbRead.oauthClient.findMany.mockResolvedValue([{ allowedOrigins: [APPROVED_ORIGIN] }]);
  records = {};
  redisMock.sysRedis.get.mockReset();
  redisMock.sysRedis.get.mockImplementation(async (key: unknown) => records[String(key)] ?? null);
  putSession('sess_direct', {
    host: LIVE_PREVIEW_HOST,
    transport: 'direct',
    hardExpiresAt: NOW + 3600,
  });
  putSession('sess_tunnel', { host: LIVE_TUNNEL_HOST, hardExpiresAt: NOW + 3600 });
});

function expectBlockCors(res: ReturnType<typeof makeRes>, origin: string) {
  expect(res.headers['access-control-allow-origin']).toBe(origin);
  expect(res.headers['vary']).toBe('Origin');
  expect(res.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
  expect(res.headers['access-control-expose-headers']).toBe('Retry-After, Deprecation, Link');
  expect(res.headers['access-control-allow-credentials']).toBeUndefined();
}

function expectNoCors(res: ReturnType<typeof makeRes>) {
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
  expect(res.headers['access-control-allow-headers']).toBeUndefined();
}

describe('block CORS for a live preview origin', () => {
  it.each([
    ['direct preview', LIVE_PREVIEW_HOST],
    ['dev tunnel', LIVE_TUNNEL_HOST],
  ])('%s: preflight is answered 204 with block CORS', async (_kind, host) => {
    const res = await call('OPTIONS', `https://${host}`);
    expect(res.statusCode).toBe(204);
    expectBlockCors(res, `https://${host}`);
    expect(handlerCalls).toBe(0);
  });

  it.each([
    ['direct preview', LIVE_PREVIEW_HOST],
    ['dev tunnel', LIVE_TUNNEL_HOST],
  ])('%s: the GET carries block CORS and reaches the handler', async (_kind, host) => {
    const res = await call('GET', `https://${host}`);
    expectBlockCors(res, `https://${host}`);
    expect(handlerCalls).toBe(1);
  });
});

describe('block CORS refuses a preview-shaped origin with no live session', () => {
  it.each([
    ['unknown direct-preview host', UNKNOWN_PREVIEW_HOST],
    ['unknown dev-tunnel host', UNKNOWN_TUNNEL_HOST],
    ['a non-session name under the preview domain', `stest.${PREVIEW_DOMAIN}`],
  ])('%s: no CORS on preflight or GET', async (_kind, host) => {
    const pre = await call('OPTIONS', `https://${host}`);
    expect(pre.statusCode).not.toBe(204);
    expectNoCors(pre);
    const get = await call('GET', `https://${host}`);
    expectNoCors(get);
  });

  it('a session past its hard cap', async () => {
    putSession('sess_old', {
      host: UNKNOWN_PREVIEW_HOST,
      transport: 'direct',
      hardExpiresAt: NOW - 1,
    });
    expectNoCors(await call('OPTIONS', `https://${UNKNOWN_PREVIEW_HOST}`));
  });

  it('a host record whose session carries another host', async () => {
    records[`system:blocks:dev-tunnel:host:${UNKNOWN_PREVIEW_HOST}`] = 'sess_direct';
    expectNoCors(await call('OPTIONS', `https://${UNKNOWN_PREVIEW_HOST}`));
  });

  it('a host record whose session claims the other transport', async () => {
    // A direct-preview host on a record without `transport: "direct"` (read as a tunnel).
    putSession('sess_mismatch', { host: UNKNOWN_PREVIEW_HOST, hardExpiresAt: NOW + 3600 });
    expectNoCors(await call('OPTIONS', `https://${UNKNOWN_PREVIEW_HOST}`));
  });

  it('a session record that is JSON null', async () => {
    records[`system:blocks:dev-tunnel:host:${UNKNOWN_PREVIEW_HOST}`] = 'sess_null';
    records['system:blocks:dev-tunnel:session:sess_null'] = 'null';
    expectNoCors(await call('OPTIONS', `https://${UNKNOWN_PREVIEW_HOST}`));
  });

  it('a live host over http, or on another port', async () => {
    expectNoCors(await call('OPTIONS', `http://${LIVE_PREVIEW_HOST}`));
    expectNoCors(await call('OPTIONS', `https://${LIVE_PREVIEW_HOST}:8443`));
  });

  it('a live host when its session record cannot be read', async () => {
    redisMock.sysRedis.get.mockRejectedValue(new Error('down'));
    expectNoCors(await call('OPTIONS', `https://${LIVE_PREVIEW_HOST}`));
  });

  it('an arbitrary origin costs no session lookup', async () => {
    expectNoCors(await call('OPTIONS', 'https://evil.example'));
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });
});

describe('the other CORS arms are unchanged', () => {
  it('an approved app origin', async () => {
    const res = await call('OPTIONS', APPROVED_ORIGIN);
    expect(res.statusCode).toBe(204);
    expectBlockCors(res, APPROVED_ORIGIN);
  });

  it('the opted-in opaque origin', async () => {
    const res = await call('OPTIONS', 'null');
    expect(res.statusCode).toBe(204);
    expectBlockCors(res, 'null');
  });
});
