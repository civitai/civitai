import { describe, it, expect, vi, beforeEach } from 'vitest';

// withClusterRoutingRetry is the retry-after-rediscover guard for the TRANSIENT cluster ROUTING
// throw (the topology-churn 500 wave #2665 doesn't cover). During a next-redis-cluster topology
// change the node-redis client throws FLEET-WIDE BEFORE dispatching the command:
//   TypeError: Cannot read properties of undefined (reading 'replicas')
//     at RedisClusterSlots.getSlotRandomNode (cluster-slots.js:342)
// Because the command NEVER reached a node, a bounded retry-after-rediscover is safe for reads
// AND writes (no double-execution). These pin: the predicate matches the transient routing
// throws and ONLY those; the wrapper retries+recovers, exhausts+re-throws the ORIGINAL, never
// retries a non-transient error, passes through when disabled, honors max/backoff, never
// double-executes the happy path, and is idempotent across a retried command. env is mocked so
// both default-on and disabled branches are deterministic (mirrors metric-write-failsoft.test.ts).
vi.mock('~/env/server', () => ({
  env: {
    REDIS_CLUSTER_ROUTING_RETRY_ENABLED: true,
    REDIS_CLUSTER_ROUTING_RETRY_MAX: 2,
    REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MS: 50,
    REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MAX_MS: 150,
  },
}));

import {
  isTransientClusterRoutingError,
  withClusterRoutingRetry,
} from '../cluster-routing-retry';

// The exact fleet-wide throw measured during a live rolling update (getSlotRandomNode reads
// `.replicas` off an undefined slot entry while the slot map is mid-rediscovery).
function getSlotRandomNodeThrow(): TypeError {
  const err = new TypeError("Cannot read properties of undefined (reading 'replicas')");
  err.stack = [
    "TypeError: Cannot read properties of undefined (reading 'replicas')",
    '    at RedisClusterSlots.getSlotRandomNode (/app/node_modules/@redis/client/dist/lib/cluster/cluster-slots.js:342:19)',
    '    at RedisCluster._execute (/app/node_modules/@redis/client/dist/lib/cluster/index.js:123:40)',
  ].join('\n');
  return err;
}

function namedError(name: string, message = 'boom'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

// A no-op sleep so tests don't spend real backoff time but still exercise the retry path.
const noSleep = () => Promise.resolve();

describe('isTransientClusterRoutingError', () => {
  it('is TRUE for the getSlotRandomNode "reading replicas" TypeError (the measured throw)', () => {
    expect(isTransientClusterRoutingError(getSlotRandomNodeThrow())).toBe(true);
  });

  it('is TRUE for the bare "Cannot read properties of undefined (reading \'replicas\')" TypeError', () => {
    expect(
      isTransientClusterRoutingError(
        new TypeError("Cannot read properties of undefined (reading 'replicas')")
      )
    ).toBe(true);
  });

  it('is TRUE for a NoSlot / "slot not served" error', () => {
    expect(isTransientClusterRoutingError(new Error('NoSlot for key'))).toBe(true);
    expect(isTransientClusterRoutingError(new Error('slot not served by any node'))).toBe(true);
  });

  it('is TRUE for the reconnect ClientClosedError / DisconnectsClientError (concurrent self-heal)', () => {
    expect(isTransientClusterRoutingError(namedError('ClientClosedError'))).toBe(true);
    expect(isTransientClusterRoutingError(namedError('DisconnectsClientError'))).toBe(true);
    // also by message text, in case .name is generic
    expect(isTransientClusterRoutingError(new Error('The client is closed (ClientClosedError)'))).toBe(
      true
    );
  });

  it('is FALSE for a real WRONGTYPE redis error (must still throw)', () => {
    expect(
      isTransientClusterRoutingError(
        new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
      )
    ).toBe(false);
  });

  it('is FALSE for an auth failure and a CROSSSLOT key-distribution bug', () => {
    expect(isTransientClusterRoutingError(new Error('NOAUTH Authentication required'))).toBe(false);
    expect(
      isTransientClusterRoutingError(new Error("CROSSSLOT Keys don't hash to the same slot"))
    ).toBe(false);
  });

  it('is FALSE for an unrelated app TypeError (a real bug, not a routing throw)', () => {
    expect(
      isTransientClusterRoutingError(
        new TypeError("Cannot read properties of undefined (reading 'userId')")
      )
    ).toBe(false);
  });

  it('is FALSE for null / undefined / non-error values', () => {
    expect(isTransientClusterRoutingError(null)).toBe(false);
    expect(isTransientClusterRoutingError(undefined)).toBe(false);
    expect(isTransientClusterRoutingError(42)).toBe(false);
    expect(isTransientClusterRoutingError({})).toBe(false);
  });

  it('is TRUE for a string error mentioning getSlotRandomNode (defensive, non-Error throws)', () => {
    expect(isTransientClusterRoutingError('getSlotRandomNode failed: undefined')).toBe(true);
  });
});

describe('withClusterRoutingRetry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: calls exec EXACTLY once, no rediscover, no counter', async () => {
    const exec = vi.fn().mockResolvedValue('value');
    const rediscover = vi.fn();
    const onResult = vi.fn();
    const result = await withClusterRoutingRetry(exec, { rediscover, onResult, sleep: noSleep });
    expect(result).toBe('value');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(rediscover).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('transient on first call → rediscover → retry SUCCEEDS → counter "recovered"', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(getSlotRandomNodeThrow())
      .mockResolvedValueOnce('recovered-value');
    const rediscover = vi.fn();
    const onResult = vi.fn();

    const result = await withClusterRoutingRetry(exec, { rediscover, onResult, sleep: noSleep });

    expect(result).toBe('recovered-value');
    expect(exec).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('recovered');
  });

  it('persistent transient error → exhausts max retries → rediscover N times → RE-THROWS THE ORIGINAL → counter "exhausted"', async () => {
    const original = getSlotRandomNodeThrow();
    const exec = vi.fn().mockRejectedValue(original);
    const rediscover = vi.fn();
    const onResult = vi.fn();

    await expect(
      withClusterRoutingRetry(exec, { rediscover, onResult, sleep: noSleep })
    ).rejects.toBe(original); // the ORIGINAL error object, not a wrapped one

    expect(exec).toHaveBeenCalledTimes(3); // 1 initial + 2 retries (max=2)
    expect(rediscover).toHaveBeenCalledTimes(2); // one rediscover per retry
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('exhausted');
  });

  it('NON-transient error → NO rediscover, NO retry, throws immediately (real WRONGTYPE)', async () => {
    const wrong = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    const exec = vi.fn().mockRejectedValue(wrong);
    const rediscover = vi.fn();
    const onResult = vi.fn();

    await expect(
      withClusterRoutingRetry(exec, { rediscover, onResult, sleep: noSleep })
    ).rejects.toBe(wrong);

    expect(exec).toHaveBeenCalledTimes(1); // no retry
    expect(rediscover).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('disabled via env-style flag → pure pass-through (no retry, no rediscover) even on a transient error', async () => {
    const original = getSlotRandomNodeThrow();
    const exec = vi.fn().mockRejectedValue(original);
    const rediscover = vi.fn();
    const onResult = vi.fn();

    await expect(
      withClusterRoutingRetry(exec, { enabled: false, rediscover, onResult, sleep: noSleep })
    ).rejects.toBe(original);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(rediscover).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('disabled → happy path still returns the value with exactly one exec call', async () => {
    const exec = vi.fn().mockResolvedValue('ok');
    const result = await withClusterRoutingRetry(exec, { enabled: false });
    expect(result).toBe('ok');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('honors a configured maxRetries (e.g. 1 → 2 total attempts, 1 rediscover)', async () => {
    const original = getSlotRandomNodeThrow();
    const exec = vi.fn().mockRejectedValue(original);
    const rediscover = vi.fn();

    await expect(
      withClusterRoutingRetry(exec, { maxRetries: 1, rediscover, sleep: noSleep })
    ).rejects.toBe(original);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(rediscover).toHaveBeenCalledTimes(1);
  });

  it('maxRetries=0 → no retry but still re-throws the original transient error', async () => {
    const original = getSlotRandomNodeThrow();
    const exec = vi.fn().mockRejectedValue(original);
    const rediscover = vi.fn();
    const onResult = vi.fn();

    await expect(
      withClusterRoutingRetry(exec, { maxRetries: 0, rediscover, onResult, sleep: noSleep })
    ).rejects.toBe(original);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(rediscover).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('exhausted');
  });

  it('honors the configured backoff: sleeps the right durations before each retry', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(getSlotRandomNodeThrow())
      .mockRejectedValueOnce(getSlotRandomNodeThrow())
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withClusterRoutingRetry(exec, {
      backoffMs: [50, 150],
      rediscover: vi.fn(),
      sleep,
    });

    expect(result).toBe('ok');
    expect(sleep).toHaveBeenNthCalledWith(1, 50);
    expect(sleep).toHaveBeenNthCalledWith(2, 150);
  });

  it('reuses the LAST backoff value when retries exceed the backoff array length', async () => {
    const original = getSlotRandomNodeThrow();
    const exec = vi.fn().mockRejectedValue(original);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withClusterRoutingRetry(exec, {
        maxRetries: 3,
        backoffMs: [50], // shorter than the retry count
        rediscover: vi.fn(),
        sleep,
      })
    ).rejects.toBe(original);

    // 3 retries, backoff array length 1 → 50 reused each time
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 50);
    expect(sleep).toHaveBeenNthCalledWith(3, 50);
  });

  it('a recovering write/mutation is NOT double-executed: exec is invoked once per attempt, not re-run after success', async () => {
    // Models a WRITE that fails routing on attempt 1 (never reached a node) and succeeds on the
    // retry. exec call count == attempts == 2, and after the success no further calls occur — so
    // the underlying SET/HSET ran exactly once against a node (no double-apply).
    let nodeWrites = 0;
    const exec = vi.fn().mockImplementation(() => {
      // simulate: routing happens BEFORE the node write; first call throws pre-dispatch
      if (exec.mock.calls.length === 1) return Promise.reject(getSlotRandomNodeThrow());
      nodeWrites += 1; // the write only lands once a node is selected
      return Promise.resolve('OK');
    });

    const result = await withClusterRoutingRetry(exec, { rediscover: vi.fn(), sleep: noSleep });
    expect(result).toBe('OK');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(nodeWrites).toBe(1); // executed against a node EXACTLY once
  });

  it('a throwing onResult hook never breaks the guard (recovered path still returns)', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(getSlotRandomNodeThrow())
      .mockResolvedValueOnce('value');
    const onResult = vi.fn().mockImplementation(() => {
      throw new Error('counter blew up');
    });
    await expect(
      withClusterRoutingRetry(exec, { rediscover: vi.fn(), onResult, sleep: noSleep })
    ).resolves.toBe('value');
  });

  it('a throwing rediscover never masks the original error on exhaustion', async () => {
    const original = getSlotRandomNodeThrow();
    const exec = vi.fn().mockRejectedValue(original);
    const rediscover = vi.fn().mockRejectedValue(new Error('rediscover failed'));

    await expect(
      withClusterRoutingRetry(exec, { rediscover, sleep: noSleep })
    ).rejects.toBe(original); // still the ORIGINAL routing error, not the rediscover error
  });

  it('works without a rediscover hook (retries still occur)', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(getSlotRandomNodeThrow())
      .mockResolvedValueOnce('ok');
    const result = await withClusterRoutingRetry(exec, { sleep: noSleep });
    expect(result).toBe('ok');
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
