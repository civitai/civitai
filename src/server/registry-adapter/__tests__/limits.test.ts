import * as grpc from '@grpc/grpc-js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBSCRIPTION_LIMITS,
  createSubscriptionLimiter,
  subscriptionLimitsFromEnv,
} from '~/server/registry-adapter/limits';
import type { SubscriptionLimiter } from '~/server/registry-adapter/limits';
import {
  REGISTRY_SERVICE,
  createGrpcServer,
  errorInfoOf,
  listenGrpc,
} from '~/server/registry-adapter/grpc';
import type { Adapter, Change, StreamEvent } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import { createRegistryServer } from '~/server/registry-adapter/serve';

const APPS = 'urn:schema:apps.civitai.com:app@v1';

/** A source whose streams stay open, with nothing to send after `live`, until the consumer goes. */
function openSource(): Adapter {
  return {
    namespace: 'apps.civitai.com',
    serves: (schema) => schema === APPS,
    // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
    snapshot: async () => ({ cursor: 'c1.snapshot', entities: [] }),
    changes: async (_schema, _cursor, ctx) =>
      (async function* (): AsyncGenerator<Change> {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })(),
  };
}

/** Token verifications made, so a case can tell a refusal that never looked a token up. */
let verified = 0;
const verifyToken = async (token: string) => {
  verified++;
  return token.startsWith('user-')
    ? { subject: `${token}/client:a`, user: { showNsfw: false }, expiresAt: null }
    : null;
};

/** A source whose snapshot fails: the subscription ends with `unavailable` before `live`. */
function failingSource(): Adapter {
  return {
    ...openSource(),
    snapshot: async () => {
      throw new Error('the catalog could not be read');
    },
  };
}

const servers: Server[] = [];
const grpcServers: grpc.Server[] = [];
const aborts: AbortController[] = [];
afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  for (const s of grpcServers.splice(0)) s.forceShutdown();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function httpServer(limiter: SubscriptionLimiter, source: Adapter = openSource()) {
  const server = createRegistryServer(source, { verifyToken, limiter });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

type Opened = { status: number; body: string; close: () => void };

/**
 * A subscription: open (status 200, once `live` arrives, and held open until `close`) or refused
 * (its status and JSON body).
 */
async function subscribe(port: number, headers: Record<string, string> = {}): Promise<Opened> {
  const abort = new AbortController();
  aborts.push(abort);
  const res = await fetch(`http://127.0.0.1:${port}/subscribe?schema=${encodeURIComponent(APPS)}`, {
    headers,
    signal: abort.signal,
  });
  if (res.status !== 200)
    return { status: res.status, body: await res.text(), close: () => abort.abort() };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: live')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { status: res.status, body: text, close: () => abort.abort() };
}

/** Resolves once `limiter` holds `n` slots; rejects after 2s. */
async function openCount(limiter: SubscriptionLimiter, n: number) {
  const until = Date.now() + 2_000;
  while (limiter.open() !== n) {
    if (Date.now() > until) throw new Error(`open() is ${limiter.open()}, expected ${n}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const errorOf = (body: string) => JSON.parse(body) as { error: string; message: string };
const from = (address: string) => ({ 'cf-connecting-ip': address });

/** A slot for `subject` from `address`, as a binding takes it: address first, token after. */
const take = (limiter: SubscriptionLimiter, address: string, subject: string | null = null) => {
  const slot = limiter.acquire(address);
  try {
    slot.claim(subject);
  } catch (err) {
    slot.release();
    throw err;
  }
  return slot;
};

describe('the limiter', () => {
  it('🔴 refuses past each cap with unavailable, and a freed slot is taken again', () => {
    const limiter = createSubscriptionLimiter({ total: 3, perSubject: 1, perAddress: 2 });
    const a1 = take(limiter, '192.0.2.1', 'user:1');
    expect(() => take(limiter, '192.0.2.2', 'user:1')).toThrow(
      new ProtocolError('unavailable', 'too many open subscriptions for this token; retry later')
    );
    // The refused token's slot was given back.
    expect(limiter.open()).toBe(1);
    take(limiter, '192.0.2.1');
    expect(() => limiter.acquire('192.0.2.1')).toThrow(
      'too many open subscriptions from this address; retry later'
    );
    take(limiter, '192.0.2.3');
    expect(limiter.open()).toBe(3);
    expect(() => limiter.acquire('192.0.2.4')).toThrow(
      'too many open subscriptions on this source; retry later'
    );
    a1.release();
    expect(limiter.open()).toBe(2);
    // The freed slot counted against the token and the address as well as the total.
    take(limiter, '192.0.2.1', 'user:1');
    expect(limiter.open()).toBe(3);
  });

  it('the total and per-address caps refuse before any token is named', () => {
    const limiter = createSubscriptionLimiter({ total: 1, perSubject: 10, perAddress: 10 });
    limiter.acquire('192.0.2.1');
    // `acquire` takes no token: a request over these caps is refused before one is verified.
    expect(() => limiter.acquire('192.0.2.2')).toThrow(
      'too many open subscriptions on this source; retry later'
    );
  });

  it('a slot freed twice is freed once', () => {
    const limiter = createSubscriptionLimiter({ total: 2, perSubject: 2, perAddress: 2 });
    const first = take(limiter, '192.0.2.1', 'user:1');
    take(limiter, '192.0.2.1');
    first.release();
    first.release();
    expect(limiter.open()).toBe(1);
    take(limiter, '192.0.2.1', 'user:1');
    expect(() => limiter.acquire('192.0.2.1')).toThrow(ProtocolError);
  });

  it('anonymous subscriptions count against no token', () => {
    const limiter = createSubscriptionLimiter({ total: 10, perSubject: 1, perAddress: 10 });
    take(limiter, '192.0.2.1');
    take(limiter, '192.0.2.1');
    take(limiter, '192.0.2.1', 'user:1');
    expect(limiter.open()).toBe(3);
  });
});

describe('subscriptionLimitsFromEnv', () => {
  it('defaults when unset or empty', () => {
    expect(DEFAULT_SUBSCRIPTION_LIMITS).toEqual({ total: 2000, perSubject: 100, perAddress: 100 });
    expect(subscriptionLimitsFromEnv({})).toEqual({
      total: 2000,
      perSubject: 100,
      perAddress: 100,
    });
    expect(subscriptionLimitsFromEnv({ REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS: '' })).toEqual({
      total: 2000,
      perSubject: 100,
      perAddress: 100,
    });
  });

  it('reads each cap from its own variable', () => {
    expect(
      subscriptionLimitsFromEnv({
        REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS: '7',
        REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_TOKEN: '3',
        REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_ADDRESS: '5',
      })
    ).toEqual({ total: 7, perSubject: 3, perAddress: 5 });
  });

  it.each(['0', '-1', '2.5', 'many'])('refuses %j', (raw) => {
    expect(() =>
      subscriptionLimitsFromEnv({ REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_ADDRESS: raw })
    ).toThrow('REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_ADDRESS must be a positive integer');
  });
});

describe('🔴 over HTTP, a subscription over a cap is 503 unavailable before its stream', () => {
  it('per address: the third from one address is refused, one from another is served', async () => {
    const limiter = createSubscriptionLimiter({ total: 10, perSubject: 10, perAddress: 2 });
    const port = await httpServer(limiter);
    const first = await subscribe(port, from('192.0.2.1'));
    const second = await subscribe(port, from('192.0.2.1'));
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await subscribe(port, from('192.0.2.1'));
    expect([third.status, errorOf(third.body)]).toEqual([
      503,
      {
        error: 'unavailable',
        message: 'too many open subscriptions from this address; retry later',
      },
    ]);
    expect((await subscribe(port, from('192.0.2.2'))).status).toBe(200);
  });

  it('🔴 a stream that ends frees its slot', async () => {
    const limiter = createSubscriptionLimiter({ total: 1, perSubject: 1, perAddress: 1 });
    const port = await httpServer(limiter);
    const first = await subscribe(port, from('192.0.2.1'));
    expect(first.status).toBe(200);
    await openCount(limiter, 1);
    expect((await subscribe(port, from('192.0.2.1'))).status).toBe(503);
    first.close();
    await openCount(limiter, 0);
    expect((await subscribe(port, from('192.0.2.1'))).status).toBe(200);
  });

  it('per token: a second stream of one token is refused from any address', async () => {
    const limiter = createSubscriptionLimiter({ total: 10, perSubject: 1, perAddress: 10 });
    const port = await httpServer(limiter);
    const auth = { authorization: 'Bearer user-1' };
    expect((await subscribe(port, { ...auth, ...from('192.0.2.1') })).status).toBe(200);
    const again = await subscribe(port, { ...auth, ...from('192.0.2.2') });
    expect([again.status, errorOf(again.body).message]).toEqual([
      503,
      'too many open subscriptions for this token; retry later',
    ]);
    // Positive control: another token from the same address is served.
    expect(
      (await subscribe(port, { authorization: 'Bearer user-2', ...from('192.0.2.1') })).status
    ).toBe(200);
  });

  it('a refused token is invalid_token, and takes no slot', async () => {
    const limiter = createSubscriptionLimiter({ total: 10, perSubject: 10, perAddress: 10 });
    const port = await httpServer(limiter);
    const res = await subscribe(port, { authorization: 'Bearer nobody' });
    expect([res.status, errorOf(res.body).error]).toEqual([401, 'invalid_token']);
    expect(limiter.open()).toBe(0);
  });

  it('🔴 over the total or per-address cap, the token is never looked up', async () => {
    const limiter = createSubscriptionLimiter({ total: 1, perSubject: 10, perAddress: 10 });
    const port = await httpServer(limiter);
    expect((await subscribe(port, from('192.0.2.1'))).status).toBe(200);
    const before = verified;
    const res = await subscribe(port, { authorization: 'Bearer user-1', ...from('192.0.2.2') });
    expect([res.status, errorOf(res.body)]).toEqual([
      503,
      { error: 'unavailable', message: 'too many open subscriptions on this source; retry later' },
    ]);
    expect(verified).toBe(before);
    // Positive control: under the cap, the same request's token is looked up.
    const open = createSubscriptionLimiter({ total: 10, perSubject: 10, perAddress: 10 });
    const openPort = await httpServer(open);
    await subscribe(openPort, { authorization: 'Bearer user-1', ...from('192.0.2.2') });
    expect(verified).toBe(before + 1);
  });

  it('a snapshot that throws frees its slot', async () => {
    const limiter = createSubscriptionLimiter({ total: 1, perSubject: 1, perAddress: 1 });
    const port = await httpServer(limiter, failingSource());
    const res = await subscribe(port, from('192.0.2.1'));
    expect([res.status, errorOf(res.body).error]).toEqual([503, 'unavailable']);
    await openCount(limiter, 0);
  });
});

const Client = grpc.makeGenericClientConstructor(REGISTRY_SERVICE, 'Registry');
interface SourceClient {
  Subscribe(request: unknown, metadata: grpc.Metadata): grpc.ClientReadableStream<StreamEvent>;
}

/** One gRPC call: `live` (then held open), or the status it was refused with. */
function grpcSubscribe(
  port: number,
  metadata: Record<string, string>,
  onCall: (cancel: () => void) => void = () => undefined
): Promise<{ live: boolean; error?: { code: number; reason: string | null } }> {
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const md = new grpc.Metadata();
  for (const [name, value] of Object.entries(metadata)) md.set(name, value);
  const subscribe = (client as unknown as SourceClient).Subscribe;
  const call = subscribe.call(client, { schema: APPS, cursor: '', urns: [], filter: '' }, md);
  const abort = new AbortController();
  aborts.push(abort);
  abort.signal.addEventListener('abort', () => {
    call.cancel();
    client.close();
  });
  onCall(() => abort.abort());
  return new Promise((resolve) => {
    call.on('data', (e: StreamEvent) => {
      if (e.type === 'live') resolve({ live: true });
    });
    call.on('error', (err: grpc.ServiceError) =>
      resolve({
        live: false,
        error: { code: err.code, reason: errorInfoOf(err.metadata)?.reason ?? null },
      })
    );
  });
}

describe('🔴 over gRPC, the same caps, UNAVAILABLE / unavailable', () => {
  it('per address, read from the call metadata', async () => {
    const limiter = createSubscriptionLimiter({ total: 10, perSubject: 10, perAddress: 1 });
    const server = createGrpcServer(openSource(), { verifyToken, limiter });
    grpcServers.push(server);
    const port = await listenGrpc(server, 0);
    expect(await grpcSubscribe(port, from('192.0.2.1'))).toEqual({ live: true });
    expect(await grpcSubscribe(port, from('192.0.2.1'))).toEqual({
      live: false,
      error: { code: grpc.status.UNAVAILABLE, reason: 'unavailable' },
    });
    expect(await grpcSubscribe(port, from('192.0.2.2'))).toEqual({ live: true });
  });

  it('🔴 one limiter shared by both bindings caps their streams together', async () => {
    const limiter = createSubscriptionLimiter({ total: 1, perSubject: 10, perAddress: 10 });
    const port = await httpServer(limiter);
    const grpcServer = createGrpcServer(openSource(), { verifyToken, limiter });
    grpcServers.push(grpcServer);
    const grpcPort = await listenGrpc(grpcServer, 0);
    expect((await subscribe(port, from('192.0.2.1'))).status).toBe(200);
    expect(await grpcSubscribe(grpcPort, from('192.0.2.2'))).toEqual({
      live: false,
      error: { code: grpc.status.UNAVAILABLE, reason: 'unavailable' },
    });
  });

  it('🔴 a cancelled call frees its slot', async () => {
    const limiter = createSubscriptionLimiter({ total: 1, perSubject: 1, perAddress: 1 });
    const server = createGrpcServer(openSource(), { verifyToken, limiter });
    grpcServers.push(server);
    const port = await listenGrpc(server, 0);
    let cancel: () => void = () => undefined;
    expect(await grpcSubscribe(port, from('192.0.2.1'), (c) => (cancel = c))).toEqual({
      live: true,
    });
    await openCount(limiter, 1);
    cancel();
    await openCount(limiter, 0);
    expect(await grpcSubscribe(port, from('192.0.2.1'))).toEqual({ live: true });
  });

  it('a snapshot that throws frees its slot', async () => {
    const limiter = createSubscriptionLimiter({ total: 1, perSubject: 1, perAddress: 1 });
    const server = createGrpcServer(failingSource(), { verifyToken, limiter });
    grpcServers.push(server);
    const port = await listenGrpc(server, 0);
    expect(await grpcSubscribe(port, from('192.0.2.1'))).toEqual({
      live: false,
      error: { code: grpc.status.UNAVAILABLE, reason: 'unavailable' },
    });
    await openCount(limiter, 0);
  });
});
