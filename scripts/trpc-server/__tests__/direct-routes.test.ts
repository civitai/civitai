import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';

/**
 * Unit tests for the image entrypoint's direct-route listener (`scripts/trpc-server/
 * direct-routes.cjs`, `next-entry.cjs`). They pin the decisions it makes on its own: when it
 * serves, what it does to the request first, and that everything else reaches Next's listener
 * unchanged. Whether its answers equal Next's, byte for byte, is the parity job's
 * (`.github/workflows/trpc-server-parity.yml`, `--cases image-delivery`).
 */

const require = createRequire(import.meta.url);
const direct = require('../direct-routes.cjs');
const { bootWithWrappedListener } = require('../next-entry.cjs');
const compat = require('../next-compat.cjs');

const PAGE = '/api/internal/image-delivery/[id]';
const DIST = '/app/.next';

// The shape `next build` writes for this app's config (see next-compat.test.ts).
const routesManifest = {
  redirects: [],
  headers: [
    {
      source: '/:nextInternalLocale(en)/((?!gift-cards).*)',
      headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
    },
  ],
  rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
  onMatchHeaders: [],
};
const nextConfig = { i18n: { locales: ['en'], defaultLocale: 'en' } };

function fakeReq(url: string, headers: Record<string, string> = {}) {
  const all: Record<string, string | undefined> = { host: 'localhost:3000', ...headers };
  return Object.assign(new EventEmitter(), {
    url,
    method: 'GET',
    headers: all,
    socket: { remoteAddress: '203.0.113.9' },
  });
}

function fakeRes() {
  const headers: Record<string, unknown> = {};
  return Object.assign(new EventEmitter(), {
    headers,
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn((k: string, v: unknown) => {
      headers[k] = v;
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  });
}

function build({
  on = true,
  handler = vi.fn(async () => {}),
  requireModule,
  load,
}: {
  on?: boolean;
  handler?: ReturnType<typeof vi.fn>;
  requireModule?: () => unknown;
  load?: () => unknown;
} = {}) {
  const stats = { served: 0, switch_off: 0, unmatched: 0, load_failed: 0 };
  const log = { error: vi.fn() };
  const loader = vi.fn(
    load ??
      (() => ({
        compat,
        routing: compat.createRouting({ routesManifest, nextConfig }),
        matchPage: compat.createPageMatcher([PAGE]),
        modules: new Map([
          [PAGE, { require: requireModule ?? (() => ({ handler })), promise: null }],
        ]),
        distDir: DIST,
        hostname: '0.0.0.0',
        port: () => 3000,
      }))
  );
  const routes = direct.createDirectRoutes({ isOn: () => on, stats, load: loader, log });
  return { routes, stats, handler, loader, log };
}

describe('the switch', () => {
  const flag = (isEnabledSync: unknown) => ({ __civitaiFliptClient: { isEnabledSync } });

  it('is the Flipt key the app declares', () => {
    expect(direct.SWITCH_FLAG).toBe(FLIPT_FEATURE_FLAGS.IMAGE_DELIVERY_DIRECT_ROUTE);
    expect(direct.SWITCH_FLAG).toBe('image-delivery-direct-route');
  });

  it('reads the app Flipt client with the key and no entity id', () => {
    const isEnabledSync = vi.fn(() => true);
    const isOn = direct.createSwitch({ env: {}, now: () => 0, global: flag(isEnabledSync) });
    expect(isOn()).toBe(true);
    expect(isEnabledSync).toHaveBeenCalledTimes(1);
    expect(isEnabledSync.mock.calls[0]).toEqual(['image-delivery-direct-route']);
  });

  it.each([
    ['no client built yet', {}],
    ['client not initialised (null)', flag(() => null)],
    ['flag reads false', flag(() => false)],
    [
      'the read throws (missing key)',
      flag(() => {
        throw new Error('flag not found');
      }),
    ],
    ['a truthy non-boolean', flag(() => 'true')],
  ])('is off when %s', (_, global) => {
    expect(direct.createSwitch({ env: {}, now: () => 0, global })()).toBe(false);
  });

  it('reuses one reading for SWITCH_TTL_MS, then reads again', () => {
    let t = 10_000;
    const isEnabledSync = vi.fn(() => true);
    const isOn = direct.createSwitch({ env: {}, now: () => t, global: flag(isEnabledSync) });
    isOn();
    t += direct.SWITCH_TTL_MS - 1;
    isOn();
    expect(isEnabledSync).toHaveBeenCalledTimes(1);
    t += 1;
    isEnabledSync.mockReturnValue(false);
    expect(isOn()).toBe(false);
    expect(isEnabledSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['on', true],
    ['ON', true],
    [' off ', false],
  ])('NEXT_DIRECT_ROUTES=%s overrides Flipt', (value, expected) => {
    const isEnabledSync = vi.fn(() => !expected);
    const isOn = direct.createSwitch({
      env: { NEXT_DIRECT_ROUTES: value },
      now: () => 0,
      global: flag(isEnabledSync),
    });
    expect(isOn()).toBe(expected);
    expect(isEnabledSync).not.toHaveBeenCalled();
  });

  it('reads Flipt for any other NEXT_DIRECT_ROUTES value', () => {
    const isEnabledSync = vi.fn(() => true);
    const isOn = direct.createSwitch({
      env: { NEXT_DIRECT_ROUTES: 'yes' },
      now: () => 0,
      global: flag(isEnabledSync),
    });
    expect(isOn()).toBe(true);
    expect(isEnabledSync).toHaveBeenCalledTimes(1);
  });
});

describe('route', () => {
  it('serves the exact page while the switch is on', () => {
    const { routes, stats } = build();
    expect(routes.route(fakeReq('/api/internal/image-delivery/abc.jpeg?token=t'))).toBe(PAGE);
    expect(stats).toEqual({ served: 0, switch_off: 0, unmatched: 0, load_failed: 0 });
  });

  it('hands a direct path to Next while the switch is off, without loading anything', () => {
    const { routes, stats, loader } = build({ on: false });
    expect(routes.route(fakeReq('/api/internal/image-delivery/abc'))).toBeNull();
    expect(stats.switch_off).toBe(1);
    expect(loader).not.toHaveBeenCalled();
  });

  it.each([
    '/api/trpc/content.get',
    '/api/internal/ping',
    '/api/internal/image-deliveryx/abc',
    '/images/abc',
  ])('leaves %s alone and counts nothing', (url) => {
    const { routes, stats, loader } = build();
    expect(routes.route(fakeReq(url))).toBeNull();
    expect(stats).toEqual({ served: 0, switch_off: 0, unmatched: 0, load_failed: 0 });
    expect(loader).not.toHaveBeenCalled();
  });

  it.each([
    ['a trailing slash (Next 308s it)', '/api/internal/image-delivery/abc/'],
    ['more segments (Next renders its 404 page)', '/api/internal/image-delivery/a/b'],
    ['no id', '/api/internal/image-delivery/'],
    ['a bad % escape (Next renders its 400 page)', '/api/internal/image-delivery/%E0%A4%A'],
  ])('hands %s to Next', (_, url) => {
    const { routes, stats } = build();
    expect(routes.route(fakeReq(url))).toBeNull();
    expect(stats.unmatched).toBe(1);
  });

  it('turns itself off for good when setup fails', () => {
    const { routes, stats, loader, log } = build({
      load: () => {
        throw new Error('beforeFiles rewrites are not supported');
      },
    });
    expect(routes.route(fakeReq('/api/internal/image-delivery/a'))).toBeNull();
    expect(routes.route(fakeReq('/api/internal/image-delivery/b'))).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(stats.load_failed).toBe(2);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('serve', () => {
  it('does what the router does, then calls the route module as a direct invocation', async () => {
    const { routes, stats, handler } = build();
    const req = fakeReq('/api/internal/image-delivery/abc?token=t&nxtPid=other', {
      authorization: 'Bearer t',
      'x-nextjs-data': '1',
      'x-matched-path': '/api/trpc/[trpc]',
      'x-middleware-request-x-civitai-verified-bot': 'googlebot',
    });
    const res = fakeRes();
    const page = routes.route(req);

    await expect(routes.serve(req, res, page)).resolves.toBe(true);

    expect(handler).toHaveBeenCalledTimes(1);
    const [hReq, hRes, ctx] = handler.mock.calls[0];
    expect(hReq).toBe(req);
    expect(hRes).toBe(res);
    expect(ctx).toEqual({
      waitUntil: undefined,
      requestMeta: { relativeProjectDir: '.', distDir: DIST },
    });
    // headers() config
    expect(res.headers).toEqual({ 'X-Frame-Options': 'DENY' });
    // client-sent internal headers dropped, the caller's own kept
    expect(req.headers).not.toHaveProperty('x-nextjs-data');
    expect(req.headers).not.toHaveProperty('x-matched-path');
    expect(req.headers).not.toHaveProperty('x-middleware-request-x-civitai-verified-bot');
    expect(req.headers.authorization).toBe('Bearer t');
    // x-forwarded-* filled as base-server fills them
    expect(req.headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(req.headers['x-forwarded-host']).toBe('localhost:3000');
    expect(req.headers['x-forwarded-port']).toBe('3000');
    expect(req.headers['x-forwarded-proto']).toBe('http');
    // Next's internal query keys dropped, the rest kept
    expect(req.url).toBe('/api/internal/image-delivery/abc?token=t');
    expect(stats.served).toBe(1);
  });

  it('loads the route module once', async () => {
    const handler = vi.fn(async () => {});
    const requireModule = vi.fn(() => ({ handler }));
    const { routes } = build({ handler, requireModule });
    for (let i = 0; i < 3; i++) {
      const req = fakeReq('/api/internal/image-delivery/abc');
      await routes.serve(req, fakeRes(), routes.route(req));
    }
    expect(requireModule).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('resolves false and leaves the request untouched when the module cannot load, then retries', async () => {
    const handler = vi.fn(async () => {});
    const requireModule = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('MODULE_NOT_FOUND');
      })
      .mockImplementation(() => ({ handler }));
    const { routes, stats } = build({ handler, requireModule });

    const req = fakeReq('/api/internal/image-delivery/abc?nxtPid=x', { 'x-nextjs-data': '1' });
    const res = fakeRes();
    await expect(routes.serve(req, res, routes.route(req))).resolves.toBe(false);
    expect(req.url).toBe('/api/internal/image-delivery/abc?nxtPid=x');
    expect(req.headers['x-nextjs-data']).toBe('1');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(stats.load_failed).toBe(1);
    expect(stats.served).toBe(0);

    const req2 = fakeReq('/api/internal/image-delivery/abc');
    await expect(routes.serve(req2, fakeRes(), routes.route(req2))).resolves.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a module with no handler export', async () => {
    const { routes, stats } = build({ requireModule: () => ({ default: () => {} }) });
    const req = fakeReq('/api/internal/image-delivery/abc');
    await expect(routes.serve(req, fakeRes(), routes.route(req))).resolves.toBe(false);
    expect(stats.load_failed).toBe(1);
  });
});

describe('wrapListener', () => {
  function wrapped(route: (req: unknown) => string | null, serve: () => Promise<boolean>) {
    const listener = vi.fn(function (this: unknown) {
      return this;
    });
    const fn = direct.wrapListener(listener, { route, serve: vi.fn(serve) });
    return { fn, listener };
  }

  it('calls Next synchronously, with the same this, for anything not served directly', () => {
    const { fn, listener } = wrapped(
      () => null,
      () => Promise.resolve(true)
    );
    const self = {};
    const req = fakeReq('/api/trpc/x');
    const res = fakeRes();
    const out = fn.call(self, req, res);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]).toEqual([req, res]);
    expect(out).toBe(self);
  });

  it('does not call Next for a request it served', async () => {
    const { fn, listener } = wrapped(
      () => PAGE,
      () => Promise.resolve(true)
    );
    await fn(fakeReq('/x'), fakeRes());
    expect(listener).not.toHaveBeenCalled();
  });

  it('hands the request to Next when serve declines', async () => {
    const { fn, listener } = wrapped(
      () => PAGE,
      () => Promise.resolve(false)
    );
    await fn(fakeReq('/x'), fakeRes());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('answers 500 when the handler throws before responding', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fn, listener } = wrapped(
      () => PAGE,
      () => Promise.reject(new Error('boom'))
    );
    const res = fakeRes();
    await fn(fakeReq('/x'), res);
    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal Server Error');
    expect(listener).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('bootWithWrappedListener', () => {
  const fakeHttp = () => ({ createServer: http.createServer });

  it('wraps the listener of the one server created while booting, and restores createServer', () => {
    const h = fakeHttp();
    const original = h.createServer;
    const listener = vi.fn();
    const wrappedListener = vi.fn();
    let server: http.Server | undefined;
    const n = bootWithWrappedListener(
      h,
      () => {
        server = h.createServer(listener);
      },
      () => wrappedListener
    );
    expect(n).toBe(1);
    expect(h.createServer).toBe(original);
    expect(server!.listeners('request')).toEqual([wrappedListener]);
  });

  it('keeps no wrapper when boot creates more than one server', () => {
    const h = fakeHttp();
    const a = vi.fn();
    const b = vi.fn();
    const servers: http.Server[] = [];
    const n = bootWithWrappedListener(
      h,
      () => {
        servers.push(h.createServer(a), h.createServer(b));
      },
      () => vi.fn()
    );
    expect(n).toBe(2);
    expect(servers[0].listeners('request')).toEqual([a]);
    expect(servers[1].listeners('request')).toEqual([b]);
  });

  it('reports zero when boot creates no server', () => {
    const h = fakeHttp();
    expect(bootWithWrappedListener(h, () => {}, vi.fn())).toBe(0);
    expect(h.createServer).toBe(http.createServer);
  });

  it('restores createServer when boot throws', () => {
    const h = fakeHttp();
    expect(() =>
      bootWithWrappedListener(
        h,
        () => {
          throw new Error('boot failed');
        },
        vi.fn()
      )
    ).toThrow('boot failed');
    expect(h.createServer).toBe(http.createServer);
  });
});
