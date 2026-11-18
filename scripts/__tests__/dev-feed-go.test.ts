import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The `pnpm dev` feed-go launcher's pieces (plain .mjs, run by node, never bundled), imported by
// path as the dev-server tests do.
import {
  assetName,
  buildFeedGoEnv,
  createFeedGoProxy,
  expectedSha256,
  mergeFliptOverrides,
  missingRequired,
  nextPort,
  parseVersion,
  readAppEnv,
  releaseUrls,
  resolveBinary,
  resolveMode,
  verifyChecksum,
} from '../dev-feed-go/lib.mjs';

const REPO = join(__dirname, '../..');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dev-feed-go-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('version resolution', () => {
  it('reads the x.y.z version', () => {
    expect(parseVersion('{"name":"@civitai/feed-go","version":"3.14.159"}')).toBe('3.14.159');
  });
  it('refuses a missing or non-x.y.z version', () => {
    expect(() => parseVersion('{"name":"x"}')).toThrow(/no x\.y\.z version/);
    expect(() => parseVersion('{"version":"latest"}')).toThrow(/no x\.y\.z version/);
    expect(() => parseVersion('{"version":"1.2.3-rc1"}')).toThrow(/no x\.y\.z version/);
  });
  it('resolves the real apps/feed-go/package.json (the pin release-app.mjs bumps)', () => {
    const v = parseVersion(readFileSync(join(REPO, 'apps/feed-go/package.json'), 'utf8'));
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('platform/arch → release asset', () => {
  it('maps each built target to its own literal asset name', () => {
    expect(assetName('1.2.3', 'linux', 'x64')).toBe('feed-go-v1.2.3-linux-amd64');
    expect(assetName('1.2.3', 'linux', 'arm64')).toBe('feed-go-v1.2.3-linux-arm64');
    expect(assetName('1.2.3', 'darwin', 'x64')).toBe('feed-go-v1.2.3-darwin-amd64');
    expect(assetName('1.2.3', 'darwin', 'arm64')).toBe('feed-go-v1.2.3-darwin-arm64');
  });
  it('has no asset for a target the release does not build', () => {
    expect(assetName('1.2.3', 'win32', 'x64')).toBeNull();
    expect(assetName('1.2.3', 'linux', 'ia32')).toBeNull();
    expect(assetName('1.2.3', 'freebsd', 'x64')).toBeNull();
  });
  it('downloads from the public release of the feed-go-v<version> tag', () => {
    expect(releaseUrls('1.2.3', 'feed-go-v1.2.3-linux-amd64')).toEqual({
      binary:
        'https://github.com/civitai/civitai/releases/download/feed-go-v1.2.3/feed-go-v1.2.3-linux-amd64',
      sums: 'https://github.com/civitai/civitai/releases/download/feed-go-v1.2.3/SHA256SUMS',
    });
  });
  it('the release workflow builds every asset name the launcher can ask for', () => {
    // Seam with .github/workflows/feed-go-release.yml: its output name and its target list.
    const wf = readFileSync(join(REPO, '.github/workflows/feed-go-release.yml'), 'utf8');
    expect(wf).toContain('dist/feed-go-v${VERSION}-${goos}-${goarch}');
    for (const target of ['linux/amd64', 'linux/arm64', 'darwin/amd64', 'darwin/arm64']) {
      expect(wf).toContain(target);
    }
    expect(wf).toContain('sha256sum feed-go-v* > SHA256SUMS');
  });
});

describe('checksum verification', () => {
  const asset = 'feed-go-v1.2.3-linux-amd64';
  const good = Buffer.from('the real binary');
  const sums = `${sha('other')}  feed-go-v1.2.3-darwin-arm64\n${sha(good)}  ${asset}\n`;

  it('accepts the bytes SHA256SUMS lists for the asset', () => {
    expect(verifyChecksum(good, sums, asset)).toEqual({ ok: true });
  });
  it('refuses tampered bytes', () => {
    expect(verifyChecksum(Buffer.from('the real binarY'), sums, asset)).toEqual({
      ok: false,
      reason: `checksum mismatch for ${asset}`,
    });
  });
  it('refuses an asset SHA256SUMS does not list (never a pass by absence)', () => {
    expect(verifyChecksum(good, sums, 'feed-go-v1.2.3-linux-arm64').ok).toBe(false);
    expect(verifyChecksum(good, '', asset).ok).toBe(false);
  });
  it('reads both sha256sum line forms and picks the named asset, not the first line', () => {
    expect(expectedSha256(`${sha('a')} *x\n${sha('b')}  y\n`, 'x')).toBe(sha('a'));
    expect(expectedSha256(`${sha('a')} *x\n${sha('b')}  y\n`, 'y')).toBe(sha('b'));
  });
});

describe('resolveBinary', () => {
  const version = '1.2.3';
  const asset = 'feed-go-v1.2.3-linux-amd64';
  const bin = Buffer.from('#!/bin/sh\necho feed-go\n');

  function fakeFetch(files: Record<string, Buffer | string | number>) {
    return vi.fn(async (url: string, _init?: RequestInit) => {
      const name = url.split('/').pop()!;
      const body = files[name];
      if (body === undefined || typeof body === 'number') {
        return new Response('nope', { status: typeof body === 'number' ? body : 404 });
      }
      return new Response(typeof body === 'string' ? body : new Uint8Array(body));
    });
  }

  it('downloads, verifies and caches the binary, executable, then serves it from the cache', async () => {
    const cacheDir = tmp();
    const fetchImpl = fakeFetch({ [asset]: bin, SHA256SUMS: `${sha(bin)}  ${asset}\n` });
    const first = await resolveBinary({
      version,
      platform: 'linux',
      arch: 'x64',
      cacheDir,
      fetchImpl,
    });
    expect(first).toEqual({ ok: true, path: join(cacheDir, '1.2.3', asset), source: 'download' });
    expect(readFileSync(first.path!)).toEqual(bin);
    expect(statSync(first.path!).mode & 0o111).not.toBe(0);
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([
      'https://github.com/civitai/civitai/releases/download/feed-go-v1.2.3/SHA256SUMS',
      `https://github.com/civitai/civitai/releases/download/feed-go-v1.2.3/${asset}`,
    ]);

    const second = await resolveBinary({
      version,
      platform: 'linux',
      arch: 'x64',
      cacheDir,
      fetchImpl,
    });
    expect(second).toEqual({ ok: true, path: first.path, source: 'cache' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a tampered download and writes nothing', async () => {
    const cacheDir = tmp();
    const fetchImpl = fakeFetch({
      [asset]: Buffer.from('#!/bin/sh\necho pwned\n'),
      SHA256SUMS: `${sha(bin)}  ${asset}\n`,
    });
    const r = await resolveBinary({ version, platform: 'linux', arch: 'x64', cacheDir, fetchImpl });
    expect(r).toEqual({ ok: false, reason: `checksum mismatch for ${asset}; refusing to run it` });
    expect(existsSync(join(cacheDir, '1.2.3', asset))).toBe(false);
  });

  it('re-downloads when the cached binary no longer matches its sums', async () => {
    const cacheDir = tmp();
    const fetchImpl = fakeFetch({ [asset]: bin, SHA256SUMS: `${sha(bin)}  ${asset}\n` });
    const first = await resolveBinary({
      version,
      platform: 'linux',
      arch: 'x64',
      cacheDir,
      fetchImpl,
    });
    writeFileSync(first.path!, 'corrupted');
    const again = await resolveBinary({
      version,
      platform: 'linux',
      arch: 'x64',
      cacheDir,
      fetchImpl,
    });
    expect(again).toMatchObject({ ok: true, source: 'download' });
    expect(readFileSync(again.path!)).toEqual(bin);
  });

  it('reports a failed download (no release yet) instead of throwing', async () => {
    const cacheDir = tmp();
    const fetchImpl = fakeFetch({ SHA256SUMS: 404 });
    const r = await resolveBinary({ version, platform: 'linux', arch: 'x64', cacheDir, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^download of feed-go-v1\.2\.3 failed: HTTP 404/);
  });

  it('does not fetch at all for a platform without an asset', async () => {
    const fetchImpl = fakeFetch({});
    const r = await resolveBinary({
      version,
      platform: 'win32',
      arch: 'x64',
      cacheDir: tmp(),
      fetchImpl,
    });
    expect(r).toEqual({ ok: false, reason: 'no prebuilt feed-go for win32/x64' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('FEED_GO_LOCAL', () => {
  it('defaults to auto', () => {
    expect(resolveMode(undefined)).toEqual({ mode: 'auto' });
    expect(resolveMode('')).toEqual({ mode: 'auto' });
    expect(resolveMode('auto')).toEqual({ mode: 'auto' });
  });
  it('opts out with off (and its spellings)', () => {
    expect(resolveMode('off')).toEqual({ mode: 'off' });
    expect(resolveMode('OFF')).toEqual({ mode: 'off' });
    expect(resolveMode('false')).toEqual({ mode: 'off' });
    expect(resolveMode('0')).toEqual({ mode: 'off' });
  });
  it('selects binary or source', () => {
    expect(resolveMode('binary')).toEqual({ mode: 'binary' });
    expect(resolveMode('source')).toEqual({ mode: 'source' });
  });
  it('treats an unknown value as off, with a warning', () => {
    expect(resolveMode('of')).toEqual({
      mode: 'off',
      warning: 'unknown FEED_GO_LOCAL=of (auto|binary|source|off)',
    });
  });
});

describe('feed-go env mapping', () => {
  const listeners = {
    addr: '127.0.0.1:41001',
    internalAddr: '127.0.0.1:41002',
    fallbackUrl: 'http://localhost:3007',
  };
  const appEnv = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    DATABASE_URL: 'postgres://primary/civitai',
    DATABASE_REPLICA_URL: 'postgres://replica/civitai',
    DATAPACKET_DATABASE_RO_URL: 'postgres://other/postgres',
    REDIS_URL: 'redis://cache',
    REDIS_SYS_URL: 'redis://sys',
    AUTH_JWT_ISSUER: 'http://localhost:5173',
    AUTH_JWKS_URI: 'http://localhost:5173/.well-known/jwks.json',
    NEXTAUTH_URL: 'http://localhost:3007',
    SERVER_DOMAIN_BLUE: 'localhost',
    FEED_GO_SERVE_MODEL_GETALL: 'true',
    FEED_GO_FALLBACK_URL: 'http://somewhere-else',
    FEED_GO_ADDR: ':80',
    FEED_GO_LOCAL: 'auto',
    // Unrelated secrets the app env carries; none may reach feed-go.
    NEXTAUTH_SECRET: 's1',
    AUTH_INTERNAL_TOKEN: 's2',
    STRIPE_SECRET_KEY: 's3',
    S3_UPLOAD_SECRET: 's4',
    CLICKHOUSE_PASSWORD: 's5',
    OPENAI_API_KEY: 's6',
    AUTH_JWT_PRIVATE_KEY: 's7',
  };

  it('is exactly the allow-listed keys, with the launcher owning listeners and fallback', () => {
    expect(buildFeedGoEnv(appEnv, listeners)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      DATABASE_REPLICA_URL: 'postgres://replica/civitai',
      REDIS_URL: 'redis://cache',
      REDIS_SYS_URL: 'redis://sys',
      REDIS_CLUSTER: 'false',
      AUTH_JWT_ISSUER: 'http://localhost:5173',
      AUTH_JWKS_URI: 'http://localhost:5173/.well-known/jwks.json',
      NEXTAUTH_URL: 'http://localhost:3007',
      SERVER_DOMAIN_BLUE: 'localhost',
      FEED_GO_SERVE_MODEL_GETALL: 'true',
      FEED_GO_ADDR: '127.0.0.1:41001',
      FEED_GO_INTERNAL_ADDR: '127.0.0.1:41002',
      FEED_GO_FALLBACK_URL: 'http://localhost:3007',
    });
  });

  it('never carries an unrelated secret value', () => {
    const values = Object.values(buildFeedGoEnv(appEnv, listeners));
    for (const secret of ['s1', 's2', 's3', 's4', 's5', 's6', 's7']) {
      expect(values).not.toContain(secret);
    }
  });

  it('reads the replica from DATABASE_URL when no replica is set; the primary only with write-back', () => {
    const { DATABASE_REPLICA_URL: _r, ...noReplica } = appEnv;
    const env = buildFeedGoEnv(noReplica, listeners);
    expect(env.DATABASE_REPLICA_URL).toBe('postgres://primary/civitai');
    expect(env).not.toHaveProperty('DATABASE_URL');
    const wb = buildFeedGoEnv({ ...appEnv, FEED_GO_CACHE_WRITEBACK: 'true' }, listeners);
    expect(wb.DATABASE_URL).toBe('postgres://primary/civitai');
  });

  it("passes the app's REDIS_CLUSTER meaning (default false; feed-go's own default is true)", () => {
    expect(buildFeedGoEnv({ ...appEnv, REDIS_CLUSTER: 'true' }, listeners).REDIS_CLUSTER).toBe(
      'true'
    );
    expect(buildFeedGoEnv({ ...appEnv, REDIS_CLUSTER: 'nope' }, listeners).REDIS_CLUSTER).toBe(
      'false'
    );
  });

  it('names (never values) what feed-go needs and the app env lacks', () => {
    expect(missingRequired(buildFeedGoEnv(appEnv, listeners))).toEqual([]);
    const { AUTH_JWKS_URI: _j, REDIS_SYS_URL: _s, ...partial } = appEnv;
    expect(missingRequired(buildFeedGoEnv(partial, listeners))).toEqual([
      'REDIS_SYS_URL',
      'AUTH_JWKS_URI',
    ]);
  });
});

describe("the app's env as next dev reads it", () => {
  it('real env beats .env.development, which beats .env', () => {
    const root = tmp();
    writeFileSync(join(root, '.env'), 'A=from-env\nB=from-env\nC=from-env\n');
    writeFileSync(join(root, '.env.development'), 'B=from-dev\nC=from-dev\n');
    expect(readAppEnv(root, { C: 'from-process' })).toEqual({
      A: 'from-env',
      B: 'from-dev',
      C: 'from-process',
    });
  });
});

describe('FLIPT_LOCAL_OVERRIDES for the Go-transport flags', () => {
  it('turns both on when unset', () => {
    expect(mergeFliptOverrides(undefined)).toBe(
      'feed-go-transport=on,feed-go-transport-model-getall=on'
    );
  });
  it("keeps the developer's other keys and their own value for ours", () => {
    expect(mergeFliptOverrides('x=on, feed-go-transport=off')).toBe(
      'x=on,feed-go-transport=off,feed-go-transport-model-getall=on'
    );
  });
});

describe("Next's port", () => {
  it('reads -p / --port / --port=, then PORT, then 3000', () => {
    expect(nextPort(['-p', '4001'], { PORT: '5000' })).toBe(4001);
    expect(nextPort(['--port', '4002'], {})).toBe(4002);
    expect(nextPort(['--turbo', '--port=4003'], {})).toBe(4003);
    expect(nextPort([], { PORT: '4004' })).toBe(4004);
    expect(nextPort([], {})).toBe(3000);
  });
});

describe('the /api/trpc-go dev proxy', () => {
  type Hit = { who: string; path: string; host: string };
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((d) => s.close(d))));
  });
  const listen = async (s: http.Server) => {
    servers.push(s);
    await new Promise<void>((d) => s.listen(0, '127.0.0.1', () => d()));
    return (s.address() as AddressInfo).port;
  };
  const upstream = async (who: string, hits: Hit[]) =>
    listen(
      http.createServer((req, res) => {
        hits.push({ who, path: req.url!, host: req.headers.host! });
        res.end(who);
      })
    );
  const get = (port: number, path: string) =>
    new Promise<string>((done, fail) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path,
            headers: { 'x-forwarded-host': 'civitai-dev.blue:3000' },
          },
          (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => done(body));
          }
        )
        .on('error', fail);
    });
  const PATH = '/api/trpc/image.getImagesAsPostsInfinite?input=%7B%7D';

  it('sends to feed-go while it is healthy, with the browser host restored', async () => {
    const hits: Hit[] = [];
    const nextPort = await upstream('next', hits);
    const goPort = await upstream('feed-go', hits);
    const proxyPort = await listen(
      createFeedGoProxy({
        next: { host: '127.0.0.1', port: nextPort },
        feedGo: () => ({ host: '127.0.0.1', port: goPort }),
      })
    );
    expect(await get(proxyPort, PATH)).toBe('feed-go');
    expect(hits).toEqual([{ who: 'feed-go', path: PATH, host: 'civitai-dev.blue:3000' }]);
  });

  it("sends to Next's own /api/trpc path when feed-go is not up (today's behaviour)", async () => {
    const hits: Hit[] = [];
    const nextPort = await upstream('next', hits);
    const proxyPort = await listen(
      createFeedGoProxy({ next: { host: '127.0.0.1', port: nextPort }, feedGo: () => null })
    );
    expect(await get(proxyPort, PATH)).toBe('next');
    expect(hits).toEqual([{ who: 'next', path: PATH, host: 'civitai-dev.blue:3000' }]);
  });

  it('falls back to Next when feed-go has exited (connection refused), and says so', async () => {
    const hits: Hit[] = [];
    const nextPort = await upstream('next', hits);
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await new Promise((d) => dead.close(d));
    servers.splice(servers.indexOf(dead), 1);
    const onFeedGoError = vi.fn();
    const proxyPort = await listen(
      createFeedGoProxy({
        next: { host: '127.0.0.1', port: nextPort },
        feedGo: () => ({ host: '127.0.0.1', port: deadPort }),
        onFeedGoError,
      })
    );
    expect(await get(proxyPort, PATH)).toBe('next');
    expect(hits).toEqual([{ who: 'next', path: PATH, host: 'civitai-dev.blue:3000' }]);
    expect(onFeedGoError).toHaveBeenCalledTimes(1);
  });
});
