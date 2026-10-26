import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Pins `patches/next@16.4.3.patch`: Next.js resolves the same modules with `require()` on every
 * request (the middleware manifest and node middleware several times per request, the API
 * route module, page modules, the cookie parser, the locale-redirect helper). The module cache
 * makes each of those return the same object, but every call still runs the whole require hook
 * chain (Next's own `require-hook`, OpenTelemetry's require-in-the-middle, Node's resolver). The
 * patch remembers each result outside dev, where Next never clears the require cache.
 *
 * 🔴 If any test here fails after a Next.js upgrade, the patch no longer applies to the code it
 * was written for. Re-read each patched call site in the new `node_modules/next/dist/server`,
 * regenerate the patch for the new version (or drop it if upstream memoises these itself),
 * and update the version in `package.json` → `pnpm.patchedDependencies`.
 *
 * The call sites run in a child process (`next-request-requires.probe.cjs`), because loading
 * `next-server` installs Next's process-wide require hook and node-environment extensions,
 * which must not leak into the test worker.
 */

const PROBE = join(process.cwd(), 'src/tests/build/next-request-requires.probe.cjs');

type ProbeResult = {
  calls: number;
  cookie: { requires: number; parsed: Record<string, string>[] };
  manifest: { requires: number; distinctObjects: number; hasMiddlewareKey: boolean };
  manifestDev: { requires: number; distinctObjects: number; hasMiddlewareKey: boolean };
  nodeMiddleware: {
    functionsConfigRequires: number;
    middlewareRequires: number;
    distinctObjects: number;
    marker: string;
  };
  noNodeMiddleware: { functionsConfigRequires: number; allUndefined: boolean };
  nodeMiddlewareDev: { middlewareRequires: number };
  apiRoute: { requires: number; handlerCalls: number };
  page: { requires: number; distinctObjects: number; marker: string };
};

let probe: ProbeResult;

beforeAll(() => {
  const run = spawnSync(process.execPath, [PROBE], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 50_000,
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  if (run.status !== 0 || !line) {
    throw new Error(
      `probe failed (exit ${run.status}, signal ${run.signal}):\n${run.stderr}\n${run.stdout}`
    );
  }
  probe = JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeResult;
}, 60_000);

describe('patched Next.js request path resolves each module once per process', () => {
  it('drives every call site three times', () => {
    // Every "1" below is only meaningful if the site ran more than once.
    expect(probe.calls).toBe(3);
  });

  it('cookie parser requires the cookie module once and still parses every call', () => {
    expect(probe.cookie.requires).toBe(1);
    expect(probe.cookie.parsed).toEqual([
      { a: '1', b: '2' },
      { a: '1', b: '2' },
      { a: '1', b: '2' },
    ]);
  });

  it('middleware manifest is required once and the same object is returned', () => {
    expect(probe.manifest).toEqual({ requires: 1, distinctObjects: 1, hasMiddlewareKey: true });
  });

  it('node middleware: both requires happen once, the same module comes back', () => {
    expect(probe.nodeMiddleware).toEqual({
      functionsConfigRequires: 1,
      middlewareRequires: 1,
      distinctObjects: 1,
      marker: 'middleware',
    });
  });

  it('no node middleware: the "none" outcome is remembered too', () => {
    expect(probe.noNodeMiddleware).toEqual({ functionsConfigRequires: 1, allUndefined: true });
  });

  it('API route module is required once and its handler runs on every request', () => {
    expect(probe.apiRoute).toEqual({ requires: 1, handlerCalls: 3 });
  });

  it('page module is required once and the same exports come back', () => {
    expect(probe.page).toEqual({ requires: 1, distinctObjects: 1, marker: 'page' });
  });

  // Invariant guards, not regression coverage: the unpatched code also requires on every call
  // in dev. They fail if the memo is widened to dev, where Next clears the require cache on
  // every edit and a remembered module would serve stale code.
  it('dev still re-requires the middleware manifest on every call', () => {
    expect(probe.manifestDev.requires).toBe(3);
  });

  it('dev still re-requires the node middleware on every call', () => {
    expect(probe.nodeMiddlewareDev.middlewareRequires).toBe(3);
  });
});

describe('the Next.js patch targets the installed version', () => {
  const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));

  it('installed next matches the version the patch is keyed to', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      pnpm: { patchedDependencies: Record<string, string> };
    };
    const key = Object.keys(pkg.pnpm.patchedDependencies).find((k) => k.startsWith('next@'));
    const installed = (requireFromRepo('next/package.json') as { version: string }).version;
    expect(key).toBe(`next@${installed}`);
  });

  // The locale-redirect site sits inside the router server's request closure, which cannot be
  // reached without booting a server, so this one is pinned by the patched source line.
  it('router server resolves the locale-redirect helper once', () => {
    const routerServer = readFileSync(
      requireFromRepo.resolve('next/dist/server/lib/router-server.js'),
      'utf8'
    );
    expect(routerServer).toContain(
      "getLocaleRedirectModule ??= require('../../shared/lib/i18n/get-locale-redirect')"
    );
  });
});
