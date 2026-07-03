import { createClient, createCluster, createSentinel, RESP_TYPES } from 'redis';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the node-redis v5.8.3 Sentinel `withTypeMapping` poisoning bug.
 *
 * `packages/civitai-redis/src/client.ts` builds the `.packed` (Buffer) API by calling
 * `withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })`. That is *supposed* to return a
 * NEW client that returns Buffers while the original keeps returning strings.
 *
 * It holds for the single-node (`RedisClient`) and cluster (`RedisCluster`) paths — both
 * `_commandOptionsProxy` implementations set a proxy-LOCAL `_commandOptions` and never touch
 * the base client. But `RedisSentinel._commandOptionsProxy` (sentinel/index.js:220-228) writes
 * `proxy._self.#commandOptions = { …, typeMapping: … }`, and `_self` IS the shared base sentinel
 * client. So on the Sentinel path (prod sysRedis) a SINGLE `withTypeMapping` call permanently
 * rewrites the base client's DEFAULT command options → every plain `sMembers`/`get`/`hGet`/…
 * returns Buffers, breaking session revocation / feature flags / New Order.
 *
 * The fix (client.ts `getClient`) gives the Sentinel buffer client its OWN dedicated base
 * connection so the mutation lands on a private base, leaving the shared serving client clean.
 *
 * These tests exercise the exact node-redis construction boundary the fix relies on WITHOUT
 * opening a socket: `createSentinel`/`createCluster`/`createClient` construct clients but only
 * `.connect()` opens TCP, and `withTypeMapping` mutates command options purely client-side. So
 * the whole file is hermetic and CI-safe (no live Sentinel required).
 *
 * `commandOptions` is the public getter that reflects a client's default command options
 * (returns `_self.#commandOptions` for sentinel/single; cluster exposes `_commandOptions`).
 */

const BUFFER_MAPPING = { [RESP_TYPES.BLOB_STRING]: Buffer } as const;

const makeSentinel = () =>
  createSentinel({
    name: 'sysmaster',
    sentinelRootNodes: [{ host: '127.0.0.1', port: 26379 }],
  });

describe('sentinel withTypeMapping poisoning (node-redis v5.8.3)', () => {
  it('ROOT CAUSE: deriving the buffer client from the SHARED sentinel base poisons the base', () => {
    // This is the defect the fix avoids — asserted so a node-redis upgrade that fixes it upstream
    // surfaces here (this expectation would flip) rather than silently.
    const base = makeSentinel();
    expect(base.commandOptions?.typeMapping).toBeUndefined();

    // The old code path: `client.withTypeMapping(...)` on the serving base.
    base.withTypeMapping(BUFFER_MAPPING);

    // BUG: the base's own default command options were mutated in place — every plain read on
    // `base` would now decode as a Buffer.
    expect(base.commandOptions?.typeMapping).toBe(BUFFER_MAPPING);
  });

  it('FIX: a DEDICATED sentinel base for the buffer client leaves the serving base untouched', () => {
    // Mirrors the fix in getClient: the plain/serving client and the buffer client are built from
    // two independent getBaseClient() sentinel connections.
    const servingBase = makeSentinel();
    const bufferBase = makeSentinel();

    bufferBase.withTypeMapping(BUFFER_MAPPING);

    // The serving client's command options are never mutated → plain reads still decode to strings.
    expect(servingBase.commandOptions?.typeMapping).toBeUndefined();
    // The dedicated buffer base is the only one that carries the Buffer mapping (harmless — it is
    // only ever used in Buffer mode).
    expect(bufferBase.commandOptions?.typeMapping).toBe(BUFFER_MAPPING);
    // They are distinct client instances (no shared `_self`).
    expect(servingBase).not.toBe(bufferBase);
  });

  it('SCOPING: the cluster client is NOT affected — shared derivation is safe there', () => {
    // Justifies keeping the cheap shared `withTypeMapping` on the cluster path (a cluster client is
    // many sockets; a second one would double them for no benefit).
    const cluster = createCluster({ rootNodes: [{ url: 'redis://127.0.0.1:6379' }] });
    // `_commandOptions` is a protected field on RedisCluster (no public `commandOptions` getter
    // like the single-node/sentinel clients), so read it through a narrow cast.
    const clusterOpts = () =>
      (cluster as unknown as { _commandOptions?: { typeMapping?: unknown } })._commandOptions;
    expect(clusterOpts()?.typeMapping).toBeUndefined();

    cluster.withTypeMapping(BUFFER_MAPPING);

    // Cluster `_commandOptionsProxy` sets a proxy-LOCAL `_commandOptions`; the base is untouched.
    expect(clusterOpts()?.typeMapping).toBeUndefined();
  });

  it('SCOPING: the single-node (dev) client is NOT affected either', () => {
    const single = createClient({ url: 'redis://127.0.0.1:6379' });
    expect(single.commandOptions?.typeMapping).toBeUndefined();

    single.withTypeMapping(BUFFER_MAPPING);

    expect(single.commandOptions?.typeMapping).toBeUndefined();
  });
});
