// The event engine's cluster client keeps node-redis 5.x behaviour on node-redis 6: RESP2, no
// command timeout, a 5 s keepalive delay — on the client and on its duplicate() (the pub/sub
// connections). Hermetic: nothing is connected; what is read is the state node-redis 6.3.0 keeps
// (RedisCluster `_options`, which it hands to every node connection, and `_commandOptions`, which
// it sends with every routed command). What a server sees is checked by
// packages/civitai-redis/src/__tests__/client-defaults.integration.test.ts for the package's own
// cluster client.
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
