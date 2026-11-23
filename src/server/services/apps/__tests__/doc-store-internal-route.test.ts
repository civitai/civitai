import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it } from 'vitest';
import {
  APP_DATA_SIG_HEADER,
  APP_DATA_TS_HEADER,
  appDataCanonicalString,
  appDataRegionLine,
  EMPTY_BODY_SHA256,
  sha256Hex,
  signAppDataRequest,
  verifyAppDataSignature,
  withAppDataSignature,
} from '~/server/services/apps/app-data-signature';

/**
 * The caller signature of the document store's internal route (apps/app-data-go/WRITES-DESIGN.md,
 * "The internal route", steps 1 to 3), and the ledger of the entries into the storage chain.
 * The chain behind the signature (the region gate, the block-token middleware, the handler, the
 * store) is driven end to end in `doc-store-api.unchanged-writes.test.ts`.
 */

const REPO_SRC = path.resolve(__dirname, '../../../..');
const REPO_ROOT = path.resolve(REPO_SRC, '..');

// The golden vectors, ONE file read by this test and by app-data-go's Go test
// (`apps/app-data-go/internal/sign`). Computed with Python's hmac (and one cross-checked with
// `openssl dgst -sha256 -hmac`), never by either implementation.
type Vector = {
  name: string;
  key: string;
  method: string;
  path: string;
  query: string;
  timestamp: string;
  region: Record<string, string>;
  regionLine: string;
  body: string;
  bodySha256: string;
  canonical: string;
  signature: string;
};
const VECTORS: Vector[] = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'apps/app-data-go/internal/sign/testdata/vectors.json'), 'utf8')
).vectors;

const partsOf = (v: Vector) => ({
  method: v.method,
  path: v.path,
  query: v.query,
  timestamp: v.timestamp,
  body: Buffer.from(v.body, 'utf8'),
  region: v.regionLine,
});

const GOLDEN = VECTORS[0];
const NOW = Number(GOLDEN.timestamp);

describe('the signature scheme', () => {
  it('reads the shared vectors: a body, an empty body, and a region line (positive control)', () => {
    expect(VECTORS.map((v) => v.name)).toEqual([
      'put-with-body',
      'delete-empty-body',
      'post-with-region',
    ]);
    expect(VECTORS.some((v) => v.body === '')).toBe(true);
    expect(VECTORS.some((v) => v.regionLine !== '')).toBe(true);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))(
    'matches the golden vector %s, line by line',
    (_name, v) => {
      expect(appDataRegionLine(v.region)).toBe(v.regionLine);
      expect(sha256Hex(Buffer.from(v.body, 'utf8'))).toBe(v.bodySha256);
      expect(appDataCanonicalString(partsOf(v))).toBe(v.canonical);
      expect(signAppDataRequest(v.key, partsOf(v))).toBe(v.signature);
    }
  );

  it('hashes an empty body as the SHA-256 of zero bytes', () => {
    expect(EMPTY_BODY_SHA256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(sha256Hex(Buffer.alloc(0))).toBe(EMPTY_BODY_SHA256);
    expect(
      appDataCanonicalString({ ...partsOf(GOLDEN), body: Buffer.alloc(0) }).split('\n')[4]
    ).toBe(EMPTY_BODY_SHA256);
  });

  it('builds the region line from the three headers, in order, empty when none', () => {
    expect(appDataRegionLine({})).toBe('');
    expect(appDataRegionLine({ 'cf-ipcountry': 'DE' })).toBe('DE,,');
    expect(appDataRegionLine({ 'x-isuk': 'true' })).toBe(',,true');
    expect(appDataRegionLine({ 'cf-ipcountry': 'US', 'cf-region-code': 'NY', 'x-isuk': '0' })).toBe(
      'US,NY,0'
    );
    // Unrelated headers are not part of it.
    expect(appDataRegionLine({ 'cf-connecting-ip': '1', host: 'h' })).toBe('');
    // A repeated or out-of-grammar value cannot have been signed by app-data-go.
    expect(appDataRegionLine({ 'cf-ipcountry': ['US', 'GB'] })).toBeNull();
    expect(appDataRegionLine({ 'cf-ipcountry': 'US,GB' })).toBeNull();
    expect(appDataRegionLine({ 'cf-region-code': '' })).toBeNull();
    expect(appDataRegionLine({ 'cf-ipcountry': 'x'.repeat(17) })).toBeNull();
  });

  const verify = (over: Partial<Parameters<typeof verifyAppDataSignature>[0]>) =>
    verifyAppDataSignature({
      key: GOLDEN.key,
      method: GOLDEN.method,
      rawUrl: `${GOLDEN.path}?${GOLDEN.query}`,
      timestamp: GOLDEN.timestamp,
      signature: GOLDEN.signature,
      body: Buffer.from(GOLDEN.body),
      region: GOLDEN.regionLine,
      nowSeconds: NOW,
      ...over,
    });

  it('accepts the signed request', () => {
    expect(verify({})).toEqual({ ok: true });
  });

  it('accepts a timestamp exactly 60 s either side, refuses 61 s', () => {
    expect(verify({ nowSeconds: NOW + 60 })).toEqual({ ok: true });
    expect(verify({ nowSeconds: NOW - 60 })).toEqual({ ok: true });
    expect(verify({ nowSeconds: NOW + 61 })).toEqual({ ok: false, reason: 'stale' });
    expect(verify({ nowSeconds: NOW - 61 })).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses a wrong method, path or query, a changed body, a wrong key', () => {
    expect(verify({ method: 'POST' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verify({ rawUrl: `/api/internal/blocks/storage/kv/run-02?${GOLDEN.query}` })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verify({ rawUrl: `${GOLDEN.path}?from=other-app` })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    // The query is signed raw: an encoding of the same value is a different request.
    expect(verify({ rawUrl: `${GOLDEN.path}?from=model%2Dbenchmarking` })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verify({ rawUrl: GOLDEN.path })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verify({ body: Buffer.from('{"data":{"n":2},"ifVersion":0}') })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verify({ body: Buffer.alloc(0) })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verify({ key: 'test-signing-key-0002-0123456789ab' })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('refuses a region line other than the signed one, and a malformed region', () => {
    const v = VECTORS[2];
    const base = {
      key: v.key,
      method: v.method,
      rawUrl: `${v.path}?${v.query}`,
      timestamp: v.timestamp,
      signature: v.signature,
      body: Buffer.from(v.body),
      nowSeconds: Number(v.timestamp),
    };
    expect(verifyAppDataSignature({ ...base, region: v.regionLine })).toEqual({ ok: true });
    expect(verifyAppDataSignature({ ...base, region: 'GB,CA,' })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyAppDataSignature({ ...base, region: '' })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyAppDataSignature({ ...base, region: null })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('verifies the empty-body vector', () => {
    const v = VECTORS[1];
    expect(
      verifyAppDataSignature({
        key: v.key,
        method: v.method,
        rawUrl: `${v.path}?${v.query}`,
        timestamp: v.timestamp,
        signature: v.signature,
        body: Buffer.alloc(0),
        region: '',
        nowSeconds: Number(v.timestamp),
      })
    ).toEqual({ ok: true });
  });

  it('refuses missing and malformed headers before any HMAC', () => {
    expect(verify({ signature: undefined })).toEqual({ ok: false, reason: 'missing' });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing' });
    expect(verify({ timestamp: '17950000.5' })).toEqual({ ok: false, reason: 'malformed' });
    expect(verify({ signature: GOLDEN.signature.toUpperCase() })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verify({ signature: GOLDEN.signature.slice(2) })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

// ---------------------------------------------------------------------------
// The route front: 404 unset, 401 before the chain, the gate, the body re-injected, req.url
// ---------------------------------------------------------------------------

type Seen = { url: string | undefined; body: string; claims: unknown };

/** A stand-in for the chain behind the signature: records what it was handed. */
function recorder() {
  const seen: Seen[] = [];
  const handler = async (req: NextApiRequest, res: NextApiResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req as unknown as AsyncIterable<Buffer>) chunks.push(c);
    seen.push({
      url: req.url,
      body: Buffer.concat(chunks).toString('utf8'),
      claims: (req as { blockClaims?: unknown }).blockClaims,
    });
    res.status(299).json({ reached: true });
  };
  return { seen, handler };
}

const KEY = GOLDEN.key;

function front(
  handler: ReturnType<typeof recorder>['handler'],
  key: string | undefined,
  gate?: (req: NextApiRequest, res: NextApiResponse) => boolean
) {
  return withAppDataSignature(handler, {
    signingKey: () => key,
    internalPrefix: '/api/internal/blocks/storage',
    publicPrefix: '/api/v1/blocks/storage',
    bodyLimit: 64,
    now: () => NOW,
    gate,
  });
}

async function send(
  route: ReturnType<typeof front>,
  opts: { method: string; url: string; body?: string; headers?: Record<string, string> }
) {
  const req = Object.assign(Readable.from(opts.body ? [Buffer.from(opts.body)] : []), {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
  }) as unknown as NextApiRequest;
  let status = 0;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    destroyed: false,
    writableEnded: false,
  };
  await route(req, res as unknown as NextApiResponse);
  return { status, body };
}

function signed(
  method: string,
  url: string,
  body: string,
  opts: { key?: string; region?: Record<string, string> } = {}
) {
  const q = url.indexOf('?');
  const region = opts.region ?? {};
  return {
    ...region,
    [APP_DATA_TS_HEADER]: String(NOW),
    [APP_DATA_SIG_HEADER]: signAppDataRequest(opts.key ?? KEY, {
      method,
      path: q < 0 ? url : url.slice(0, q),
      query: q < 0 ? '' : url.slice(q + 1),
      timestamp: String(NOW),
      body: Buffer.from(body),
      region: appDataRegionLine(region) ?? '',
    }),
  };
}

const SIGNATURE_REFUSED = {
  status: 401,
  body: {
    code: 'service_signature',
    message: 'invalid service signature',
    error: 'invalid service signature',
  },
};

describe('withAppDataSignature', () => {
  const URL = '/api/internal/blocks/storage/kv/run-04?from=model-benchmarking';
  const BODY = '{"data":{"n":5}}';

  it('answers 404 service_route_off while the key is unset, even for a signed request', async () => {
    for (const key of [undefined, '']) {
      const { seen, handler } = recorder();
      const r = await send(front(handler, key), {
        method: 'PUT',
        url: URL,
        body: BODY,
        headers: signed('PUT', URL, BODY),
      });
      expect(r).toEqual({
        status: 404,
        body: {
          code: 'service_route_off',
          message: 'the internal storage route is not configured',
          error: 'the internal storage route is not configured',
        },
      });
      expect(seen).toEqual([]);
    }
  });

  it('refuses an unsigned, a wrongly signed and a body-swapped request 401 service_signature, reaching nothing', async () => {
    const { seen, handler } = recorder();
    const route = front(handler, KEY);
    expect(await send(route, { method: 'PUT', url: URL, body: BODY })).toEqual(SIGNATURE_REFUSED);
    expect(
      await send(route, {
        method: 'PUT',
        url: URL,
        body: BODY,
        headers: signed('PUT', URL, BODY, { key: 'test-signing-key-0003-0123456789ab' }),
      })
    ).toEqual(SIGNATURE_REFUSED);
    expect(
      await send(route, {
        method: 'PUT',
        url: URL,
        body: '{"data":{"n":6}}',
        headers: signed('PUT', URL, BODY),
      })
    ).toEqual(SIGNATURE_REFUSED);
    // Signed for a DELETE, sent as a PUT.
    expect(
      await send(route, {
        method: 'PUT',
        url: URL,
        body: BODY,
        headers: signed('DELETE', URL, BODY),
      })
    ).toEqual(SIGNATURE_REFUSED);
    expect(seen).toEqual([]);
  });

  it('refuses a region header changed after signing, or added, as a signature mismatch', async () => {
    const { seen, handler } = recorder();
    const route = front(handler, KEY);
    const asSigned = signed('PUT', URL, BODY, { region: { 'cf-ipcountry': 'GB' } });
    expect(
      await send(route, {
        method: 'PUT',
        url: URL,
        body: BODY,
        headers: { ...asSigned, 'cf-ipcountry': 'US' },
      })
    ).toEqual(SIGNATURE_REFUSED);
    expect(
      await send(route, {
        method: 'PUT',
        url: URL,
        body: BODY,
        headers: { ...signed('PUT', URL, BODY), 'x-isuk': 'true' },
      })
    ).toEqual(SIGNATURE_REFUSED);
    expect(seen).toEqual([]);
    // Positive control: the same request with the region it was signed with is served.
    expect(
      (await send(route, { method: 'PUT', url: URL, body: BODY, headers: asSigned })).status
    ).toBe(299);
  });

  it('runs the gate after the signature and before the chain; a refusing gate stops it', async () => {
    const { seen, handler } = recorder();
    const gated: string[] = [];
    const route = front(handler, KEY, (req, res) => {
      gated.push(String(req.headers['cf-ipcountry']));
      if (req.headers['cf-ipcountry'] !== 'GB') return false;
      res.status(451).json({ code: 'gated' });
      return true;
    });
    // Unsigned: refused before the gate.
    expect(await send(route, { method: 'PUT', url: URL, body: BODY })).toEqual(SIGNATURE_REFUSED);
    expect(gated).toEqual([]);
    const gb = signed('PUT', URL, BODY, { region: { 'cf-ipcountry': 'GB' } });
    expect(await send(route, { method: 'PUT', url: URL, body: BODY, headers: gb })).toEqual({
      status: 451,
      body: { code: 'gated' },
    });
    const us = signed('PUT', URL, BODY, { region: { 'cf-ipcountry': 'US' } });
    expect((await send(route, { method: 'PUT', url: URL, body: BODY, headers: us })).status).toBe(
      299
    );
    expect(gated).toEqual(['GB', 'US']);
    expect(seen).toHaveLength(1);
  });

  it('answers an oversized body 413 in the storage envelope, reaching nothing', async () => {
    const { seen, handler } = recorder();
    const big = `{"data":{"s":"${'x'.repeat(80)}"}}`;
    const r = await send(front(handler, KEY), {
      method: 'PUT',
      url: URL,
      body: big,
      headers: signed('PUT', URL, big),
    });
    expect(r.status).toBe(413);
    expect((r.body as { code: string }).code).toBe('too_large');
    expect(seen).toEqual([]);
  });

  it('hands the chain the public path and query, the signed bytes, and no claims', async () => {
    const { seen, handler } = recorder();
    const r = await send(front(handler, KEY), {
      method: 'PUT',
      url: URL,
      body: BODY,
      headers: signed('PUT', URL, BODY),
    });
    expect(r).toEqual({ status: 299, body: { reached: true } });
    expect(seen).toEqual([
      {
        url: '/api/v1/blocks/storage/kv/run-04?from=model-benchmarking',
        body: BODY,
        claims: undefined,
      },
    ]);
  });

  it('serves the bare prefix (info) and answers 404 not_found for a path outside it', async () => {
    const { seen, handler } = recorder();
    const route = front(handler, KEY);
    const info = '/api/internal/blocks/storage?from=model-benchmarking';
    expect(
      (await send(route, { method: 'GET', url: info, headers: signed('GET', info, '') })).status
    ).toBe(299);
    const outside = '/api/internal/blocks/storagex/kv?from=model-benchmarking';
    const r = await send(route, {
      method: 'GET',
      url: outside,
      headers: signed('GET', outside, ''),
    });
    expect(r.status).toBe(404);
    expect((r.body as { code: string }).code).toBe('not_found');
    expect(seen.map((s) => s.url)).toEqual(['/api/v1/blocks/storage?from=model-benchmarking']);
  });
});

// ---------------------------------------------------------------------------
// The ledger: the entries into the storage chain (WRITES-DESIGN.md, "The internal route")
// ---------------------------------------------------------------------------

function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        if (abs === path.join(REPO_SRC, 'tests')) continue;
        walk(abs);
      } else if (/\.(t|j)sx?$/.test(entry.name) && !/\.test\.(t|j)sx?$/.test(entry.name)) {
        out.push(abs);
      }
    }
  };
  walk(REPO_SRC);
  return out;
}

/** Code only: block and line comments removed, so prose naming the chain is not an entry. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the entries into the storage chain', () => {
  const callers = () =>
    productionSources()
      .filter((f) => /\bcreateStorageHandler\s*\(/.test(code(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(REPO_SRC, f).split(path.sep).join('/'))
      .filter((rel) => rel !== 'server/services/apps/doc-store-api.ts')
      .sort();

  it('are exactly the public route and the internal route, each the full chain', () => {
    // The OPTIONS the two pass the block-token middleware are compared as values in
    // `src/tests/api/v1/blocks/scoped-endpoints-cors-wiring.test.ts`.
    const found = callers();
    expect(found).toEqual([
      'pages/api/v1/blocks/storage/[[...path]].ts',
      'server/services/apps/doc-store-internal-route.ts',
    ]);
    for (const rel of found) {
      expect(code(readFileSync(path.join(REPO_SRC, rel), 'utf8')), rel).toMatch(
        /withBlockScope\(withAxiom\(createStorageHandler\(/
      );
    }
  });

  it('the internal page serves the internal chain and nothing else', () => {
    const page = code(
      readFileSync(path.join(REPO_SRC, 'pages/api/internal/blocks/storage/[[...path]].ts'), 'utf8')
    );
    expect(page).toMatch(/export default internalStorageRoute;/);
    expect(page).not.toMatch(/createStorageHandler|withBlockScope/);
  });

  it('positive control: the scan sees the handler module itself', () => {
    expect(
      productionSources().some((f) =>
        f.endsWith(path.join('server', 'services', 'apps', 'doc-store-api.ts'))
      )
    ).toBe(true);
  });
});
