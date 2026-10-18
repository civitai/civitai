import { describe, it, expect, vi, beforeEach } from 'vitest';

// The `redis` npm package opens TCP sockets at module load via getCacheClient()
// at the bottom of client.ts. Stub the three factories to no-op event emitters
// so the import is safe in the test environment.
vi.mock('redis', () => {
  const noopClient = () => {
    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    const client: any = {
      on(event: string, cb: (...args: any[]) => void) {
        (handlers[event] ??= []).push(cb);
        return client;
      },
      connect: vi.fn(() => Promise.resolve()),
      withTypeMapping: vi.fn(() => client),
      // SCAN/COMMANDS exist as empty stubs — they're only invoked at runtime
      // by code paths the listener tests don't touch.
      scan: vi.fn(),
      mGet: vi.fn(),
      del: vi.fn(),
      unlink: vi.fn(),
    };
    return client;
  };
  // `default` mirrors the named exports: pre-bundling wraps this CJS dep for interop, so the
  // consumer resolves through `default` and a factory without one yields undefined. It fails
  // by collecting almost no tests rather than by going red, so the check is the collected
  // count. `importOriginal` does NOT cover this — a spread copies named exports and does not
  // synthesise a `default`.
  const mocked = {
    createClient: vi.fn(noopClient),
    createCluster: vi.fn(noopClient),
    createSentinel: vi.fn(noopClient),
    RESP_TYPES: { BLOB_STRING: 'BLOB_STRING' },
  };
  return { ...mocked, default: mocked };
});

// Block resource-data / Flipt imports from running real-network init.
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { REDIS_CLUSTER_ENHANCED_FAILOVER: 'redis_cluster_enhanced_failover' },
  isFlipt: vi.fn(() => Promise.resolve(false)),
}));

import { attachSysSentinelListeners } from '~/server/redis/client';

/**
 * Round-3 audit fix coverage:
 *  - Listener wiring: attachSysSentinelListeners attaches both topology-change
 *    and error handlers to the underlying client (RedisSentinel forwards its
 *    connections' errors as `error`, with passthroughClientErrorEvents).
 *  - Log shape: the destructured event.node.{host,port} fields appear in the
 *    log string as bracketed key=value pairs so Loki regex can extract them.
 *  - Counter increments: each event fires exactly one .inc() against the
 *    correct counter with {type, host, deployment} labels.
 *  - Null-safety: a missing event.node still produces a sensible '?' placeholder
 *    log line and a 'unknown'/'?' label set (no crash, no NaN labels).
 */

type Handler = (event: any) => void;

function makeFakeSentinel() {
  const handlers = new Map<string, Handler>();
  const on = vi.fn((event: string, listener: Handler) => {
    handlers.set(event, listener);
  });
  return {
    client: { on },
    on,
    emit(event: string, payload: any) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`No handler registered for ${event}`);
      handler(payload);
    },
    handlers,
  };
}

function makeFakeCounter() {
  const inc = vi.fn();
  const labels = vi.fn(() => ({ inc }));
  return { labels, inc };
}

function makeCtx(deployment = 'civitai-dp-prod-primary-abc123') {
  const log = vi.fn();
  const topologyCounter = makeFakeCounter();
  const errorCounter = makeFakeCounter();
  return {
    deployment,
    log,
    topologyCounter,
    errorCounter,
  };
}

describe('attachSysSentinelListeners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('null-safety', () => {
    it('handles an event with no node (topology-change)', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      // No throw on missing node — the destructure has to be guarded.
      expect(() => sentinel.emit('topology-change', { type: 'sentinel-change' })).not.toThrow();

      const msg = ctx.log.mock.calls[0]?.[0] as string;
      expect(msg).toContain('host=?');
      expect(msg).toContain('port=?');
      expect(msg).toContain('type=sentinel-change');

      expect(ctx.topologyCounter.labels).toHaveBeenCalledWith({
        type: 'sentinel-change',
        host: '?',
        deployment: expect.any(String),
      });
      expect(ctx.topologyCounter.inc).toHaveBeenCalledTimes(1);
    });

    it('counts a forwarded Sentinel connection error with its node', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      // The shape @redis/client 6.3.0 forwards (sentinel/index.js transform).
      expect(() =>
        sentinel.emit(
          'error',
          new Error('Sentinel Client (h1:26379): boom', { cause: new Error('boom') })
        )
      ).not.toThrow();

      const msg = ctx.log.mock.calls[0]?.[0] as string;
      expect(msg).toContain('host=h1');
      expect(msg).toContain('port=26379');

      expect(ctx.errorCounter.labels).toHaveBeenCalledWith({
        type: 'SENTINEL',
        host: 'h1',
        deployment: expect.any(String),
      });
      expect(ctx.errorCounter.inc).toHaveBeenCalledTimes(1);
    });

    it('handles a completely empty event ({}) without crashing', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      expect(() => sentinel.emit('topology-change', {})).not.toThrow();
      expect(() => sentinel.emit('error', {})).not.toThrow();

      // The topology counter still fires so we don't silently lose events to
      // null-pointer guards. An `error` that is not a forwarded connection error
      // is not counted (getBaseClient's generic listener logs it).
      expect(ctx.topologyCounter.inc).toHaveBeenCalledTimes(1);
      expect(ctx.errorCounter.inc).not.toHaveBeenCalled();

      // The "unknown" type fallback IS the cardinality-budget escape valve.
      expect(ctx.topologyCounter.labels).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unknown', host: '?' })
      );
    });

    it('handles a null event without crashing', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      expect(() => sentinel.emit('topology-change', null)).not.toThrow();
      expect(() => sentinel.emit('error', null)).not.toThrow();
      expect(ctx.topologyCounter.inc).toHaveBeenCalledTimes(1);
      expect(ctx.errorCounter.inc).not.toHaveBeenCalled();
    });
  });
});
