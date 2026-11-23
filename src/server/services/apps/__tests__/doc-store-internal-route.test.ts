import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it } from 'vitest';
import {
  APP_DATA_SIG_HEADER,
  APP_DATA_TS_HEADER,
  appDataCanonicalString,
  EMPTY_BODY_SHA256,
  sha256Hex,
  signAppDataRequest,
  verifyAppDataSignature,
  withAppDataSignature,
} from '~/server/services/apps/app-data-signature';

/**
 * The caller signature of the document store's internal route (apps/app-data-go/WRITES-DESIGN.md,
 * "The internal route", steps 1 to 3), and the ledger of the entries into the storage chain.
 * The chain behind the signature (the block-token middleware, the handler, the store) is driven
 * end to end in `doc-store-api.unchanged-writes.test.ts`.
 */

// The vector app-data-go's Go test pins too (apps/app-data-go): computed with `openssl dgst
// -sha256 -hmac` and Python's hmac over the canonical string below, never by this module.
const GOLDEN = {
  key: 'test-signing-key-0001',
  method: 'PUT',
  path: '/api/internal/blocks/storage/kv/run-01',
  query: 'from=model-benchmarking',
  timestamp: '1795000000',
  body: Buffer.from('{"data":{"n":1},"ifVersion":0}'),
  bodySha256: 'f5edde14e10252c60e896284b60e1ef276ae22fcc79e5c3ada8eaedf0cda2a3e',
  signature: '47db374505acbf36f3fce466ff71b2cb1a7ab014831408122a1c52cd4a7a880d',
};
const NOW = 1_795_000_000;

describe('the signature scheme', () => {
  it('matches the golden vector, line by line', () => {
    expect(sha256Hex(GOLDEN.body)).toBe(GOLDEN.bodySha256);
    expect(appDataCanonicalString(GOLDEN)).toBe(
      `PUT\n/api/internal/blocks/storage/kv/run-01\nfrom=model-benchmarking\n1795000000\n${GOLDEN.bodySha256}`
    );
    expect(signAppDataRequest(GOLDEN.key, GOLDEN)).toBe(GOLDEN.signature);
  });

  it('hashes an empty body as the SHA-256 of zero bytes', () => {
    expect(EMPTY_BODY_SHA256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(sha256Hex(Buffer.alloc(0))).toBe(EMPTY_BODY_SHA256);
    expect(appDataCanonicalString({ ...GOLDEN, body: Buffer.alloc(0) }).split('\n')[4]).toBe(
      EMPTY_BODY_SHA256
    );
  });

  const verify = (over: Partial<Parameters<typeof verifyAppDataSignature>[0]>) =>
    verifyAppDataSignature({
      key: GOLDEN.key,
      method: GOLDEN.method,
      rawUrl: `${GOLDEN.path}?${GOLDEN.query}`,
      timestamp: GOLDEN.timestamp,
      signature: GOLDEN.signature,
      body: GOLDEN.body,
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

  it('refuses a wrong method, path or query, and a changed body', () => {
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
    expect(verify({ key: 'test-signing-key-0002' })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('verifies an empty-body request signed over the empty-body hash', () => {
    const parts = {
      method: 'DELETE',
      path: '/api/internal/blocks/storage/kv/run-03',
      query: 'from=model-benchmarking&ifVersion=4',
      timestamp: GOLDEN.timestamp,
      body: Buffer.alloc(0),
    };
    const signature = signAppDataRequest(GOLDEN.key, parts);
    expect(
      verify({
        method: 'DELETE',
        rawUrl: `${parts.path}?${parts.query}`,
        signature,
        body: Buffer.alloc(0),
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
// The route front: 404 unset, 401 before the chain, the body re-injected, req.url rewritten
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

function front(handler: ReturnType<typeof recorder>['handler'], key: string | undefined) {
  return withAppDataSignature(handler, {
    signingKey: () => key,
    internalPrefix: '/api/internal/blocks/storage',
    publicPrefix: '/api/v1/blocks/storage',
    bodyLimit: 64,
    now: () => NOW,
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

function signed(method: string, url: string, body: string, key = GOLDEN.key) {
  const q = url.indexOf('?');
  return {
    [APP_DATA_TS_HEADER]: String(NOW),
    [APP_DATA_SIG_HEADER]: signAppDataRequest(key, {
      method,
      path: q < 0 ? url : url.slice(0, q),
      query: q < 0 ? '' : url.slice(q + 1),
      timestamp: String(NOW),
      body: Buffer.from(body),
    }),
  };
}

describe('withAppDataSignature', () => {
  const URL = '/api/internal/blocks/storage/kv/run-04?from=model-benchmarking';
  const BODY = '{"data":{"n":5}}';

  it('is absent (404) while the key is unset, even for a request signed with some key', async () => {
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
          code: 'not_found',
          message: 'no such storage route',
          error: 'no such storage route',
        },
      });
      expect(seen).toEqual([]);
    }
  });

  it('refuses an unsigned, a wrongly signed and a body-swapped request with 401, reaching nothing', async () => {
    const { seen, handler } = recorder();
    const route = front(handler, GOLDEN.key);
    const refused = {
      status: 401,
      body: {
        code: 'unauthenticated',
        message: 'invalid service signature',
        error: 'invalid service signature',
      },
    };
    expect(await send(route, { method: 'PUT', url: URL, body: BODY })).toEqual(refused);
    expect(
      await send(route, {
        method: 'PUT',
        url: URL,
        body: BODY,
        headers: signed('PUT', URL, BODY, 'test-signing-key-0003'),
      })
    ).toEqual(refused);
    expect(
      await send(route, {
        method: 'PUT',
        url: URL,
        body: '{"data":{"n":6}}',
        headers: signed('PUT', URL, BODY),
      })
    ).toEqual(refused);
    // Signed for a DELETE, sent as a PUT.
    expect(
      await send(route, {
        method: 'PUT',
        url: URL,
        body: BODY,
        headers: signed('DELETE', URL, BODY),
      })
    ).toEqual(refused);
    expect(seen).toEqual([]);
  });

  it('answers an oversized body 413 in the storage envelope, reaching nothing', async () => {
    const { seen, handler } = recorder();
    const big = `{"data":{"s":"${'x'.repeat(80)}"}}`;
    const r = await send(front(handler, GOLDEN.key), {
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
    const r = await send(front(handler, GOLDEN.key), {
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

  it('serves the bare prefix (info) and refuses a path outside it', async () => {
    const { seen, handler } = recorder();
    const route = front(handler, GOLDEN.key);
    const info = '/api/internal/blocks/storage?from=model-benchmarking';
    expect(
      (await send(route, { method: 'GET', url: info, headers: signed('GET', info, '') })).status
    ).toBe(299);
    const outside = '/api/internal/blocks/storagex/kv?from=model-benchmarking';
    expect(
      (await send(route, { method: 'GET', url: outside, headers: signed('GET', outside, '') }))
        .status
    ).toBe(404);
    expect(seen.map((s) => s.url)).toEqual(['/api/v1/blocks/storage?from=model-benchmarking']);
  });
});

// ---------------------------------------------------------------------------
// The ledger: the entries into the storage chain (WRITES-DESIGN.md, "The internal route")
// ---------------------------------------------------------------------------

const REPO_SRC = path.resolve(__dirname, '../../../..');

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
