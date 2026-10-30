import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { parse as devalueParse, stringify as devalueStringify } from 'devalue';
import superjson from 'superjson';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The tRPC HTTP response WRITE format is chosen per request
 * (`src/server/trpc/response-write-format.ts`): devalue only when the pool's
 * `TRPC_WRITE_DEVALUE` switch is on, the request comes from a web bundle that can decode it,
 * and the response is not edge-cacheable. Everything else gets superjson, the only shape
 * non-web consumers (`@civitai/app-sdk`, `@civitai/blocks-react`, CLIs, scripts) and old web
 * bundles read.
 *
 * Driven end to end over a real HTTP socket: the real route (`src/pages/api/trpc/[trpc].ts`,
 * its real adapter and `responseMeta`), the real server transformer from `~/server/trpc`, and a
 * small router built from the real `publicProcedure`. Only the app router and the context are
 * replaced. Each case compares the raw response body with the exact bytes the expected
 * serializer produces for the payload, so a body in the other format cannot pass.
 */

// A Date and a Map, so the superjson output carries `meta` and the two formats differ.
const PAYLOAD = {
  id: 42,
  at: new Date('2026-01-02T03:04:05.000Z'),
  tags: new Map([['a', 1]]),
};

/** Plain objects, arrays, Dates and undefined only: the shape the fast superjson walk handles. */
const PLAIN = {
  id: 43,
  at: new Date('2026-03-04T05:06:07.000Z'),
  gone: undefined,
  items: [{ name: 'a', when: new Date(0), next: null }],
};

/** Not a POJO: devalue refuses it, which is what drives the fail-open fallback. */
class NotAPojo {
  constructor(public readonly id: number) {}
}

/**
 * The pool's `TRPC_WRITE_DEVALUE` master switch. The real value is a module-load constant; the
 * mock reads this per access, so both positions are driven on ONE loaded module graph (a
 * `vi.resetModules` reload would leave the mocked router holding the first load's transformer,
 * and a flag-off case would then pass whatever the route did).
 */
const h = vi.hoisted(() => {
  process.env.TRPC_WRITE_DEVALUE = 'true';
  return { writeDevalue: true };
});
vi.mock('~/shared/utils/trpc-union-transformer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get WRITE_DEVALUE() {
    return h.writeDevalue;
  },
}));
/**
 * The `trpc-fast-superjson-write` Flipt flag, read per access. `null` is what `isFliptSync`
 * returns for an unknown key or an uninitialized client, the state before the key exists.
 */
const flag = vi.hoisted(() => ({ fastSuperjson: null as boolean | null }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFliptSync: (key: string, ...rest: [string?, Record<string, string>?]) =>
      key === 'trpc-fast-superjson-write' ? flag.fastSuperjson : actual.isFliptSync(key, ...rest),
  };
});
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/createContext', () => ({
  createContext: ({ req, res }: { req: NextApiRequest; res: NextApiResponse }) => ({
    req,
    res,
    user: undefined,
    acceptableOrigin: true,
    features: { canViewNsfw: false },
    tokenScope: TokenScope.Full,
    // A positive edge TTL is what makes `responseMeta` emit a public Cache-Control.
    cache:
      req.headers['x-test-cacheable'] === '1'
        ? { edgeTTL: 60, browserTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false }
        : { edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0, canCache: false, skip: false },
  }),
}));
vi.mock('~/server/routers', async () => {
  const { router, publicProcedure } = await import('~/server/trpc');
  return {
    appRouter: router({
      payload: publicProcedure.query(() => PAYLOAD),
      plain: publicProcedure.query(() => PLAIN),
      notAPojo: publicProcedure.query(() => new NotAPojo(7)),
      // A block-token query path (BLOCK_TOKEN_QUERY_PROCEDURES): always answered `no-store`.
      blocks: router({ listMyWorkflows: publicProcedure.query(() => PAYLOAD) }),
    }),
  };
});

type Served = { status: number; headers: Headers; text: string };

let server: http.Server | undefined;
let baseUrl = '';

beforeAll(async () => {
  const route = (await import('~/pages/api/trpc/[trpc]')).default as NextApiHandler;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Next populates `req.query` (the `[trpc]` segment plus search params) before the route runs.
    (req as unknown as NextApiRequest).query = {
      ...Object.fromEntries(url.searchParams),
      trpc: decodeURIComponent(url.pathname.replace('/api/trpc/', '')),
    };
    void route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const CAPABLE_WEB = { 'x-client': 'web', 'x-client-version': '5.0.2081' };

async function get(path: string, headers: Record<string, string> = {}): Promise<Served> {
  const res = await fetch(`${baseUrl}/api/trpc/${path}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** A one-call batch on the streamed (jsonl) path, the way `httpBatchStreamLink` sends it. */
function streamed(headers: Record<string, string>): Promise<Served> {
  return get(`payload?batch=1&input=${encodeURIComponent('{}')}`, {
    ...headers,
    'trpc-accept': 'application/jsonl',
  });
}

/** Each line of a jsonl response, JSON-parsed: the transformer output for one chunk. */
function streamedChunks(served: Served): unknown[] {
  expect(served.status).toBe(200);
  return served.text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** Whether `PAYLOAD` appears, decoded with its rich types intact, anywhere in `value`. */
function containsPayload(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  // `toEqual`, not `isDeepStrictEqual`: the stream builds its chunks as null-prototype objects.
  try {
    expect(value).toEqual(PAYLOAD);
    return true;
  } catch {
    return Object.values(value as Record<string, unknown>).some(containsPayload);
  }
}

/** The transformer output in a single (unbatched) query response. */
function singleData(served: Served): unknown {
  expect(served.status).toBe(200);
  return JSON.parse(served.text).result.data;
}

/**
 * `civitai_app_trpc_fast_superjson_writes_total`, read from the shared registry by name, as
 * `{ 'path|outcome': value }`. A missing metric reads as no series, so a case that expects the
 * counter to move fails when the counter is not registered.
 */
async function fastWriteCounts(): Promise<Record<string, number>> {
  const metric = instrumentationRegistry.getSingleMetric(
    'civitai_app_trpc_fast_superjson_writes_total'
  );
  if (!metric) return {};
  const { values } = await metric.get();
  return Object.fromEntries(
    values.map((v) => [`${String(v.labels.path)}|${String(v.labels.outcome)}`, v.value])
  );
}

/** How the counter moved while `fn` ran: only the series that changed, by how much. */
async function fastWriteDelta(fn: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = await fastWriteCounts();
  await fn();
  const after = await fastWriteCounts();
  const delta: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    const moved = value - (before[key] ?? 0);
    if (moved !== 0) delta[key] = moved;
  }
  return delta;
}

const asDevalue = (value: unknown) => devalueStringify(value);
const asSuperjson = (value: unknown) => JSON.parse(JSON.stringify(superjson.serialize(value)));

afterAll(async () => {
  if (server) await new Promise((r) => server!.close(r));
});

describe('TRPC_WRITE_DEVALUE=true — format chosen per request', () => {
  beforeEach(() => {
    h.writeDevalue = true;
  });

  it('writes devalue to a web bundle that can decode it', async () => {
    expect(singleData(await get('payload', CAPABLE_WEB))).toEqual(asDevalue(PAYLOAD));
  });

  it('writes devalue on the streamed batch path the web client uses, superjson to others', async () => {
    // The jsonl stream serializes every chunk separately: devalue chunks are JSON strings,
    // superjson chunks are `{ json, meta }` objects.
    const capable = streamedChunks(await streamed(CAPABLE_WEB));
    expect(capable.length).toBeGreaterThan(0);
    expect(capable.every((chunk) => typeof chunk === 'string')).toBe(true);
    expect(containsPayload(capable.map((chunk) => devalueParse(chunk as string)))).toBe(true);

    const old = streamedChunks(
      await streamed({ 'x-client': 'web', 'x-client-version': '5.0.2079' })
    );
    expect(old.length).toBe(capable.length);
    expect(
      old.every((chunk) => typeof chunk === 'object' && chunk !== null && 'json' in chunk)
    ).toBe(true);
    expect(containsPayload(old.map((chunk) => superjson.deserialize(chunk as any)))).toBe(true);
  });

  it('writes superjson to a request with no client headers (SDKs, CLIs, scripts)', async () => {
    expect(singleData(await get('payload'))).toEqual(asSuperjson(PAYLOAD));
  });

  it('writes superjson to a capable version that is not the web client', async () => {
    const served = await get('payload', { 'x-client-version': '5.0.2081' });
    expect(singleData(served)).toEqual(asSuperjson(PAYLOAD));
  });

  it('writes superjson to a web bundle older than the union deserializer', async () => {
    const served = await get('payload', { 'x-client': 'web', 'x-client-version': '5.0.2079' });
    expect(singleData(served)).toEqual(asSuperjson(PAYLOAD));
  });

  it('writes superjson for an edge-cacheable response, even to a capable web bundle', async () => {
    const served = await get('payload', { ...CAPABLE_WEB, 'x-test-cacheable': '1' });
    // Positive control: this response really is the cacheable kind.
    expect(served.headers.get('cache-control')).toContain('s-maxage=60');
    expect(singleData(served)).toEqual(asSuperjson(PAYLOAD));
  });

  it('writes superjson for an edge-cacheable response on the streamed batch path too', async () => {
    // The stream calls responseMeta before any chunk is serialized; this pins that ordering.
    const served = await streamed({ ...CAPABLE_WEB, 'x-test-cacheable': '1' });
    expect(served.headers.get('cache-control')).toContain('s-maxage=60');
    const chunks = streamedChunks(served);
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.every((chunk) => typeof chunk === 'object' && chunk !== null && 'json' in chunk)
    ).toBe(true);
    expect(containsPayload(chunks.map((chunk) => superjson.deserialize(chunk as any)))).toBe(true);
  });

  it('writes superjson for an edge-cacheable response on the non-streamed batch path too', async () => {
    const served = await get(`payload?batch=1&input=${encodeURIComponent('{}')}`, {
      ...CAPABLE_WEB,
      'x-test-cacheable': '1',
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toContain('s-maxage=60');
    expect(JSON.parse(served.text)[0].result.data).toEqual(asSuperjson(PAYLOAD));
  });

  it('marks every devalue response private without relying on the proxy', async () => {
    // This harness runs the route without the proxy middleware. The route applies the private
    // default itself (applyApiRequestPolicy), so a superjson response carries it too; a devalue
    // response must never come out without it.
    expect((await get('payload')).headers.get('cache-control')).toBe(
      'max-age=0, private, no-cache'
    );
    const single = await get('payload', CAPABLE_WEB);
    expect(singleData(single)).toEqual(asDevalue(PAYLOAD));
    expect(single.headers.get('cache-control')).toBe('max-age=0, private, no-cache');
    const stream = await streamed(CAPABLE_WEB);
    expect(stream.headers.get('cache-control')).toBe('max-age=0, private, no-cache');
  });

  it('keeps no-store on a devalue block-token response rather than the private default', async () => {
    const served = await get('blocks.listMyWorkflows', CAPABLE_WEB);
    // Positive control: this response really is devalue, so the private-marking branch is live.
    expect(singleData(served)).toEqual(asDevalue(PAYLOAD));
    expect(served.headers.get('cache-control')).toBe('no-store');
  });

  it('still falls back to superjson when devalue cannot represent the payload', async () => {
    const served = await get('notAPojo', CAPABLE_WEB);
    expect(singleData(served)).toEqual(asSuperjson(new NotAPojo(7)));
  });
});

describe('TRPC_WRITE_DEVALUE=false — superjson always', () => {
  beforeEach(() => {
    h.writeDevalue = false;
  });

  it('writes superjson even to a capable web bundle, with only the route default header', async () => {
    const served = await get('payload', CAPABLE_WEB);
    expect(singleData(served)).toEqual(asSuperjson(PAYLOAD));
    // The route's own private default (applyApiRequestPolicy); nothing format-specific.
    expect(served.headers.get('cache-control')).toBe('max-age=0, private, no-cache');
  });
});

describe('trpc-fast-superjson-write — the superjson write without superjson.serialize', () => {
  // Expected bodies are computed before any spy is installed.
  const plainSuperjson = asSuperjson(PLAIN);
  const plainDevalue = asDevalue(PLAIN);
  const payloadSuperjson = asSuperjson(PAYLOAD);

  beforeEach(() => {
    h.writeDevalue = true;
    flag.fastSuperjson = true;
  });
  afterEach(() => {
    flag.fastSuperjson = null;
    vi.restoreAllMocks();
  });

  it('writes the identical superjson body for an edge-cacheable response, without superjson.serialize', async () => {
    const spy = vi.spyOn(superjson, 'serialize');
    const served = await get('plain', { ...CAPABLE_WEB, 'x-test-cacheable': '1' });
    expect(served.headers.get('cache-control')).toContain('s-maxage=60');
    expect(singleData(served)).toEqual(plainSuperjson);
    expect(spy).not.toHaveBeenCalled();
  });

  it('writes the identical superjson body to a request with no client headers, without superjson.serialize', async () => {
    const spy = vi.spyOn(superjson, 'serialize');
    expect(singleData(await get('plain'))).toEqual(plainSuperjson);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still uses superjson.serialize for a payload outside the fast walk (a Map)', async () => {
    const spy = vi.spyOn(superjson, 'serialize');
    expect(singleData(await get('payload'))).toEqual(payloadSuperjson);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves a devalue response devalue', async () => {
    expect(singleData(await get('plain', CAPABLE_WEB))).toEqual(plainDevalue);
  });

  it.each([
    ['off', false],
    ['unknown (no Flipt key yet)', null],
  ])('uses superjson.serialize when the flag is %s', async (_label, value) => {
    flag.fastSuperjson = value;
    const spy = vi.spyOn(superjson, 'serialize');
    expect(singleData(await get('plain'))).toEqual(plainSuperjson);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('trpc-fast-superjson-write — the outcome counter', () => {
  beforeEach(() => {
    h.writeDevalue = true;
    flag.fastSuperjson = true;
  });
  afterEach(() => {
    flag.fastSuperjson = null;
  });

  it('counts a write the walk handled as fast, under the procedure path', async () => {
    const delta = await fastWriteDelta(async () => {
      expect(singleData(await get('plain'))).toEqual(asSuperjson(PLAIN));
    });
    expect(delta).toEqual({ 'plain|fast': 1 });
  });

  it('counts a payload the walk handed to superjson (a Map) as bail', async () => {
    const delta = await fastWriteDelta(async () => {
      expect(singleData(await get('payload'))).toEqual(asSuperjson(PAYLOAD));
    });
    expect(delta).toEqual({ 'payload|bail': 1 });
  });

  it('counts a write while a superjson registration disables the walk as registry_off', async () => {
    superjson.registerCustom<string, string>(
      {
        isApplicable: (v): v is string => typeof v === 'string' && v.startsWith('money:'),
        serialize: (v) => v.slice('money:'.length),
        deserialize: (v) => `money:${v}`,
      },
      'test-money-route'
    );
    try {
      const delta = await fastWriteDelta(async () => {
        expect(singleData(await get('plain'))).toEqual(asSuperjson(PLAIN));
      });
      expect(delta).toEqual({ 'plain|registry_off': 1 });
    } finally {
      delete (
        superjson as unknown as {
          defaultInstance: { customTransformerRegistry: { transfomers: Record<string, unknown> } };
        }
      ).defaultInstance.customTransformerRegistry.transfomers['test-money-route'];
    }
    // Control: with the registration gone the same request is fast again.
    expect(await fastWriteDelta(() => get('plain'))).toEqual({ 'plain|fast': 1 });
  });

  it('labels a multi-procedure batch as batch, one count per procedure', async () => {
    // `{}`: neither call carries an input, as in the one-call batch above.
    const delta = await fastWriteDelta(async () => {
      const served = await get(`plain,plain?batch=1&input=${encodeURIComponent('{}')}`);
      expect(served.status).toBe(200);
    });
    expect(delta).toEqual({ 'batch|fast': 2 });
  });

  it('folds a path that names no procedure into other (the URL is client-controlled)', async () => {
    const delta = await fastWriteDelta(async () => {
      expect((await get('no.such.procedure')).status).toBe(404);
    });
    // The 404 error body is still a superjson write; its label must not be the raw path.
    expect(Object.keys(delta).length).toBeGreaterThan(0);
    expect(Object.keys(delta).every((key) => key.startsWith('other|'))).toBe(true);
  });

  it('does not move for a devalue response', async () => {
    expect(await fastWriteDelta(() => get('plain', CAPABLE_WEB))).toEqual({});
  });

  it.each([
    ['off', false],
    ['unknown (no Flipt key yet)', null],
  ])('does not move when the flag is %s', async (_label, value) => {
    flag.fastSuperjson = value;
    const delta = await fastWriteDelta(async () => {
      expect(singleData(await get('plain'))).toEqual(asSuperjson(PLAIN));
      expect(singleData(await get('payload'))).toEqual(asSuperjson(PAYLOAD));
    });
    expect(delta).toEqual({});
  });
});
