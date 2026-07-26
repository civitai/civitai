import { describe, it, expect, vi, beforeEach } from 'vitest';

// withClusterRoutingRetry is the retry-after-rediscover guard for the TRANSIENT cluster ROUTING
// throw (the topology-churn 500 wave #2665 doesn't cover). During a next-redis-cluster topology
// change the node-redis client throws FLEET-WIDE BEFORE dispatching the command:
//   TypeError: Cannot read properties of undefined (reading 'replicas')
//     at RedisClusterSlots.getSlotRandomNode (cluster-slots.js:342)
// Because that getSlotRandomNode/NoSlot throw is PRE-DISPATCH (the command never reached a node),
// a bounded retry-after-rediscover is safe for reads AND writes (no double-execution). The
// reconnect rejections (ClientClosedError / DisconnectsClientError from a #2665 self-heal
// destroy()→flushAll) are AUDIT-EXCLUDED: flushAll rejects already-WRITTEN-and-maybe-applied
// commands with the same error, so retrying them could double-apply a non-idempotent write — they
// must re-throw. These pin: the predicate matches the PRE-DISPATCH routing throws and ONLY those
// (NOT the reconnect errors); the wrapper retries+recovers, exhausts+re-throws the ORIGINAL, never
// retries a non-transient error (incl. the reconnect rejections — write-safety), passes through
// when disabled, honors max/backoff, never double-executes the happy path, and is idempotent
// across a retried command. The module is PURE — its fallbacks are the built-in DEFAULT_*
// constants (true / 2 / [50,150]), the SAME defaults env.ts parses and client.ts injects — so the
// default-on and disabled branches are deterministic without any env mock (a package CANNOT import
// the app's `~/env/server`; cluster-selfheal.ts follows the same caller-supplied-config pattern).

import {
  isTransientClusterRoutingError,
  withClusterRoutingRetry,
  createNudgeDebouncer,
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

// A THIRD pre-dispatch shape: during topology churn `nodeClient(node)` (cluster-slots.js:213) is
// called with `node === undefined` (empty-topology / keyless-command edge, or a slot whose master
// is undefined) and reads `.connectPromise` off it → TypeError with a getClient/nodeClient frame
// (NOT getSlotRandomNode, NOT replicas|master). The node is selected at cluster/index.js:177 BEFORE
// the dispatch try/catch → provably pre-dispatch → write-safe to retry.
function nodeClientConnectPromiseThrow(): TypeError {
  const err = new TypeError("Cannot read properties of undefined (reading 'connectPromise')");
  err.stack = [
    "TypeError: Cannot read properties of undefined (reading 'connectPromise')",
    '    at RedisClusterSlots.nodeClient (/app/node_modules/@redis/client/dist/lib/cluster/cluster-slots.js:213:17)',
    '    at RedisClusterSlots.getClient (/app/node_modules/@redis/client/dist/lib/cluster/cluster-slots.js:330:21)',
    '    at RedisCluster._execute (/app/node_modules/@redis/client/dist/lib/cluster/index.js:177:40)',
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

  // AUDIT-INVERTED (was: "is TRUE … concurrent self-heal"). These reconnect rejections are NOT
  // transient for retry purposes: a #2665 self-heal reconnect's destroy() → flushAll(new
  // DisconnectsClientError()) rejects the #waitingForReply queue too — commands ALREADY WRITTEN to
  // the socket that the server may have ALREADY APPLIED before the teardown. The error name cannot
  // distinguish "never sent" from "sent-and-applied", so retrying could DOUBLE-EXECUTE a
  // non-idempotent write. The predicate must therefore return FALSE so the caller re-throws (#2665
  // invariant: a reconnect reject fails the caller).
  it('is FALSE for the reconnect ClientClosedError / DisconnectsClientError (post-dispatch → double-exec risk)', () => {
    expect(isTransientClusterRoutingError(namedError('ClientClosedError'))).toBe(false);
    expect(isTransientClusterRoutingError(namedError('DisconnectsClientError'))).toBe(false);
    // and by message text — still not transient
    expect(
      isTransientClusterRoutingError(new Error('The client is closed (ClientClosedError)'))
    ).toBe(false);
    expect(
      isTransientClusterRoutingError(new Error('Disconnects client (DisconnectsClientError)'))
    ).toBe(false);
  });

  // AUDIT-NARROWED: only the documented pre-dispatch routing fields (replicas/master) match; the
  // speculative `client`/`nodes` reads were dropped (not measured shapes, could mask app bugs).
  it("is FALSE for an undefined-read on a non-routing field (e.g. 'client'/'nodes' — speculative, dropped)", () => {
    expect(
      isTransientClusterRoutingError(
        new TypeError("Cannot read properties of undefined (reading 'client')")
      )
    ).toBe(false);
    expect(
      isTransientClusterRoutingError(
        new TypeError("Cannot read properties of undefined (reading 'nodes')")
      )
    ).toBe(false);
  });

  it("is still TRUE for the documented 'master' routing-field read", () => {
    expect(
      isTransientClusterRoutingError(
        new TypeError("Cannot read properties of undefined (reading 'master')")
      )
    ).toBe(true);
  });

  // AUDIT 🟡 (FIX #1): the THIRD pre-dispatch shape — nodeClient(undefined) reading 'connectPromise'
  // with a getClient/nodeClient frame. Provably pre-dispatch (cluster/index.js:177 selects the node
  // before the dispatch try/catch), so retrying is write-safe like the getSlotRandomNode shape.
  it("is TRUE for the nodeClient(undefined) 'reading connectPromise' TypeError (3rd pre-dispatch shape)", () => {
    expect(isTransientClusterRoutingError(nodeClientConnectPromiseThrow())).toBe(true);
  });

  it("is TRUE for a bare \"Cannot read properties of undefined (reading 'connectPromise')\" TypeError", () => {
    expect(
      isTransientClusterRoutingError(
        new TypeError("Cannot read properties of undefined (reading 'connectPromise')")
      )
    ).toBe(true);
  });

  // Symmetry with the replicas|master guard: the undefined/null co-occurrence is required, so a
  // 'connectPromise' read that does NOT co-occur with undefined/null does NOT match.
  it("is FALSE for a 'connectPromise' mention without an undefined/null co-occurrence (guard symmetry)", () => {
    expect(isTransientClusterRoutingError(new Error('connectPromise resolved late'))).toBe(false);
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

  it('the nodeClient connectPromise pre-dispatch throw also recovers on retry → counter "recovered"', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(nodeClientConnectPromiseThrow())
      .mockResolvedValueOnce('recovered-value');
    const rediscover = vi.fn();
    const onResult = vi.fn();

    const result = await withClusterRoutingRetry(exec, { rediscover, onResult, sleep: noSleep });

    expect(result).toBe('recovered-value');
    expect(exec).toHaveBeenCalledTimes(2); // initial + 1 retry — the new shape IS treated transient
    expect(rediscover).toHaveBeenCalledTimes(1);
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

  // WRITE-SAFETY (the path the audit flagged as untested): a DisconnectsClientError /
  // ClientClosedError from a concurrent #2665 self-heal reconnect can fire on an ALREADY-DISPATCHED,
  // possibly-already-applied write. The guard must NOT retry it (no rediscover, exec called exactly
  // once) and must re-throw the ORIGINAL error — otherwise a non-idempotent write could double-apply.
  it('write-safety: DisconnectsClientError is NOT retried — exec called once, original re-thrown (no double-exec)', async () => {
    const original = namedError('DisconnectsClientError', 'Disconnects client');
    const exec = vi.fn().mockRejectedValue(original);
    const rediscover = vi.fn();
    const onResult = vi.fn();

    await expect(
      withClusterRoutingRetry(exec, { rediscover, onResult, sleep: noSleep })
    ).rejects.toBe(original);

    expect(exec).toHaveBeenCalledTimes(1); // no retry → a write cannot double-apply
    expect(rediscover).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('write-safety: ClientClosedError is NOT retried — exec called once, original re-thrown', async () => {
    const original = namedError('ClientClosedError', 'The client is closed');
    const exec = vi.fn().mockRejectedValue(original);
    const rediscover = vi.fn();
    const onResult = vi.fn();

    await expect(
      withClusterRoutingRetry(exec, { rediscover, onResult, sleep: noSleep })
    ).rejects.toBe(original);

    expect(exec).toHaveBeenCalledTimes(1);
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

// createNudgeDebouncer time-gates the routing-retry REDISCOVERY NUDGE — NOT the retry. On
// civitai-dp-prod-api-heavy (~48k cluster-cmd/s) a sustained routing-throw stream fired the
// fire-and-forget triggerTopologyRediscovery nudge on EVERY throw, keeping a `_slots.rediscover()`
// perpetually re-scheduled → `#rediscover` scheduling churn (~3.9% active-JS-CPU on the busiest pod)
// that re-widens the empty-slot window → more throws. The debouncer collapses a throw storm to AT
// MOST ONE nudge per window. These pin: (a) debounce OFF/0 => byte-identical pass-through (fires
// EVERY call, exactly as before the gate), (b) debounce N ms => at most one fire per window under a
// burst with the FIRST always firing, and (c) — combined with withClusterRoutingRetry below — that
// gating the nudge does NOT weaken the retry: every command still retries + recovers.
describe('createNudgeDebouncer', () => {
  it('(a) disabled (debounceMs = 0) → byte-identical pass-through: fires EVERY call (unchanged)', () => {
    const fire = vi.fn();
    // Clock is irrelevant when disabled; supply a throwing clock to PROVE the disabled path never
    // reads it (no state, no time gate — exactly the pre-gate behavior).
    const debounce = createNudgeDebouncer(0, () => {
      throw new Error('disabled debouncer must not read the clock');
    });
    for (let i = 0; i < 25; i++) debounce(fire);
    expect(fire).toHaveBeenCalledTimes(25); // every throw nudges, as before the gate existed
  });

  it('(a) negative debounceMs also disables the gate (fires every call)', () => {
    const fire = vi.fn();
    const debounce = createNudgeDebouncer(-1);
    for (let i = 0; i < 5; i++) debounce(fire);
    expect(fire).toHaveBeenCalledTimes(5);
  });

  it('(b) debounce N ms → the FIRST nudge fires, subsequent nudges inside the window are suppressed', () => {
    let clock = 0;
    const now = () => clock;
    const fire = vi.fn();
    const debounce = createNudgeDebouncer(1000, now);

    // A throw BURST at t=0: 100 concurrent routing-retry calls all nudge, but only ONE rediscover
    // is actually scheduled (the churn we're cutting) — the rest are suppressed.
    for (let i = 0; i < 100; i++) debounce(fire);
    expect(fire).toHaveBeenCalledTimes(1);

    clock = 100; debounce(fire); // still inside the 1000ms window → suppressed
    clock = 999; debounce(fire); // boundary-1 → suppressed
    expect(fire).toHaveBeenCalledTimes(1);

    clock = 1000; debounce(fire); // window elapsed (>= debounceMs) → fires (2nd)
    expect(fire).toHaveBeenCalledTimes(2);

    clock = 1500; debounce(fire); // inside the new window → suppressed
    expect(fire).toHaveBeenCalledTimes(2);

    clock = 2001; debounce(fire); // next window → fires (3rd)
    expect(fire).toHaveBeenCalledTimes(3);
  });

  it('(b) a SUSTAINED throw stream over one window schedules exactly one rediscover, not one-per-throw', () => {
    let clock = 0;
    const now = () => clock;
    const fire = vi.fn();
    const debounce = createNudgeDebouncer(500, now);
    // 50 throws spread across 0..499ms — one per ~10ms, the self-feeding-loop shape.
    for (let i = 0; i < 50; i++) {
      clock = i * 10; // 0,10,...,490 — all inside the first 500ms window
      debounce(fire);
    }
    expect(fire).toHaveBeenCalledTimes(1); // 50 throws → 1 rediscover scheduled (was 50)
  });

  it('two independent debouncer instances keep separate windows (no shared module state)', () => {
    let clock = 0;
    const now = () => clock;
    const a = vi.fn();
    const b = vi.fn();
    const dA = createNudgeDebouncer(1000, now);
    const dB = createNudgeDebouncer(1000, now);
    dA(a); dB(b); // both fire (each first)
    clock = 100;
    dA(a); dB(b); // both suppressed
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

// (c) INTEGRATION — the nudge-vs-retry distinction under a shared debouncer. This is the core
// safety property: debouncing the NUDGE must NOT weaken the RETRY. We run many withClusterRoutingRetry
// calls (a throw storm) sharing ONE debouncer at a frozen clock — the exact production wiring, where
// instrumentCommands creates one debouncer shared across every concurrent _execute — and assert every
// command still retries + recovers while the actual rediscover fires only once per window.
describe('routing-retry with a shared nudge debouncer (nudge gated, retry NOT weakened)', () => {
  it('(c) storm of N commands sharing one debouncer: ALL recover, but rediscover fires ONCE per window', async () => {
    let clock = 0;
    const now = () => clock;
    const debounce = createNudgeDebouncer(1000, now);
    // The real rediscover side-effect (triggerTopologyRediscovery) that we want to fire at most once.
    const nudge = vi.fn();
    // The wired hook: a fire-and-forget debounced nudge, exactly as client.ts passes at :869.
    const rediscover = () => debounce(nudge);

    const recovered: string[] = [];
    // 20 concurrent commands, each throws the pre-dispatch routing error once then succeeds.
    const runOne = () => {
      const exec = vi
        .fn()
        .mockRejectedValueOnce(getSlotRandomNodeThrow())
        .mockResolvedValueOnce('ok');
      return withClusterRoutingRetry(exec, {
        rediscover,
        onResult: (r) => recovered.push(r),
        sleep: noSleep,
      });
    };

    const results = await Promise.all(Array.from({ length: 20 }, runOne));

    // RETRY path UNWEAKENED: every one of the 20 commands retried and recovered.
    expect(results).toEqual(Array(20).fill('ok'));
    expect(recovered).toEqual(Array(20).fill('recovered'));
    // NUDGE gated: the 20-command storm scheduled exactly ONE actual rediscover (was 20).
    expect(nudge).toHaveBeenCalledTimes(1);

    // Next window: a fresh storm schedules one more rediscover, and still recovers.
    clock = 2000;
    recovered.length = 0;
    const more = await Promise.all(Array.from({ length: 5 }, runOne));
    expect(more).toEqual(Array(5).fill('ok'));
    expect(recovered).toEqual(Array(5).fill('recovered'));
    expect(nudge).toHaveBeenCalledTimes(2); // one per window, not per throw
  });

  it('(c) with debounce DISABLED (0) the nudge fires on every retry — identical to today', async () => {
    const debounce = createNudgeDebouncer(0); // disabled
    const nudge = vi.fn();
    const rediscover = () => debounce(nudge);

    // A single command that exhausts (max 2 retries) → today it nudges once per retry = 2 nudges.
    const original = getSlotRandomNodeThrow();
    const exec = vi.fn().mockRejectedValue(original);
    await expect(
      withClusterRoutingRetry(exec, { rediscover, sleep: noSleep })
    ).rejects.toBe(original);

    expect(exec).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(nudge).toHaveBeenCalledTimes(2); // one per retry — unchanged from pre-gate behavior
  });
});
