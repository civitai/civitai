import * as grpc from '@grpc/grpc-js';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPollingAdapter } from '~/server/registry-adapter/cursor';
import { abortableSleep } from '~/utils/errorHandling';
import {
  LEGACY_SOURCE_SERVICE,
  REGISTRY_SERVICE,
  createGrpcServer,
  decodeEvent,
  encodeEvent,
  errorInfoOf,
  errorStatus,
  listenGrpc,
} from '~/server/registry-adapter/grpc';
import type { Adapter, Change, Entity, StreamEvent } from '~/server/registry-adapter/protocol';
import { createRegistryServer, sseFrame } from '~/server/registry-adapter/serve';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

/** The gRPC binding, through a real `@grpc/grpc-js` client. */

const APPS = 'urn:schema:apps.civitai.com:app@v1';
// A body with every JSON kind, nested: what `Entity.body`'s JSON bytes must carry unchanged.
const BODY = { slug: 'alpha', stars: 4.5, listed: true, retired: null, tags: ['a', 1, { q: [] }] };
// Each app body has a known rating, so an anonymous subscription is sent it (`audience.ts`).
const ent = (slug: string, rev: string, body: object = { slug }): Entity => ({
  urn: `urn:apps.civitai.com:app/${slug}`,
  schemas: [APPS],
  rev,
  body: { ...body, contentRating: 'g' },
});

const grpcServers: grpc.Server[] = [];
let httpServer: HttpServer | undefined;
afterEach(async () => {
  for (const s of grpcServers.splice(0)) s.forceShutdown();
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = undefined;
  }
});

/**
 * A client of the method at `path`, built from a literal path rather than an exported service, so
 * a server that does not answer at that path fails here as UNIMPLEMENTED.
 */
const clientAt = (path: string) =>
  grpc.makeGenericClientConstructor(
    { Subscribe: { ...REGISTRY_SERVICE.Subscribe, path } },
    'Registry'
  );
const SPEC_PATH = '/registry.v1.Registry/Subscribe';
const LEGACY_PATH = '/Source/Subscribe';
const Client = clientAt(SPEC_PATH);

type Outcome = {
  events: StreamEvent[];
  error?: { code: number; reason: string | null };
};

/**
 * One gRPC subscription to `a`: its events until `until` holds (then cancelled), the stream ends,
 * or 5s pass, and its error status if it failed.
 */
async function viaGrpc(
  a: Adapter,
  req: Partial<{ schema: string; cursor: string; urns: string[]; filter: string }>,
  until: (events: StreamEvent[]) => boolean = () => false,
  path: string = SPEC_PATH
): Promise<Outcome> {
  const server = createGrpcServer(a);
  grpcServers.push(server);
  const port = await listenGrpc(server, 0);
  const PathClient = clientAt(path);
  const client = new PathClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const subscribe = (
    client as unknown as Record<string, (r: unknown) => grpc.ClientReadableStream<StreamEvent>>
  ).Subscribe;
  return new Promise<Outcome>((resolve) => {
    const events: StreamEvent[] = [];
    let cancelled = false;
    const call = subscribe.call(client, { schema: APPS, cursor: '', urns: [], filter: '', ...req });
    const finish = (outcome: Outcome) => {
      clearTimeout(timer);
      client.close();
      resolve(outcome);
    };
    const stop = () => {
      cancelled = true;
      call.cancel();
    };
    const timer = setTimeout(stop, 5_000);
    call.on('data', (e: StreamEvent) => {
      events.push(e);
      if (until(events)) stop();
    });
    call.on('error', (err: grpc.ServiceError) =>
      finish(
        cancelled && err.code === grpc.status.CANCELLED
          ? { events }
          : { events, error: { code: err.code, reason: errorInfoOf(err.metadata)?.reason ?? null } }
      )
    );
    call.on('end', () => finish({ events }));
  });
}

/** One HTTP subscription to `a`, read to its end, as the events its SSE frames carry. */
async function viaHttp(a: Adapter, query: string): Promise<StreamEvent[]> {
  httpServer = createRegistryServer(a);
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  const text = await (await fetch(`http://127.0.0.1:${port}${query}`)).text();
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => {
      const type = /^event: (\w+)$/m.exec(frame)![1];
      const data = JSON.parse(/^data: (.*)$/m.exec(frame)![1]) as Record<string, unknown>;
      return { type, ...data } as StreamEvent;
    });
}

/** The catalog adapter over `states`, read in turn, the last one repeating. */
function catalog(states: Entity[][], store = createMemorySnapshotStore()) {
  let reads = 0;
  return createPollingAdapter({
    namespace: 'apps.civitai.com',
    serves: [APPS],
    read: async () => new Map([[APPS, states[Math.min(reads++, states.length - 1)]]]),
    store,
    pollMs: 5,
    sleep: abortableSleep,
  });
}

const kinds = (events: StreamEvent[]) => events.map((e) => e.type);

describe('the gRPC binding', () => {
  it('🔴 a snapshot, then live, then the changes, the body carried unchanged', async () => {
    const a = catalog([[ent('alpha', 'r1', BODY)], [ent('alpha', 'r1', BODY), ent('beta', 'r1')]]);
    const { events, error } = await viaGrpc(a, {}, (e) => e.length === 3);
    expect(error).toBeUndefined();
    expect(kinds(events)).toEqual(['upsert', 'live', 'upsert']);
    expect(events[0]).toEqual({ type: 'upsert', entity: ent('alpha', 'r1', BODY), cursor: '' });
    expect((events[2] as { entity: Entity }).entity.urn).toBe('urn:apps.civitai.com:app/beta');
  });

  it('🔴 resumes from a cursor it issued: live with that cursor, then only what changed', async () => {
    const store = createMemorySnapshotStore();
    const first = await viaGrpc(catalog([[ent('alpha', 'r1')]], store), {}, (e) =>
      e.some((x) => x.type === 'live')
    );
    const live = first.events.find((e) => e.type === 'live') as { cursor: string };
    const resumed = await viaGrpc(
      catalog([[ent('alpha', 'r2')]], store),
      { cursor: live.cursor },
      (e) => e.length === 2
    );
    expect(resumed.events).toEqual([
      { type: 'live', cursor: live.cursor },
      { type: 'upsert', entity: ent('alpha', 'r2'), cursor: expect.any(String) },
    ]);
  });

  it('🔴 a cursor the source refuses is OUT_OF_RANGE with ErrorInfo reason cursor_expired, and no event', async () => {
    const store = createMemorySnapshotStore(1);
    const a = catalog([[ent('alpha', 'r1')], [ent('alpha', 'r2')]], store);
    const first = await viaGrpc(a, {}, (e) => e.some((x) => x.type === 'live'));
    const live = first.events.find((e) => e.type === 'live') as { cursor: string };
    // One state kept per stream: a second snapshot evicts the first one's.
    await a.snapshot(APPS, { signal: new AbortController().signal });
    const res = await viaGrpc(a, { cursor: live.cursor });
    expect(res).toEqual({
      events: [],
      error: { code: grpc.status.OUT_OF_RANGE, reason: 'cursor_expired' },
    });
  });

  it('🔴 a schema this source does not serve is end, and nothing else', async () => {
    const res = await viaGrpc(catalog([[ent('alpha', 'r1')]]), {
      schema: 'urn:schema:elsewhere.example:model@v1',
    });
    expect(res).toEqual({ events: [{ type: 'end' }] });
  });

  it('a request that is not valid is INVALID_ARGUMENT with reason bad_request', async () => {
    const res = await viaGrpc(catalog([[]]), { filter: '{not json' });
    expect(res.error).toEqual({ code: grpc.status.INVALID_ARGUMENT, reason: 'bad_request' });
  });

  // Rule 6: a filter this source will not evaluate is refused, never ignored. Before, both were
  // streamed unfiltered (the upsert, then live) with no error.
  it.each([
    ['a pattern', '{"properties":{"slug":{"pattern":"^zzz"}}}'],
    ['a $ref', '{"$ref":"#/x","x":{"properties":{"slug":{"const":"zzz"}}}}'],
    ['a filter over the size bound', JSON.stringify({ not: {}, description: 'x'.repeat(8192) })],
  ])('🔴 %s is INVALID_ARGUMENT with reason bad_request, and no event', async (_name, filter) => {
    const res = await viaGrpc(catalog([[ent('alpha', 'r1')]]), { filter });
    expect(res).toEqual({
      events: [],
      error: { code: grpc.status.INVALID_ARGUMENT, reason: 'bad_request' },
    });
  });

  // Rule 4: `urns` outside this registry's namespace are a request it can never serve anything
  // for. Before, this was an empty snapshot and `live`, with the stream left open.
  it('🔴 urns all of another namespace are end first, and nothing else', async () => {
    const res = await viaGrpc(catalog([[ent('alpha', 'r1')]]), {
      urns: ['urn:huggingface:black-forest-labs/FLUX.3-dev@a1b2c3d'],
    });
    expect(res).toEqual({ events: [{ type: 'end' }] });
  });

  it('🔴 an unexpected error is UNAVAILABLE and its text never reaches the client', async () => {
    const failing: Adapter = {
      ...catalog([[]]),
      snapshot: async () => {
        throw new Error('password authentication failed for db-canary-31');
      },
    };
    const res = await viaGrpc(failing, {});
    expect(res.error).toEqual({ code: grpc.status.UNAVAILABLE, reason: 'unavailable' });
  });
});

describe('🔴 the method answers at the spec path and at the earlier spec path', () => {
  it('the paths are the ones each spec names', () => {
    expect(REGISTRY_SERVICE.Subscribe.path).toBe('/registry.v1.Registry/Subscribe');
    expect(LEGACY_SOURCE_SERVICE.Subscribe.path).toBe('/Source/Subscribe');
  });

  // Before, only `/Source/Subscribe` was registered: the spec path was UNIMPLEMENTED.
  it.each([[SPEC_PATH], [LEGACY_PATH]])('%s: a snapshot, then live', async (path) => {
    const res = await viaGrpc(
      catalog([[ent('alpha', 'r1')]]),
      {},
      (e) => e.some((x) => x.type === 'live'),
      path
    );
    expect(res.error).toBeUndefined();
    expect(kinds(res.events)).toEqual(['upsert', 'live']);
    expect(res.events[0]).toEqual({ type: 'upsert', entity: ent('alpha', 'r1'), cursor: '' });
  });

  it('negative control: a path no spec names is UNIMPLEMENTED', async () => {
    const res = await viaGrpc(catalog([[ent('alpha', 'r1')]]), {}, () => false, '/Nope/Subscribe');
    expect(res).toEqual({ events: [], error: { code: grpc.status.UNIMPLEMENTED, reason: null } });
  });
});

describe('🔴 a gRPC consumer that stops reading (rule 8)', () => {
  it('is ended at once with RESOURCE_EXHAUSTED, not left open behind its full buffer', async () => {
    // ~8 MB of snapshot: more than any HTTP/2 window, so a paused client stalls the server.
    const pad = 'x'.repeat(4096);
    const entities = Array.from({ length: 2000 }, (_, i) => ent(`app-${i}`, 'r1', { pad }));
    const many: Adapter = {
      namespace: 'apps.civitai.com',
      serves: (s) => s === APPS,
      // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
      snapshot: async () => ({ cursor: 'c1.snap', entities }),
      changes: async () =>
        (async function* (): AsyncGenerator<Change> {
          // no changes
        })(),
    };
    const server = createGrpcServer(many, { slowConsumerMs: 200 });
    grpcServers.push(server);
    const port = await listenGrpc(server, 0);
    const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const call = (
      client as unknown as Record<string, (r: unknown) => grpc.ClientReadableStream<StreamEvent>>
    ).Subscribe.call(client, { schema: APPS, cursor: '', urns: [], filter: '' });
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('still open after 5s'), 5_000);
      let received = 0;
      call.on('data', () => {
        // Stop reading after the first event, and never resume.
        if (++received === 1) call.pause();
      });
      call.on('error', (err: grpc.ServiceError) => {
        clearTimeout(timer);
        resolve(grpc.status[err.code]);
      });
      call.on('end', () => {
        clearTimeout(timer);
        resolve('ended normally');
      });
    });
    call.cancel();
    client.close();
    expect(outcome).toBe('RESOURCE_EXHAUSTED');
  });
});

describe('🔴 the wire: the spec proto’s field numbers', () => {
  // Hand-encoded from the spec's proto block, not from the code's schema: Event.live = 3,
  // Event.end = 4, Event.progress = 6, Event.upsert = 1; Upsert.entity = 1, .cursor = 2;
  // Entity.urn = 1, .schemas = 2, .rev = 3, .body = 4 (bytes: the body's JSON text, UTF-8).
  // No event this source sends sets Entity.meta (5) or Event.meta (5): empty is absent.
  it.each<[string, StreamEvent, string]>([
    ['live', { type: 'live', cursor: 'ab' }, '1a040a026162'],
    ['progress', { type: 'progress', cursor: 'ab' }, '32040a026162'],
    ['end', { type: 'end' }, '2200'],
    ['delete', { type: 'delete', urn: 'u', cursor: 'c' }, '12060a0175120163'],
    [
      'upsert',
      {
        type: 'upsert',
        entity: { urn: 'u', schemas: ['s'], rev: 'r', body: 'b' },
        cursor: 'c',
      },
      // body = 4: 3 bytes, `"b"`
      '0a13' + '0a0e' + '0a0175' + '120173' + '1a0172' + '2203226222' + '120163',
    ],
  ])('%s', (_name, event, hex) => {
    expect(encodeEvent(event).toString('hex')).toBe(hex);
  });

  const upsert = (body: unknown): StreamEvent => ({
    type: 'upsert',
    entity: { urn: 'u', schemas: ['s'], rev: 'r', body },
    // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- builds one event to encode, not a paging fake
    cursor: 'c',
  });
  it.each<[string, unknown, string]>([
    // `4.5`
    ['a number', 4.5, '0a130a0e0a01751201731a01722203342e35120163'],
    // `null`
    ['null', null, '0a140a0f0a01751201731a017222046e756c6c120163'],
    // `{"b":"é","a":[1,true,null]}`: keys in the body's own order (not sorted, so a sorting
    // encoder fails this), no spaces, `é` as UTF-8 (c3 a9)
    [
      'an object',
      { b: 'é', a: [1, true, null] },
      '0a2c0a270a01751201731a0172221c' +
        '7b2262223a22c3a9222c2261223a5b312c747275652c6e756c6c5d7d' +
        '120163',
    ],
    // `[{"q":[]},"x"]`
    [
      'an array',
      [{ q: [] }, 'x'],
      '0a1e0a190a01751201731a0172220e5b7b2271223a5b5d7d2c2278225d120163',
    ],
  ])('upsert with %s as its body: the body is its JSON text', (_name, body, hex) => {
    expect(encodeEvent(upsert(body)).toString('hex')).toBe(hex);
    expect(decodeEvent(Buffer.from(hex, 'hex'))).toEqual(upsert(body));
  });

  it('a body JSON cannot hold is sent as JSON.stringify sends it, as over HTTP', () => {
    // `{"n":null}`: a non-finite number is null, an undefined property is dropped.
    expect(encodeEvent(upsert({ n: Number.NaN, gone: undefined })).toString('hex')).toBe(
      '0a1a0a150a01751201731a017222' + '0a' + '7b226e223a6e756c6c7d' + '120163'
    );
  });
});

describe('🔴 the HTTP binding is unchanged: its events carry JSON objects', () => {
  it('an upsert frame carries the entity, its body a JSON value, not text or bytes', () => {
    expect(
      sseFrame({
        type: 'upsert',
        entity: { urn: 'u', schemas: ['s'], rev: 'r', body: { a: [1, true, null], b: 'é' } },
        cursor: 'c',
      })
    ).toBe(
      'event: upsert\n' +
        'id: c\n' +
        'data: {"entity":{"urn":"u","schemas":["s"],"rev":"r","body":{"a":[1,true,null],"b":"é"}},"cursor":"c"}\n\n'
    );
  });

  it('over a live server, the same entity is a JSON object over HTTP and its JSON text over gRPC', async () => {
    // Built here rather than by `ent`, so the body is exactly BODY whatever `ent` adds to one.
    const entity: Entity = {
      urn: 'urn:apps.civitai.com:app/alpha',
      schemas: [APPS],
      rev: 'r1',
      body: BODY,
    };
    const one = (): Adapter => ({
      namespace: 'apps.civitai.com',
      serves: (s) => s === APPS,
      // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
      snapshot: async () => ({ cursor: 'c1.snap', entities: [entity] }),
      changes: async () =>
        (async function* (): AsyncGenerator<Change> {
          // no changes
        })(),
    });
    httpServer = createRegistryServer(one());
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
    const { port: httpPort } = httpServer.address() as AddressInfo;
    const sse = await (
      await fetch(`http://127.0.0.1:${httpPort}/subscribe?schema=${encodeURIComponent(APPS)}`)
    ).text();
    const data = /^event: upsert\nid:.*\ndata: (.*)$/m.exec(sse)![1];
    // The body is the entity's last field: its text runs to the entity's closing brace.
    const bodyText = /"body":(.*)\},"cursor":""\}$/.exec(data)![1];
    expect(bodyText).toBe(
      '{"slug":"alpha","stars":4.5,"listed":true,"retired":null,"tags":["a",1,{"q":[]}]}'
    );
    expect(typeof (JSON.parse(data) as { entity: { body: unknown } }).entity.body).toBe('object');

    const RawClient = grpc.makeGenericClientConstructor(
      { Subscribe: { ...REGISTRY_SERVICE.Subscribe, responseDeserialize: (b: Buffer) => b } },
      'Registry'
    );
    const server = createGrpcServer(one());
    grpcServers.push(server);
    const grpcPort = await listenGrpc(server, 0);
    const client = new RawClient(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure());
    const messages = await new Promise<Buffer[]>((resolve, reject) => {
      const out: Buffer[] = [];
      const call = (
        client as unknown as Record<string, (r: unknown) => grpc.ClientReadableStream<Buffer>>
      ).Subscribe.call(client, { schema: APPS, cursor: '', urns: [], filter: '' });
      call.on('data', (b: Buffer) => out.push(b));
      call.on('end', () => resolve(out));
      call.on('error', reject);
    });
    client.close();
    // Entity.body (field 4, length-delimited): exactly the SSE body's text, byte for byte.
    const text = Buffer.from(bodyText, 'utf8');
    const field = Buffer.concat([Buffer.from([0x22, text.length]), text]);
    expect(messages[0].includes(field)).toBe(true);
  });
});

describe('🔴 HTTP and gRPC serve one core', () => {
  // A snapshot narrowed by `urns` and a filter, a change the filter turns into a delete, and a
  // change of another URN that only moves the cursor: every path through the core.
  const snapshot = [ent('alpha', 'r1', { kind: 'onsite' }), ent('beta', 'r1', { kind: 'offsite' })];
  const adapter = (): Adapter => ({
    namespace: 'apps.civitai.com',
    serves: (s) => s === APPS,
    // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
    snapshot: async () => ({ cursor: 'c1.snap', entities: snapshot }),
    changes: async () =>
      (async function* (): AsyncGenerator<Change> {
        yield { upsert: ent('alpha', 'r2', { kind: 'offsite' }), cursor: 'c1.two' };
        yield { upsert: ent('gamma', 'r1', { kind: 'onsite' }), cursor: 'c1.three' };
      })(),
  });
  const FILTER = '{"properties":{"kind":{"const":"onsite"}}}';
  const URNS = ['urn:apps.civitai.com:app/alpha', 'urn:apps.civitai.com:app/beta'];

  it('the same request gets the same events, cursors included', async () => {
    const http = await viaHttp(
      adapter(),
      `/subscribe?schema=${encodeURIComponent(APPS)}` +
        URNS.map((u) => `&urn=${encodeURIComponent(u)}`).join('') +
        `&filter=${encodeURIComponent(FILTER)}`
    );
    const overGrpc = await viaGrpc(adapter(), { urns: URNS, filter: FILTER });
    expect(kinds(http)).toEqual(['upsert', 'live', 'delete', 'progress', 'end']);
    expect(overGrpc).toEqual({ events: http });
  });
});

describe('🔴 an error is named by its ErrorInfo reason alone, as the spec names it', () => {
  it('the status details carry the reason and no domain', () => {
    const { metadata } = errorStatus('cursor_expired', 'gone');
    const raw = metadata!.get('grpc-status-details-bin')[0] as Buffer;
    // Hand-encoded: google.rpc.Status { code = 1: 11 (OUT_OF_RANGE), message = 2: "gone",
    // details = 3: Any { type_url = 1: "type.googleapis.com/google.rpc.ErrorInfo",
    // value = 2: ErrorInfo { reason = 1: "cursor_expired" } } }. No ErrorInfo.domain (field 2).
    expect(raw.toString('hex')).toBe(
      '080b' +
        '1204676f6e65' +
        '1a3c' +
        '0a28747970652e676f6f676c65617069732e636f6d2f676f6f676c652e7270632e4572726f72496e666f' +
        '1210' +
        '0a0e637572736f725f65787069726564'
    );
    expect(errorInfoOf(metadata)).toEqual({ reason: 'cursor_expired', domain: '' });
  });
});
