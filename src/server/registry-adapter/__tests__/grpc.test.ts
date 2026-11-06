import * as grpc from '@grpc/grpc-js';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { abortableSleep, createPollingAdapter } from '~/server/registry-adapter/cursor';
import {
  SOURCE_SERVICE,
  createGrpcServer,
  encodeEvent,
  errorInfoOf,
  listenGrpc,
} from '~/server/registry-adapter/grpc';
import type { Adapter, Change, Entity, StreamEvent } from '~/server/registry-adapter/protocol';
import { createRegistryServer } from '~/server/registry-adapter/serve';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

/** The gRPC binding, through a real `@grpc/grpc-js` client. */

const APPS = 'urn:schema:app-blocks:app@v1';
// A body with every JSON kind, nested: what `google.protobuf.Value` must carry unchanged.
const BODY = { slug: 'alpha', stars: 4.5, listed: true, retired: null, tags: ['a', 1, { q: [] }] };
const ent = (slug: string, rev: string, body: unknown = { slug }): Entity => ({
  urn: `urn:app-blocks:app/${slug}`,
  schemas: [APPS],
  rev,
  body,
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

const Client = grpc.makeGenericClientConstructor(SOURCE_SERVICE, 'Source');

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
  until: (events: StreamEvent[]) => boolean = () => false
): Promise<Outcome> {
  const server = createGrpcServer(a);
  grpcServers.push(server);
  const port = await listenGrpc(server, 0);
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
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
    namespace: 'app-blocks',
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
    expect((events[2] as { entity: Entity }).entity.urn).toBe('urn:app-blocks:app/beta');
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
      schema: 'urn:schema:app-blocks:no-such-app/notes@v1',
    });
    expect(res).toEqual({ events: [{ type: 'end' }] });
  });

  it('a request that is not valid is INVALID_ARGUMENT with reason bad_request', async () => {
    const res = await viaGrpc(catalog([[]]), { filter: '{not json' });
    expect(res.error).toEqual({ code: grpc.status.INVALID_ARGUMENT, reason: 'bad_request' });
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

describe('🔴 the wire: the spec proto’s field numbers', () => {
  // Hand-encoded from the spec's proto block, not from the code's schema: Event.live = 3,
  // Event.end = 4, Event.progress = 6, Event.upsert = 1; Upsert.entity = 1, .cursor = 2;
  // Entity.urn = 1, .schemas = 2, .rev = 3, .body = 4; Value.string_value = 3.
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
      '0a13' + '0a0e' + '0a0175' + '120173' + '1a0172' + '22031a0162' + '120163',
    ],
  ])('%s', (_name, event, hex) => {
    expect(encodeEvent(event).toString('hex')).toBe(hex);
  });
});

describe('🔴 HTTP and gRPC serve one core', () => {
  // A snapshot narrowed by `urns` and a filter, a change the filter turns into a delete, and a
  // change of another URN that only moves the cursor: every path through the core.
  const snapshot = [ent('alpha', 'r1', { kind: 'onsite' }), ent('beta', 'r1', { kind: 'offsite' })];
  const adapter = (): Adapter => ({
    namespace: 'app-blocks',
    serves: async (s) => s === APPS,
    // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
    snapshot: async () => ({ cursor: 'c1.snap', entities: snapshot }),
    changes: async () =>
      (async function* (): AsyncGenerator<Change> {
        yield { upsert: ent('alpha', 'r2', { kind: 'offsite' }), cursor: 'c1.two' };
        yield { upsert: ent('gamma', 'r1', { kind: 'onsite' }), cursor: 'c1.three' };
      })(),
  });
  const FILTER = '{"properties":{"kind":{"const":"onsite"}}}';
  const URNS = ['urn:app-blocks:app/alpha', 'urn:app-blocks:app/beta'];

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
