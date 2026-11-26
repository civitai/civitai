import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { addRequestMeta, type RequestMeta } from 'next/dist/server/request-meta';
import { NodeNextRequest } from 'next/dist/server/base-http/node';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_ROUTE_REQUESTS_METRIC,
  STANDALONE_API_ROUTE_PAGE_KEY,
  apiRoutePattern,
  installApiRouteServerHook,
  methodLabel,
  observeApiRequest,
  registerApiRouteMetrics,
} from '~/server/prom/api-route.metrics';
import { apiRouteLabel } from '~/server/utils/page-routes';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

const require = createRequire(import.meta.url);
const served = require('../../../../scripts/trpc-server/served-pages.cjs') as {
  API_ROUTE_PAGE_REQ_KEY: string;
};

// The build's route patterns for these tests: two API routes, an API index, and page routes that
// must never pass as API labels.
const MANIFEST = [
  '/_app',
  '/_error',
  '/',
  '/models/[id]/[[...slug]]',
  '/api/trpc/[trpc]',
  '/api/v1/models',
  '/api/v1/models/[id]',
  '/api/auth/session',
];

type Row = { value: number; labels: Record<string, string | number> };

/** Every series of the counter, as `{labels, value}`. */
async function counts(): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(API_ROUTE_REQUESTS_METRIC) as
    | client.Counter<string>
    | undefined;
  return metric
    ? ((await metric.get()).values as Row[]).map((r) => ({ labels: r.labels, value: r.value }))
    : [];
}

/** Sets the route match the way Next's own router does, through Next's own function. */
function setNextMatch(req: object, page: string, params: Record<string, string> = {}) {
  addRequestMeta(req as IncomingMessage, 'match', {
    definition: { kind: 'PAGES_API', page, pathname: page, bundlePath: '', filename: '' },
    params,
  } as unknown as RequestMeta['match']);
}

beforeEach(() => {
  usePagesManifestFixture(MANIFEST);
  (instrumentationRegistry.getSingleMetric(API_ROUTE_REQUESTS_METRIC) as client.Counter)?.reset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('route label', () => {
  it("reads a match Next adds through its own request wrapper on the raw request's meta", () => {
    // Next's server wraps the raw IncomingMessage in a NodeNextRequest and adds `match` to the
    // WRAPPER. The raw request (the one the server hook holds) sees it only because the wrapper
    // shares the raw request's existing meta object. If a Next upgrade stops sharing it, the label
    // reads `other` for every route, and this goes red.
    const raw = new http.IncomingMessage(new Socket());
    raw.method = 'GET';
    raw.url = '/api/v1/models/123?x=1';
    addRequestMeta(raw, 'initURL', 'http://localhost/api/v1/models/123?x=1');
    const wrapped = new NodeNextRequest(raw);
    setNextMatch(wrapped, '/api/v1/models/[id]', { id: '123' });
    expect(apiRoutePattern(raw)).toBe('/api/v1/models/[id]');
    expect(apiRouteLabel(apiRoutePattern(raw))).toBe('/api/v1/models/[id]');
  });

  it('reads the page the standalone server stores, under the key that server writes', () => {
    expect(STANDALONE_API_ROUTE_PAGE_KEY).toBe(served.API_ROUTE_PAGE_REQ_KEY);
    const req = {
      url: '/api/v1/models/123',
      [Symbol.for(served.API_ROUTE_PAGE_REQ_KEY)]: '/api/v1/models/[id]',
    };
    expect(apiRouteLabel(apiRoutePattern(req))).toBe('/api/v1/models/[id]');
  });

  it('labels other when no route was resolved, or the value is not an API manifest key', () => {
    expect(apiRouteLabel(apiRoutePattern({ url: '/api/v1/models/123' }))).toBe('other');
    for (const page of [
      '/api/v1/models/123', // a concrete URL
      '/api/v1/models/[id]?x=1',
      '/models/[id]/[[...slug]]', // a page route, not an API route
      '/_error',
      '/api/v1/invented/[x]',
      'x'.repeat(10_000),
    ]) {
      const req = {};
      setNextMatch(req, page);
      expect(apiRouteLabel(apiRoutePattern(req))).toBe('other');
    }
    expect(apiRouteLabel(undefined)).toBe('other');
    expect(apiRouteLabel(42)).toBe('other');
  });
});

describe('methodLabel', () => {
  it.each([
    ['GET', 'GET'],
    ['PROPFIND', 'other'],
    ['get', 'other'],
    [undefined, 'other'],
  ])('%s -> %s', (method, expected) => {
    expect(methodLabel(method)).toBe(expected);
  });
});

function makeRes(statusCode: number, writableFinished = true) {
  return Object.assign(new EventEmitter(), { statusCode, writableFinished });
}

describe('observeApiRequest', () => {
  it('counts exactly one per response, even when close fires twice', async () => {
    const req = { url: '/api/v1/models/123?x=1', method: 'GET' };
    const res = makeRes(200);
    observeApiRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    setNextMatch(req, '/api/v1/models/[id]', { id: '123' }); // resolved after receipt, as in Next
    res.emit('close');
    res.emit('close');

    expect(await counts()).toEqual([
      { labels: { route: '/api/v1/models/[id]', method: 'GET', status_class: '2xx' }, value: 1 },
    ]);
  });

  it('never throws when reading the response fails', () => {
    const res = new EventEmitter();
    Object.defineProperty(res, 'statusCode', {
      get() {
        throw new Error('boom');
      },
    });
    observeApiRequest(
      { url: '/api/v1/models' } as unknown as IncomingMessage,
      res as unknown as ServerResponse
    );
    expect(() => res.emit('close')).not.toThrow();
  });
});

describe('server hook', () => {
  // Hooked on a subclass, so http.Server.prototype itself is never touched by this file.
  class HookedServer extends http.Server {}
  installApiRouteServerHook(HookedServer.prototype);

  async function withServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (base: string) => Promise<void>
  ) {
    const server = new HookedServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function get(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      http
        .get(url, { agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        })
        .on('error', reject);
    });
  }

  it('records each request once, by route pattern, including a thrown handler and an abort', async () => {
    // Stands in for Next: the route is resolved while handling, and a thrown handler is answered
    // with a 500 by the framework (Next's apiResolver), not by the route.
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '';
      if (url.startsWith('/api/v1/models/')) setNextMatch(req, '/api/v1/models/[id]');
      if (url.startsWith('/api/auth/session')) setNextMatch(req, '/api/auth/session');
      if (url === '/api/v1/models/hang') return; // never answers
      Promise.resolve()
        .then(() => {
          if (url.startsWith('/api/auth/session')) throw new Error('handler threw');
          res.statusCode = url.includes('missing') ? 404 : 200;
          res.end('ok');
        })
        .catch(() => {
          res.statusCode = 500;
          res.end('Internal Server Error');
        });
    };

    await withServer(handler, async (base) => {
      expect(await get(`${base}/api/v1/models/123?x=1`)).toBe(200);
      expect(await get(`${base}/api/v1/models/456`)).toBe(200);
      expect(await get(`${base}/api/v1/models/missing`)).toBe(404);
      expect(await get(`${base}/api/auth/session`)).toBe(500);
      expect(await get(`${base}/api/unknown/route`)).toBe(200);
      expect(await get(`${base}/models/123`)).toBe(200); // a page: not observed

      const hung = http.get(`${base}/api/v1/models/hang`, { agent: false });
      hung.on('error', () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      hung.destroy();

      await vi.waitFor(async () => {
        expect(await counts()).toHaveLength(5);
      });
    });

    const byKey = Object.fromEntries(
      (await counts()).map((c) => [
        `${c.labels.route} ${c.labels.method} ${c.labels.status_class}`,
        c.value,
      ])
    );
    expect(byKey).toEqual({
      '/api/v1/models/[id] GET 2xx': 2,
      '/api/v1/models/[id] GET 4xx': 1,
      '/api/auth/session GET 5xx': 1,
      'other GET 2xx': 1,
      '/api/v1/models/[id] GET aborted': 1,
    });
  });
});

describe('installApiRouteServerHook delegation', () => {
  type Call = { self: unknown; args: unknown[] };

  it("reaches a parent's emit that was replaced after install, with the same this, args and result", () => {
    const calls: Call[] = [];
    const parent = {
      emit(..._args: unknown[]): boolean {
        throw new Error('the emit captured at install time must not be called');
      },
    };
    const child = Object.create(parent) as typeof parent;
    expect(installApiRouteServerHook(child)).toBe(true);
    parent.emit = function (this: unknown, ...args: unknown[]) {
      calls.push({ self: this, args });
      return false;
    };
    const self = { name: 'server' };
    expect(child.emit.call(self, 'connection', 1, 2)).toBe(false);
    expect(calls).toEqual([{ self, args: ['connection', 1, 2] }]);
  });

  it('keeps an emit the prototype itself owned at install time', () => {
    const calls: Call[] = [];
    const parent = {
      emit(..._args: unknown[]): boolean {
        throw new Error('the parent must not be called when the prototype owns emit');
      },
    };
    const own = Object.create(parent) as typeof parent;
    own.emit = function (this: unknown, ...args: unknown[]) {
      calls.push({ self: this, args });
      return true;
    };
    expect(installApiRouteServerHook(own)).toBe(true);
    const self = { name: 'server' };
    expect(own.emit.call(self, 'listening')).toBe(true);
    expect(calls).toEqual([{ self, args: ['listening'] }]);
  });
});

describe('registerApiRouteMetrics', () => {
  it('installs nothing unless API_ROUTE_METRICS=true', () => {
    class Dark extends http.Server {}
    const before = Dark.prototype.emit;
    for (const env of [{}, { API_ROUTE_METRICS: 'false' }, { API_ROUTE_METRICS: '1' }]) {
      expect(registerApiRouteMetrics(env, Dark.prototype)).toBe(false);
      expect(Dark.prototype.emit).toBe(before);
    }
  });

  it('installs the hook when API_ROUTE_METRICS=true', () => {
    class Lit extends http.Server {}
    const before = Lit.prototype.emit;
    expect(registerApiRouteMetrics({ API_ROUTE_METRICS: 'true' }, Lit.prototype)).toBe(true);
    expect(Lit.prototype.emit).not.toBe(before);
  });
});
