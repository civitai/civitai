// A real QdrantClient against a local HTTP server that drops chosen requests by closing the
// socket without answering. That is what a keep-alive socket the server has already closed looks
// like to the client: undici reports `fetch failed` caused by `other side closed`
// (UND_ERR_SOCKET), with no response.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { QdrantClient } from '@qdrant/js-client-rest';
import { afterEach, describe, expect, test } from 'vitest';
import { isTransientConnectionError } from '@/common/utils/connection-errors';
import { VectorStore } from '@/vector-sync/qdrant';

type Reply = 'ok' | 'drop' | 'error' | 'hang';

type Fake = {
  url: string;
  /** Requests seen, in order, as `METHOD path`. */
  requests: string[];
  connections: number;
};

/** The body Qdrant would return for a request, enough for the client to parse it. */
function result(req: IncomingMessage) {
  const path = req.url ?? '';
  if (path.endsWith('/points/count')) return { count: 7 };
  if (path.endsWith('/exists')) return { exists: true };
  if (path === '/aliases') return { aliases: [{ alias_name: 'a', collection_name: 'c' }] };
  if (path.endsWith('/points/scroll')) return { points: [{ id: 3 }], next_page_offset: null };
  if (req.method === 'POST' && path.endsWith('/points')) return [{ id: 3, payload: { a: 1 } }];
  if (req.method === 'GET' && path === '/collections/c') {
    return { config: { metadata: { modelRevision: 'r', profile: 'p' } }, payload_schema: {} };
  }
  return { status: 'acknowledged', operation_id: 1 };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) s.closeAllConnections();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** `replies[i]` answers the i-th request; requests past the end are answered 'ok'. */
async function fakeQdrant(replies: Reply[]): Promise<Fake> {
  const fake = { requests: [] as string[], connections: 0 } as Fake;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = replies[fake.requests.length] ?? 'ok';
    fake.requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      if (reply === 'hang') return;
      if (reply === 'drop') return void req.socket.destroy();
      const status = reply === 'error' ? 500 : 200;
      const body = JSON.stringify(
        reply === 'error' ? { status: { error: 'boom' } } : { result: result(req), status: 'ok' }
      );
      res.writeHead(status, { 'content-type': 'application/json' }).end(body);
    });
  });
  server.on('connection', () => fake.connections++);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

function storeFor(fake: Fake, timeout?: number) {
  const client = new QdrantClient({ url: fake.url, checkCompatibility: false, timeout });
  return { client, store: new VectorStore<Record<string, unknown>>(client, 'c') };
}

describe('VectorStore on a pooled socket the server already closed', () => {
  test('retries the call once, on a new connection, and returns its result', async () => {
    // The first request leaves an idle keep-alive socket in the pool; the second reuses it and
    // the server closes it without answering.
    const fake = await fakeQdrant(['ok', 'drop']);
    const { client, store } = storeFor(fake);
    await client.getCollection('c');

    await expect(store.count()).resolves.toBe(7);
    expect(fake.requests).toEqual([
      'GET /collections/c',
      'POST /collections/c/points/count',
      'POST /collections/c/points/count',
    ]);
    // The retry went out on a second connection: the dropped one was the reused one.
    expect(fake.connections).toBe(2);
  });

  // Every call the sync makes on a tick, each wrapped on its own.
  const calls: Array<
    [string, (s: VectorStore<Record<string, unknown>>) => Promise<unknown>, unknown]
  > = [
    ['count', (s) => s.count(), 7],
    ['upsert', (s) => s.upsert([{ id: 3, vector: [0.5], payload: { a: 1 } }]), undefined],
    ['delete', (s) => s.delete([3]), undefined],
    ['setPayloads', (s) => s.setPayloads(new Map([[3, { a: 1 }]])), undefined],
    ['setMetadata', (s) => s.setMetadata({ k: 'v' }), undefined],
    ['existing', (s) => s.existing([3, 4]), new Set([3])],
    ['payloadFields', (s) => s.payloadFields([3], ['a']), new Map([[3, { a: 1 }]])],
    ['idsMatching', (s) => s.idsMatching('a', [1]), [3]],
    ['idsInRange', (s) => s.idsInRange(0, 10), [3]],
    ['isStamped', (s) => s.isStamped(), true],
    ['exists', (s) => s.exists(), true],
  ];
  test.each(calls)('%s is retried once', async (_name, call, expected) => {
    const fake = await fakeQdrant(['ok', 'drop']);
    const { client, store } = storeFor(fake);
    await client.getCollection('c');

    await expect(call(store)).resolves.toEqual(expected);
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[2]).toBe(fake.requests[1]);
  });

  // Bootstrap of an existing collection with no indexes to add: three reads, each wrapped.
  test.each([
    ['collectionExists', 1, 'GET /collections/c/exists'],
    ['getCollection', 2, 'GET /collections/c'],
    ['getAliases', 3, 'GET /aliases'],
  ])('bootstrap retries %s once', async (_name, dropAt, request) => {
    const replies: Reply[] = ['ok'];
    replies[dropAt] = 'drop';
    const fake = await fakeQdrant(replies);
    const client = new QdrantClient({ url: fake.url, checkCompatibility: false });
    const store = new VectorStore<Record<string, unknown>>(client, 'c', {
      indexes: [],
      quantile: 1,
    });
    await client.getCollection('c');

    await store.bootstrap({ alias: 'a' });
    const expected = [
      'GET /collections/c',
      'GET /collections/c/exists',
      'GET /collections/c',
      'GET /aliases',
    ];
    // The dropped request goes out a second time, right after itself.
    expected.splice(dropAt, 0, request);
    expect(fake.requests).toEqual(expected);
  });

  test('recording a model stamp retries its metadata update once', async () => {
    // The stored stamp lacks the video profile, so it is written, then read back.
    const fake = await fakeQdrant(['ok', 'ok', 'drop']);
    const { client, store } = storeFor(fake);
    await client.getCollection('c');

    await store.assertModel({
      model: 'wemm-2b',
      modelRevision: 'r',
      profile: 'p',
      videoProfile: 'v',
      dimensions: 256,
    });
    expect(fake.requests).toEqual([
      'GET /collections/c',
      'GET /collections/c',
      'PATCH /collections/c',
      'PATCH /collections/c',
      'GET /collections/c',
    ]);
  });

  test('a second consecutive dropped socket surfaces the error (one retry, not two)', async () => {
    const fake = await fakeQdrant(['ok', 'drop', 'drop']);
    const { client, store } = storeFor(fake);
    await client.getCollection('c');

    const error = await store.count().catch((e: unknown) => e);
    expect(isTransientConnectionError(error)).toBe(true);
    expect((error as { cause: { code: string } }).cause.code).toBe('UND_ERR_SOCKET');
    expect(fake.requests).toHaveLength(3);
  });

  test('an HTTP error response is not retried', async () => {
    const fake = await fakeQdrant(['error']);
    const { store } = storeFor(fake);

    await expect(store.count()).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });

  test('a timeout is not retried', async () => {
    const fake = await fakeQdrant(['hang']);
    const { store } = storeFor(fake, 200);

    await expect(store.count()).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });
});

describe('isTransientConnectionError', () => {
  const failed = (code: string) => new TypeError('fetch failed', { cause: { code } });

  test.each(['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED'])('%s is transient', (code) => {
    expect(isTransientConnectionError(failed(code))).toBe(true);
  });

  test.each([
    ['a timeout', failed('UND_ERR_CONNECT_TIMEOUT')],
    ['a DNS failure', failed('ENOTFOUND')],
    ['an abort', new DOMException('aborted', 'AbortError')],
    ['no error', undefined],
  ])('%s is not', (_name, error) => {
    expect(isTransientConnectionError(error)).toBe(false);
  });
});
