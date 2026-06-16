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
  return {
    createClient: vi.fn(noopClient),
    createCluster: vi.fn(noopClient),
    createSentinel: vi.fn(noopClient),
    RESP_TYPES: { BLOB_STRING: 'BLOB_STRING' },
  };
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
 *    and client-error handlers to the underlying client.
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

  describe('listener wiring', () => {
    it('attaches handlers for both topology-change and client-error', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();

      attachSysSentinelListeners(sentinel.client, ctx);

      expect(sentinel.on).toHaveBeenCalledTimes(2);
      expect(sentinel.on).toHaveBeenCalledWith('topology-change', expect.any(Function));
      expect(sentinel.on).toHaveBeenCalledWith('client-error', expect.any(Function));
      expect(sentinel.handlers.has('topology-change')).toBe(true);
      expect(sentinel.handlers.has('client-error')).toBe(true);
    });

    it('does not attach any other listeners (no surprise side effects)', () => {
      const sentinel = makeFakeSentinel();
      attachSysSentinelListeners(sentinel.client, makeCtx());
      // Exactly the two we expect — guards against drift adding a third
      // listener with mismatched label cardinality.
      expect(sentinel.handlers.size).toBe(2);
    });
  });

  describe('log shape — topology-change', () => {
    it('renders host, port, and type as bracketed key=value pairs', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      sentinel.emit('topology-change', {
        type: 'master-change',
        node: { host: '10.244.1.5', port: 6379 },
      });

      expect(ctx.log).toHaveBeenCalledTimes(1);
      const msg = ctx.log.mock.calls[0]?.[0] as string;
      expect(msg).toContain('Redis sentinel topology change');
      expect(msg).toContain('type=master-change');
      expect(msg).toContain('host=10.244.1.5');
      expect(msg).toContain('port=6379');
    });

    it('passes the raw event through as a trailing log argument', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      const event = { type: 'master-change', node: { host: 'h', port: 1 }, extra: 'detail' };
      sentinel.emit('topology-change', event);

      // First arg = string, second arg = original event (preserves the
      // existing pattern in client.ts of passing the full payload through).
      expect(ctx.log.mock.calls[0]?.[1]).toBe(event);
    });
  });

  describe('log shape — client-error', () => {
    it('renders host, port, and type as bracketed key=value pairs', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      sentinel.emit('client-error', {
        type: 'master',
        node: { host: '10.244.2.7', port: 6379 },
        error: new Error('ECONNRESET'),
      });

      expect(ctx.log).toHaveBeenCalledTimes(1);
      const msg = ctx.log.mock.calls[0]?.[0] as string;
      expect(msg).toContain('Redis sentinel sub-client error');
      expect(msg).toContain('type=master');
      expect(msg).toContain('host=10.244.2.7');
      expect(msg).toContain('port=6379');
    });

    it('prefers event.error over the raw event for the trailing log argument', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      const error = new Error('ETIMEDOUT');
      sentinel.emit('client-error', {
        type: 'replica',
        node: { host: 'h', port: 1 },
        error,
      });

      // Loki + alert routing reads the trailing arg; error gives us stack info.
      expect(ctx.log.mock.calls[0]?.[1]).toBe(error);
    });
  });

  describe('counter increments', () => {
    it('increments the topology counter with {type, host, deployment}', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx('civitai-dp-prod-primary-xyz');
      attachSysSentinelListeners(sentinel.client, ctx);

      sentinel.emit('topology-change', {
        type: 'master-change',
        node: { host: '10.244.1.5', port: 6379 },
      });

      expect(ctx.topologyCounter.labels).toHaveBeenCalledTimes(1);
      expect(ctx.topologyCounter.labels).toHaveBeenCalledWith({
        type: 'master-change',
        host: '10.244.1.5',
        deployment: 'civitai-dp-prod-primary-xyz',
      });
      expect(ctx.topologyCounter.inc).toHaveBeenCalledTimes(1);
      // The error counter is untouched.
      expect(ctx.errorCounter.labels).not.toHaveBeenCalled();
    });

    it('increments the error counter with {type, host, deployment}', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx('civitai-dp-prod-api-abc');
      attachSysSentinelListeners(sentinel.client, ctx);

      sentinel.emit('client-error', {
        type: 'master',
        node: { host: '10.244.2.7', port: 6379 },
        error: new Error('ECONNRESET'),
      });

      expect(ctx.errorCounter.labels).toHaveBeenCalledTimes(1);
      expect(ctx.errorCounter.labels).toHaveBeenCalledWith({
        type: 'master',
        host: '10.244.2.7',
        deployment: 'civitai-dp-prod-api-abc',
      });
      expect(ctx.errorCounter.inc).toHaveBeenCalledTimes(1);
      expect(ctx.topologyCounter.labels).not.toHaveBeenCalled();
    });

    it('increments once per event, not once per listener (no double-counting)', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      sentinel.emit('topology-change', {
        type: 'master-change',
        node: { host: 'h', port: 1 },
      });
      sentinel.emit('topology-change', {
        type: '+switch-master',
        node: { host: 'h', port: 1 },
      });

      expect(ctx.topologyCounter.inc).toHaveBeenCalledTimes(2);
    });
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

    it('handles an event with no node (client-error)', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      expect(() =>
        sentinel.emit('client-error', { type: 'sentinel', error: new Error('boom') })
      ).not.toThrow();

      const msg = ctx.log.mock.calls[0]?.[0] as string;
      expect(msg).toContain('host=?');
      expect(msg).toContain('port=?');

      expect(ctx.errorCounter.labels).toHaveBeenCalledWith({
        type: 'sentinel',
        host: '?',
        deployment: expect.any(String),
      });
      expect(ctx.errorCounter.inc).toHaveBeenCalledTimes(1);
    });

    it('handles a completely empty event ({}) without crashing', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      expect(() => sentinel.emit('topology-change', {})).not.toThrow();
      expect(() => sentinel.emit('client-error', {})).not.toThrow();

      // Both counters still fire so we don't silently lose error events to
      // null-pointer guards.
      expect(ctx.topologyCounter.inc).toHaveBeenCalledTimes(1);
      expect(ctx.errorCounter.inc).toHaveBeenCalledTimes(1);

      // The "unknown" type fallback IS the cardinality-budget escape valve.
      expect(ctx.topologyCounter.labels).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unknown', host: '?' })
      );
      expect(ctx.errorCounter.labels).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unknown', host: '?' })
      );
    });

    it('handles a null event without crashing', () => {
      const sentinel = makeFakeSentinel();
      const ctx = makeCtx();
      attachSysSentinelListeners(sentinel.client, ctx);

      expect(() => sentinel.emit('topology-change', null)).not.toThrow();
      expect(() => sentinel.emit('client-error', null)).not.toThrow();
      expect(ctx.topologyCounter.inc).toHaveBeenCalledTimes(1);
      expect(ctx.errorCounter.inc).toHaveBeenCalledTimes(1);
    });
  });
});
