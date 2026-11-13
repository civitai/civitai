// The event engine's cluster client keeps node-redis 5.x behaviour on node-redis 6: RESP2, no
// command timeout, a 5 s keepalive delay — on the client and on its duplicate() (the pub/sub
// connections). Hermetic: nothing is connected; what is read is the state node-redis 6.3.0 keeps
// (RedisCluster `_options`, which it hands to every node connection, and `_commandOptions`, which
// it sends with every routed command). What a server sees is checked by
// packages/civitai-redis/src/__tests__/client-defaults.integration.test.ts for the package's own
// cluster client.
import net from 'node:net';
import { expect, test } from 'vitest';
import { createCluster } from 'redis';
import { createEngineCluster } from '@/services/redis-cluster-client';

const url = new URL('redis://:pw@127.0.0.1:6379');

test('pins RESP2, no command timeout and a 5 s keepalive delay', () => {
  const cluster: any = createEngineCluster(url);
  expect(cluster._self._options.RESP).toBe(2);
  expect(cluster._commandOptions).toEqual({ timeout: undefined });
  expect('timeout' in cluster._commandOptions).toBe(true); // toEqual alone also matches {}
  expect(cluster._self._options.defaults.socket.keepAliveInitialDelay).toBe(5000);
  expect(cluster._self._options.defaults.password).toBe('pw');
});

test('duplicate() keeps them (the pub/sub connections)', () => {
  const dup: any = (createEngineCluster(url) as any).duplicate();
  expect(dup._self._options.RESP).toBe(2);
  expect(dup._commandOptions).toEqual({ timeout: undefined });
  expect('timeout' in dup._commandOptions).toBe(true);
  expect(dup._self._options.defaults.socket.keepAliveInitialDelay).toBe(5000);
});

test('control: an unpinned node-redis 6 cluster has the 6.x defaults', () => {
  const raw: any = createCluster({ rootNodes: [{ url: 'redis://127.0.0.1:6379' }] });
  expect(raw._self._options.RESP).toBeUndefined(); // RESP3 at connect (DEFAULT_RESP)
  expect(raw._commandOptions).toEqual({ timeout: 5000 });
});

test('REDIS_SOCKET_TIMEOUT_MS=0 turns the socket timeout off (the off-switch)', () => {
  process.env.REDIS_SOCKET_TIMEOUT_MS = '0';
  try {
    const cluster: any = createEngineCluster(url);
    expect(cluster._self._options.defaults.socket.socketTimeout).toBeUndefined();
  } finally {
    delete process.env.REDIS_SOCKET_TIMEOUT_MS;
  }
});

test('pins a 10 s socket inactivity timeout with a keepalive PING below it', () => {
  const cluster: any = createEngineCluster(url);
  expect(cluster._self._options.defaults.socket.socketTimeout).toBe(10_000);
  expect(cluster._self._options.defaults.pingInterval).toBe(5_000);
});

// A node that accepts the connection and then never answers: without a socket timeout the connect (and any
// command parked on that socket) waits indefinitely. Measured: a bare cluster connect is still pending at
// 4 s; with a 500 ms socket timeout it rejects at ~0.5 s.
test('gives up on a node that accepts and never answers, within the socket timeout', async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => void sockets.add(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  const cluster: any = createEngineCluster(new URL(`redis://127.0.0.1:${port}`), {
    socketTimeoutMs: 500,
  });
  cluster.on('error', () => undefined);
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      cluster.connect().then(
        () => 'connected',
        (err: Error) => err
      ),
      new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), 4000))),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    clearTimeout(timer);
    await cluster.destroy?.();
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((r) => server.close(() => r()));
  }
});
