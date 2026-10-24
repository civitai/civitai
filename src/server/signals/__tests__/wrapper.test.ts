import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// withSignals(): the deadline must cover queue wait + execution, the queue must
// be bounded, and queue-side failures must feed the circuit breaker. Motivated
// by a signals-service outage where a client reconnect storm queued >1,000
// calls per pod in front of the limiter; queued calls waited until the upstream
// proxy's 30s timeout and the circuit almost never opened because queue wait
// was never counted as a failure.

// Mutable env so each test can size the limiter / queue / circuit. The wrapper
// reads concurrency at module load and everything else per call, so tests set
// values BEFORE the dynamic import in `load()`.
const envMock = vi.hoisted(() => ({} as Record<string, number>));
vi.mock('~/env/server', () => ({ env: envMock }));

// Hand-listed rather than `importOriginal`: the real `~/server/prom/client`
// imports the DB pools at load, and the wrapper only needs these helpers.
// Each counter is captured by name so tests can assert which fast-fail path ran
// (labelled counters record their label set as the inc() argument).
const counters = vi.hoisted(() => new Map<string, { inc: ReturnType<typeof vi.fn> }>());
vi.mock('~/server/prom/client', () => {
  const register = ({ name }: { name: string }) => {
    const c = { inc: vi.fn() };
    counters.set(name, c);
    return c;
  };
  return {
    registerCounter: register,
    registerCounterWithLabels: register,
    registerHistogram: () => ({ startTimer: () => () => undefined }),
  };
});

vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));

const DEFAULT_ENV = {
  SIGNALS_CALL_TIMEOUT_MS: 1000,
  SIGNALS_CALL_CONCURRENCY: 1,
  SIGNALS_CALL_MAX_QUEUE: 50,
  SIGNALS_TOKEN_CALL_CONCURRENCY: 1,
  SIGNALS_TOKEN_CALL_MAX_QUEUE: 50,
  SIGNALS_CIRCUIT_TRIP_THRESHOLD: 100,
  SIGNALS_CIRCUIT_WINDOW_SECONDS: 60,
  SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 5,
};

// prom-client is not reset by vi.resetModules, so drop the gauges before each
// load, and drop the wrapper's process-wide state (it lives on globalThis by
// design) so every test starts from fresh limiters and a CLOSED circuit.
const GAUGES = [
  'civitai_app_signals_call_active',
  'civitai_app_signals_call_queue_depth',
  'civitai_app_signals_circuit_state',
];

async function load(overrides: Partial<typeof DEFAULT_ENV> = {}) {
  for (const k of Object.keys(envMock)) delete envMock[k];
  Object.assign(envMock, DEFAULT_ENV, overrides);
  const promClient = (await import('prom-client')).default;
  for (const g of GAUGES) promClient.register.removeSingleMetric(g);
  delete globalThis.__civitaiSignalsWrapperState;
  vi.resetModules();
  counters.clear();
  return import('~/server/signals/wrapper');
}

const count = (name: string) => counters.get(name)?.inc.mock.calls.length ?? 0;
const countLane = (name: string, lane: string) =>
  counters.get(name)?.inc.mock.calls.filter(([l]) => l?.lane === lane).length ?? 0;

/** Current value of a lane gauge, read the way a /metrics scrape does. */
async function laneGauge(name: string, lane: string) {
  const promClient = (await import('prom-client')).default;
  const metric = promClient.register.getSingleMetric(`civitai_app_${name}`);
  const { values } = await metric!.get();
  return values.find((v) => v.labels.lane === lane)?.value;
}

/** A call that never settles on its own — holds a limiter slot until the deadline. */
const hang = () => new Promise<never>(() => undefined);

/** A call whose fn() rejects after holding its slot for `ms`. */
const failAfter = (ms: number) => () =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fetch failed')), ms));

/**
 * Record one piece of backend evidence: a fn() rejection after holding its slot
 * for 60% of the deadline (the rule's bar is 50%; overshoot it, never sit on it).
 */
async function addSlowFailure(
  withSignals: (fn: () => Promise<never>) => Promise<never>,
  timeoutMs: number
) {
  const p = withSignals(failAfter(timeoutMs * 0.6));
  p.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(timeoutMs * 0.6);
  await expect(p).rejects.toThrow('fetch failed');
}

/** Observe a promise's outcome without awaiting it (so fake time can advance). */
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error })
  );
  return state;
}

describe('withSignals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fast path: returns the call result, counts nothing as a failure', async () => {
    const { withSignals } = await load({ SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1 });
    const fn = vi.fn(async () => 'token');

    await expect(withSignals(fn)).resolves.toBe('token');
    // A second call still goes through: a success must not have tripped a
    // threshold-1 circuit.
    await expect(withSignals(fn)).resolves.toBe('token');

    // Let any deadline timer a completed call failed to clear fire: a leaked
    // timer would count a healthy call as a timeout.
    await vi.advanceTimersByTimeAsync(DEFAULT_ENV.SIGNALS_CALL_TIMEOUT_MS * 2);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(count('signals_call_timeouts_total')).toBe(0);
    expect(count('signals_call_queue_rejections_total')).toBe(0);
    expect(count('signals_circuit_trips_total')).toBe(0);
  });

  it('an error from fn is rethrown unchanged and does not count toward the circuit', async () => {
    const { withSignals, SignalsCallTimeoutError } = await load({
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
    });
    const boom = new Error('signals said 500');

    await expect(withSignals(() => Promise.reject(boom))).rejects.toBe(boom);
    await expect(withSignals(() => Promise.reject(boom))).rejects.not.toBeInstanceOf(
      SignalsCallTimeoutError
    );
    // Threshold 1, yet the circuit is still CLOSED: app errors are not outages.
    await expect(withSignals(async () => 'ok')).resolves.toBe('ok');
    expect(count('signals_circuit_trips_total')).toBe(0);
  });

  it('the queue bound is concurrency + max queue (not max queue alone)', async () => {
    const { withSignals } = await load({ SIGNALS_CALL_CONCURRENCY: 3, SIGNALS_CALL_MAX_QUEUE: 2 });

    // 3 running + 2 queued are all admitted…
    const admitted = [1, 2, 3, 4, 5].map(() => track(withSignals(hang)));
    // …the 6th is shed.
    const sixth = track(withSignals(async () => 'x'));
    await Promise.resolve();
    expect(admitted.every((a) => !a.settled)).toBe(true);
    expect((sixth.error as Error | undefined)?.message).toMatch(/queue full/);
    expect(count('signals_call_queue_rejections_total')).toBe(1);
  });

  it('a call queued behind a busy slot times out at the deadline from entry and never runs fn', async () => {
    const { withSignals, SignalsCallTimeoutError } = await load();
    const queuedFn = vi.fn(async () => 'late');

    const running = track(withSignals(hang));
    const queued = track(withSignals(queuedFn));

    await vi.advanceTimersByTimeAsync(999);
    expect(queued.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    // Rejected AT the deadline measured from entry — not a deadline that only
    // started once it acquired the slot.
    expect(queued.settled).toBe(true);
    expect(queued.error).toBeInstanceOf(SignalsCallTimeoutError);
    expect((queued.error as InstanceType<typeof SignalsCallTimeoutError>).reason).toBe('timeout');
    expect(running.error).toBeInstanceOf(SignalsCallTimeoutError);

    // The running call's slot is now free; let the limiter drain fully. The
    // abandoned call must not fire its outbound fetch.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queuedFn).not.toHaveBeenCalled();
    // A was started → backend timeout; B never left the queue → expiration.
    expect(count('signals_call_timeouts_total')).toBe(1);
    expect(countLane('signals_call_queue_expirations_total', 'default')).toBe(1);
  });

  it('a call that reaches its slot with >= half its budget left runs on the REMAINING budget, not a fresh deadline', async () => {
    const { withSignals, SignalsCallTimeoutError } = await load();

    // A holds the slot until it succeeds at t=400.
    track(withSignals(() => new Promise<string>((r) => setTimeout(() => r('a'), 400))));
    await vi.advanceTimersByTimeAsync(300);
    const lateFn = vi.fn(hang);
    const late = track(withSignals(lateFn)); // enters at t=300 → deadline t=1300

    await vi.advanceTimersByTimeAsync(100); // t=400: slot frees, 900ms left ≥ 500
    expect(lateFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(899); // t=1299
    expect(late.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // t=1300 — not t=1400
    expect(late.error).toBeInstanceOf(SignalsCallTimeoutError);
  });

  it('a call that reaches its slot with < half its budget left is never started: rejected then, and not a backend failure', async () => {
    const { withSignals, SignalsCallTimeoutError } = await load({
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
    });

    // A succeeds at t=600; B (entered 0) then has 400ms of 1000 left < 500.
    const a = track(withSignals(() => new Promise<string>((r) => setTimeout(() => r('a'), 600))));
    const bFn = vi.fn(hang);
    const b = track(withSignals(bFn));
    await vi.advanceTimersByTimeAsync(600);

    expect(a.value).toBe('a');
    // Rejected at t=600 — when it reached the slot — not at its 1000 deadline.
    expect(b.error).toBeInstanceOf(SignalsCallTimeoutError);
    expect((b.error as InstanceType<typeof SignalsCallTimeoutError>).reason).toBe('timeout');
    expect(bFn).not.toHaveBeenCalled();
    // Never reached the backend: a queue expiration, not a backend timeout.
    expect(count('signals_call_timeouts_total')).toBe(0);
    expect(countLane('signals_call_queue_expirations_total', 'default')).toBe(1);
    expect(count('signals_circuit_trips_total')).toBe(0); // threshold 1, no evidence

    // The slot was freed immediately: a new call runs at once.
    await expect(withSignals(async () => 'next')).resolves.toBe('next');
  });

  it('a call that reaches its slot with 55% of its budget left IS started (the floor sits at most just above half)', async () => {
    const { withSignals } = await load();

    // A succeeds at t=450; B (entered 0) then has 550ms of 1000 left ≥ 500.
    track(withSignals(() => new Promise<string>((r) => setTimeout(() => r('a'), 450))));
    const bFn = vi.fn(() => new Promise<string>((r) => setTimeout(() => r('b'), 100)));
    const b = track(withSignals(bFn));
    await vi.advanceTimersByTimeAsync(550);

    expect(bFn).toHaveBeenCalledTimes(1);
    expect(b.value).toBe('b');
    expect(count('signals_call_timeouts_total')).toBe(0);
  });

  it('a queue expiry is counted once even if the deadline fires before the queued call is dequeued (fake-timer only ordering)', async () => {
    // Real Node runs microtasks between timer callbacks, so a slot always
    // frees before a later-entered call's own deadline fires. A SYNCHRONOUS
    // fake-timer advance fires both timers back to back, reaching the
    // `if (timedOut)` guard in the limiter task — this pins that it prevents
    // double-counting the timeout.
    const { withSignals } = await load();
    track(withSignals(hang, { lane: 'token' }));
    const bFn = vi.fn(hang);
    track(withSignals(bFn, { lane: 'token' }));
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(bFn).not.toHaveBeenCalled();
    // A: backend timeout. B: its deadline fired while queued → one expiration,
    // counted once (the guard stops the budget check counting it again).
    expect(count('signals_call_timeouts_total')).toBe(1);
    expect(countLane('signals_call_queue_expirations_total', 'token')).toBe(1);
  });

  it('rejects at 0ms with reason "concurrency" once the queue is full, without running fn', async () => {
    const { withSignals, SignalsCallTimeoutError } = await load({ SIGNALS_CALL_MAX_QUEUE: 2 });

    // 1 running + 2 queued = full.
    const held = [withSignals(hang), withSignals(hang), withSignals(hang)].map(track);
    const overflowFn = vi.fn(async () => 'x');
    const overflow = track(withSignals(overflowFn));

    // No timers advanced: the rejection is synchronous-on-entry.
    await Promise.resolve();
    expect(overflow.settled).toBe(true);
    expect(overflow.error).toBeInstanceOf(SignalsCallTimeoutError);
    expect((overflow.error as InstanceType<typeof SignalsCallTimeoutError>).reason).toBe(
      'concurrency'
    );
    expect((overflow.error as Error).message).toMatch(/queue full/);
    expect(overflowFn).not.toHaveBeenCalled();
    expect(count('signals_call_queue_rejections_total')).toBe(1);
    expect(held.every((h) => !h.settled)).toBe(true);

    // Once the backlog times out, the queue has room again.
    await vi.advanceTimersByTimeAsync(1000);
    const okFn = vi.fn(async () => 'ok');
    await expect(withSignals(okFn)).resolves.toBe('ok');
  });

  it('a healthy burst far past the queue bound, with no backend failure, leaves the circuit CLOSED', async () => {
    const { withSignals } = await load({
      SIGNALS_CALL_MAX_QUEUE: 2,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 3,
    });

    // 50 fast calls at once: 1 running + 2 queued are admitted, 47 are shed.
    const burst = Array.from({ length: 50 }, (_, i) => track(withSignals(async () => i)));
    await vi.advanceTimersByTimeAsync(0);
    // 47 shed calls ≫ threshold 3, yet nothing points at the backend.
    expect(count('signals_circuit_trips_total')).toBe(0);
    expect(burst.filter((b) => b.settled && !b.error)).toHaveLength(3);
    expect(count('signals_call_queue_rejections_total')).toBe(47);

    const nextFn = vi.fn(async () => 'next');
    await expect(withSignals(nextFn)).resolves.toBe('next');
    expect(count('signals_circuit_rejections_total')).toBe(0);
  });

  it('queue-full rejections trip the circuit once a backend timeout is in the window', async () => {
    const { withSignals } = await load({
      SIGNALS_CALL_MAX_QUEUE: 0,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 3,
    });

    // One real backend timeout: counted (1) and it is backend evidence.
    const a = track(withSignals(hang));
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.error).toBeDefined();
    expect(count('signals_circuit_trips_total')).toBe(0);

    // Slot busy again; two queue-full rejections now count → 3 → OPEN.
    track(withSignals(hang));
    const shed = [1, 2].map(() => track(withSignals(async () => 'x')));
    await Promise.resolve();
    expect(shed.every((s) => (s.error as Error | undefined)?.message?.includes('queue full'))).toBe(
      true
    );
    expect(count('signals_circuit_trips_total')).toBe(1);

    const gated = track(withSignals(async () => 'x'));
    await Promise.resolve();
    expect((gated.error as Error | undefined)?.message).toMatch(/circuit open/);
  });

  it('a SLOW fn() rejection (held its slot >= half the deadline) is backend evidence: later queue-full rejections count', async () => {
    const { withSignals } = await load({
      SIGNALS_CALL_MAX_QUEUE: 0,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 2,
    });

    await addSlowFailure(withSignals, DEFAULT_ENV.SIGNALS_CALL_TIMEOUT_MS);
    expect(count('signals_circuit_trips_total')).toBe(0); // not counted by itself

    track(withSignals(hang));
    [1, 2].map(() => track(withSignals(async () => 'x')));
    await Promise.resolve();
    expect(count('signals_call_queue_rejections_total')).toBe(2);
    expect(count('signals_circuit_trips_total')).toBe(1);
  });

  it.each([
    ['an instant rejection', 0],
    ['a rejection after 40% of the deadline', 400],
  ])(
    'a FAST fn() failure (%s) is not evidence: a burst after a fast-failing outage stays CLOSED',
    async (_label, failMs) => {
      const { withSignals } = await load({
        SIGNALS_CALL_MAX_QUEUE: 0,
        SIGNALS_CIRCUIT_TRIP_THRESHOLD: 2,
      });

      // The outage: signals refuses connections, calls fail fast.
      const p = withSignals(failAfter(failMs));
      p.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(failMs);
      await expect(p).rejects.toThrow('fetch failed');

      // Recovery → reconnect burst far past the bound, healthy backend.
      track(withSignals(hang));
      [1, 2, 3, 4, 5].map(() => track(withSignals(async () => 'x')));
      await Promise.resolve();
      expect(count('signals_circuit_trips_total')).toBe(0);
      expect(count('signals_call_queue_rejections_total')).toBe(5);
    }
  );

  it('a saturated burst on a healthy-but-slowish backend stays CLOSED and never starts a call it cannot finish', async () => {
    const { withSignals } = await load({
      SIGNALS_CALL_CONCURRENCY: 3,
      SIGNALS_CALL_MAX_QUEUE: 20,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
    });

    // 300ms per call, 3 slots, all 23 enter at t=0: the waves at 0 and 300
    // start (1000 / 700 ms left); at 600 only 400ms are left < 500, so the
    // rest are not started.
    const ok = vi.fn(() => new Promise<string>((r) => setTimeout(() => r('ok'), 300)));
    const calls = Array.from({ length: 23 }, () => track(withSignals(ok)));
    await vi.advanceTimersByTimeAsync(2000);

    expect(calls.every((c) => c.settled)).toBe(true);
    // Every started call succeeded; the 17 not started were rejected unrun.
    expect(ok).toHaveBeenCalledTimes(6);
    expect(calls.filter((c) => c.value === 'ok')).toHaveLength(6);
    // The 17 never started are queue expirations, not backend timeouts.
    expect(count('signals_call_timeouts_total')).toBe(0);
    expect(countLane('signals_call_queue_expirations_total', 'default')).toBe(17);
    expect(count('signals_circuit_trips_total')).toBe(0);
    await expect(withSignals(async () => 'after')).resolves.toBe('after');
  });

  it('backend evidence older than the circuit window no longer lets queue-side failures count', async () => {
    const { withSignals } = await load({
      SIGNALS_CALL_MAX_QUEUE: 0,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 2,
      SIGNALS_CIRCUIT_WINDOW_SECONDS: 60,
    });

    await addSlowFailure(withSignals, DEFAULT_ENV.SIGNALS_CALL_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(61_000);
    track(withSignals(hang));
    [1, 2, 3].map(() => track(withSignals(async () => 'x')));
    await Promise.resolve();
    expect(count('signals_call_queue_rejections_total')).toBe(3);
    expect(count('signals_circuit_trips_total')).toBe(0);
  });

  it('backend evidence is cleared when the circuit closes (a post-recovery burst does not re-open it)', async () => {
    let releaseA!: (v: string) => void;
    const { withSignals } = await load({
      SIGNALS_CALL_TIMEOUT_MS: 60_000,
      SIGNALS_CALL_MAX_QUEUE: 0,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    await addSlowFailure(withSignals, 60_000);
    const a = track(withSignals(() => new Promise<string>((r) => (releaseA = r))));
    track(withSignals(async () => 'c')); // shed with evidence → OPEN
    await Promise.resolve();
    expect(count('signals_circuit_trips_total')).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    releaseA('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.value).toBe('a');
    await expect(withSignals(async () => 'trial')).resolves.toBe('trial'); // → CLOSED

    // Healthy again: fill the slot and overflow. Old evidence must be gone.
    track(withSignals(hang));
    track(withSignals(async () => 'y'));
    await Promise.resolve();
    expect(count('signals_call_queue_rejections_total')).toBe(2);
    expect(count('signals_circuit_trips_total')).toBe(1);
  });

  it('a HALF_OPEN trial whose fn() rejects closes the circuit (unchanged behaviour)', async () => {
    const { withSignals } = await load({
      SIGNALS_CALL_CONCURRENCY: 2,
      SIGNALS_CALL_TIMEOUT_MS: 100,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    track(withSignals(hang));
    await vi.advanceTimersByTimeAsync(100); // backend timeout → OPEN
    expect(count('signals_circuit_trips_total')).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(withSignals(() => Promise.reject(new Error('fetch failed')))).rejects.toThrow();

    // CLOSED, not still HALF_OPEN: two concurrent calls are both admitted
    // (HALF_OPEN would admit one trial and reject the other at the gate).
    const first = track(withSignals(hang));
    const second = track(withSignals(async () => 'ok'));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.value).toBe('ok');
    expect(first.settled).toBe(false);
    expect(count('signals_circuit_rejections_total')).toBe(0);
    expect(count('signals_circuit_trips_total')).toBe(1);
  });

  it('a HALF_OPEN trial whose fn() rejects SLOWLY also closes the circuit (unchanged behaviour)', async () => {
    const { withSignals } = await load({
      SIGNALS_CALL_TIMEOUT_MS: 100,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    track(withSignals(hang));
    await vi.advanceTimersByTimeAsync(100); // backend timeout → OPEN
    await vi.advanceTimersByTimeAsync(1000);
    await addSlowFailure(withSignals, 100); // the trial: rejects at 60% of the deadline
    await expect(withSignals(async () => 'ok')).resolves.toBe('ok');
    expect(count('signals_circuit_rejections_total')).toBe(0);
    expect(count('signals_circuit_trips_total')).toBe(1);
  });

  it('calls expiring in the queue count toward the circuit when the calls ahead timed out', async () => {
    const { withSignals } = await load({ SIGNALS_CIRCUIT_TRIP_THRESHOLD: 3 });

    // 1 running + 4 queued; all five hit the deadline at t=1000. The running
    // one is a backend timeout (counted, evidence), so the 4 queued expiries
    // count too. Without them: 1 < threshold.
    const calls = [1, 2, 3, 4, 5].map(() => track(withSignals(hang)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.every((c) => c.settled)).toBe(true);
    // 1 started (backend timeout) + 4 that never left the queue.
    expect(count('signals_call_timeouts_total')).toBe(1);
    expect(count('signals_call_queue_expirations_total')).toBe(4);
    expect(count('signals_circuit_trips_total')).toBe(1);

    const gatedFn = vi.fn(async () => 'x');
    await expect(withSignals(gatedFn)).rejects.toThrow(/circuit open/);
    expect(gatedFn).not.toHaveBeenCalled();
  });

  it('a call expiring in the queue behind HEALTHY calls (no backend failure) does not count', async () => {
    const { withSignals, SignalsCallTimeoutError } = await load({
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
    });

    // A succeeds after 500ms. B queues behind it. Event-loop lag pushes the
    // wall clock past B's deadline before A's completion is processed, so B
    // reaches its slot already expired — pure local delay, healthy backend.
    const a = track(withSignals(() => new Promise<string>((r) => setTimeout(() => r('a'), 500))));
    const bFn = vi.fn(async () => 'b');
    const b = track(withSignals(bFn));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 2000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(a.value).toBe('a');
    expect(b.error).toBeInstanceOf(SignalsCallTimeoutError);
    expect(bFn).not.toHaveBeenCalled();
    // Threshold 1, but a demand/lag expiry is not a backend failure.
    expect(count('signals_circuit_trips_total')).toBe(0);
    await expect(withSignals(async () => 'ok')).resolves.toBe('ok');
  });

  /**
   * Steady arrivals every 50ms for `ms` (20/s against a capacity of 2 slots /
   * 300ms ≈ 6.7/s, so the pod is saturated throughout). `fnAt(t)` picks each
   * call's fn by its arrival time.
   */
  async function steadyArrivals(
    withSignals: (fn: () => Promise<unknown>) => Promise<unknown>,
    ms: number,
    fnAt: (t: number) => () => Promise<unknown>
  ) {
    for (let t = 0; t < ms; t += 50) {
      withSignals(fnAt(t)).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(50);
    }
  }
  const SATURATED_ENV = {
    SIGNALS_CALL_CONCURRENCY: 2,
    SIGNALS_CALL_MAX_QUEUE: 4,
    SIGNALS_CIRCUIT_TRIP_THRESHOLD: 3,
  };
  const ok300 = () => new Promise<string>((r) => setTimeout(() => r('ok'), 300));

  it('a hang that begins while the pod is ALREADY saturated still trips the circuit', async () => {
    const { withSignals } = await load(SATURATED_ENV);
    // Healthy-but-saturated for 3s, then the backend hangs. Calls that are
    // started always have >= half their deadline, so the hung ones are
    // backend timeouts even though the queue is full.
    await steadyArrivals(withSignals, 8000, (t) => (t < 3000 ? ok300 : hang));
    expect(count('signals_circuit_trips_total')).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['300ms', 300], // L·(Q/C + 1) = 900 < T — some queued calls are still not started
    ['450ms', 450], // L·(Q/C + 1) = 1350 > T: the geometry where late starts used to starve every call
  ])('steady overload on a HEALTHY backend (%s latency) never trips', async (_label, latency) => {
    const { withSignals } = await load(SATURATED_ENV);
    let ok = 0;
    await steadyArrivals(
      withSignals,
      8000,
      () => () =>
        new Promise<string>((r) =>
          setTimeout(() => {
            ok++;
            r('ok');
          }, latency)
        )
    );
    // Positive controls: overloaded (calls shed) and still serving.
    expect(count('signals_call_queue_rejections_total')).toBeGreaterThan(0);
    expect(ok).toBeGreaterThan(20);
    expect(count('signals_circuit_trips_total')).toBe(0);
  });

  it('a HALF_OPEN trial that reaches its slot with too little budget is not started: circuit stays HALF_OPEN', async () => {
    let releaseA!: (v: string) => void;
    const T = 4000;
    const { withSignals } = await load({
      SIGNALS_CALL_TIMEOUT_MS: T,
      SIGNALS_CALL_MAX_QUEUE: 1,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    // Evidence; then A holds the slot, B (hang) queues, C overflows → OPEN.
    await addSlowFailure(withSignals, T); // t=2400
    track(withSignals(() => new Promise<string>((r) => (releaseA = r))));
    track(withSignals(hang)); // B: deadline 6400
    track(withSignals(async () => 'c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(count('signals_circuit_trips_total')).toBe(1);

    // Cooldown ends (t=3400): A finishes, B takes the slot until 6400. The
    // trial queues behind B and reaches the slot at 6400 with 1000ms of its
    // 4000ms left < 2000 — so it is not started.
    await vi.advanceTimersByTimeAsync(1000);
    releaseA('a');
    await vi.advanceTimersByTimeAsync(0); // A settles, B takes the slot
    const trialFn = vi.fn(hang);
    const trial = track(withSignals(trialFn));
    await vi.advanceTimersByTimeAsync(3000); // t=6400
    expect(trialFn).not.toHaveBeenCalled();
    expect(trial.error).toBeDefined();
    expect(count('signals_circuit_trips_total')).toBe(1); // not re-opened…

    // …and not closed: HALF_OPEN admits one new trial and gates the rest.
    track(withSignals(hang));
    const gated = track(withSignals(async () => 'x'));
    await Promise.resolve();
    expect((gated.error as Error | undefined)?.message).toMatch(/circuit open/);
    expect(count('signals_circuit_rejections_total')).toBe(1);
  });

  it('a HALF_OPEN trial shed by the full queue releases the trial slot and stays HALF_OPEN', async () => {
    let releaseA!: (v: string) => void;
    const { withSignals } = await load({
      SIGNALS_CALL_TIMEOUT_MS: 60_000,
      SIGNALS_CALL_CONCURRENCY: 2,
      SIGNALS_CALL_MAX_QUEUE: 0,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    // Backend evidence, then fill both slots and overflow → counted → OPEN.
    await addSlowFailure(withSignals, 60_000);
    const a = track(withSignals(() => new Promise<string>((r) => (releaseA = r))));
    track(withSignals(hang));
    const c = track(withSignals(async () => 'c'));
    await Promise.resolve();
    expect((c.error as Error | undefined)?.message).toMatch(/queue full/);
    expect(count('signals_circuit_trips_total')).toBe(1);

    // Cooldown elapses → this call is the HALF_OPEN trial, shed by the queue.
    await vi.advanceTimersByTimeAsync(1000);
    const trialFn = vi.fn(async () => 'trial');
    const trial = track(withSignals(trialFn));
    await Promise.resolve();
    expect((trial.error as Error | undefined)?.message).toMatch(/queue full/);
    expect(trialFn).not.toHaveBeenCalled();
    // Not a failed trial: no re-trip…
    expect(count('signals_circuit_trips_total')).toBe(1);
    // …and the trial slot was released: the next caller is admitted as the new
    // trial (shed by the queue again), not rejected by the gate.
    const next = track(withSignals(async () => 'next'));
    await Promise.resolve();
    expect((next.error as Error | undefined)?.message).toMatch(/queue full/);
    expect(count('signals_circuit_rejections_total')).toBe(0);

    // Once a slot frees, the next trial probes the backend and closes it.
    releaseA('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(a.value).toBe('a');
    // track + advance (not `await expect().resolves`) so a regression fails on
    // an assertion instead of hanging behind a held slot until the test timeout.
    const d = track(withSignals(async () => 'd'));
    await vi.advanceTimersByTimeAsync(0);
    expect(d.value).toBe('d');
    const e = track(withSignals(async () => 'e'));
    await vi.advanceTimersByTimeAsync(0);
    expect(e.value).toBe('e');
    expect(count('signals_circuit_trips_total')).toBe(1);
  });

  it('under event-loop lag, a HALF_OPEN trial that reaches its slot past its deadline never runs and releases the trial slot', async () => {
    let releaseA!: (v: string) => void;
    const { withSignals, SignalsCallTimeoutError } = await load({
      SIGNALS_CALL_MAX_QUEUE: 1,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    // Backend evidence; then A holds the slot, B queues, C overflows → OPEN.
    await addSlowFailure(withSignals, DEFAULT_ENV.SIGNALS_CALL_TIMEOUT_MS);
    track(withSignals(() => new Promise<string>((r) => (releaseA = r))));
    track(withSignals(hang));
    track(withSignals(async () => 'c'));
    await vi.advanceTimersByTimeAsync(0); // let p-limit start A
    expect(count('signals_circuit_trips_total')).toBe(1);
    // A finishes; B (hanging) takes the slot until its deadline.
    releaseA('a');
    await vi.advanceTimersByTimeAsync(0);

    // Wall clock passes the cooldown with no timers run → the next call is
    // the HALF_OPEN trial, queued behind B.
    vi.setSystemTime(Date.now() + 1000);
    const trialFn = vi.fn(async () => 'trial');
    const trial = track(withSignals(trialFn));

    // Event-loop lag: the wall clock jumps well past the trial's deadline
    // before any timer callback runs. B's timer then frees the slot first.
    vi.setSystemTime(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(DEFAULT_ENV.SIGNALS_CALL_TIMEOUT_MS);

    expect(trial.error).toBeInstanceOf(SignalsCallTimeoutError);
    expect((trial.error as InstanceType<typeof SignalsCallTimeoutError>).reason).toBe('timeout');
    expect(trialFn).not.toHaveBeenCalled();
    // An expired-in-queue trial probed nothing: no re-trip, slot released.
    expect(count('signals_circuit_trips_total')).toBe(1);

    // Not stuck: the next caller is the new trial, runs, and closes it.
    await expect(withSignals(async () => 'ok')).resolves.toBe('ok');
    await expect(withSignals(async () => 'ok2')).resolves.toBe('ok2');
    expect(count('signals_circuit_rejections_total')).toBe(0);
  });

  it('a HALF_OPEN trial that hangs past its deadline re-opens the circuit', async () => {
    const { withSignals } = await load({
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    track(withSignals(hang));
    await vi.advanceTimersByTimeAsync(1000); // backend timeout → OPEN
    expect(count('signals_circuit_trips_total')).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // cooldown → next call is the trial

    const trialFn = vi.fn(hang);
    const trial = track(withSignals(trialFn));
    await vi.advanceTimersByTimeAsync(1000); // the trial itself hits its deadline
    expect(trialFn).toHaveBeenCalledTimes(1);
    expect(trial.error).toBeDefined();
    expect(count('signals_circuit_trips_total')).toBe(2); // HALF_OPEN → OPEN
    await expect(withSignals(async () => 'x')).rejects.toThrow(/circuit open/);
  });

  describe('lanes', () => {
    it("a storm in the 'token' lane does not crowd out the 'default' lane", async () => {
      const { withSignals } = await load({
        SIGNALS_TOKEN_CALL_MAX_QUEUE: 0,
        SIGNALS_CALL_MAX_QUEUE: 0,
      });

      // Token lane: one slot busy, then a storm of token calls is shed.
      track(withSignals(hang, { lane: 'token' }));
      const storm = Array.from({ length: 5 }, () =>
        track(withSignals(async () => 't', { lane: 'token' }))
      );
      await Promise.resolve();
      expect(
        storm.every((s) => (s.error as Error | undefined)?.message?.includes('queue full'))
      ).toBe(true);
      expect(countLane('signals_call_queue_rejections_total', 'token')).toBe(5);

      // A push on the default lane still gets a slot and completes.
      const pushFn = vi.fn(async () => 'pushed');
      const push = track(withSignals(pushFn));
      await vi.advanceTimersByTimeAsync(0);
      expect(push.value).toBe('pushed');
      expect(pushFn).toHaveBeenCalledTimes(1);
      expect(countLane('signals_call_queue_rejections_total', 'default')).toBe(0);
    });

    it("a full 'default' lane does not block token mints", async () => {
      const { withSignals } = await load({ SIGNALS_CALL_MAX_QUEUE: 0 });

      track(withSignals(hang)); // default lane: the only slot
      const shed = track(withSignals(async () => 'p'));
      await Promise.resolve();
      expect((shed.error as Error | undefined)?.message).toMatch(/queue full/);

      const mint = track(withSignals(async () => 'token', { lane: 'token' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(mint.value).toBe('token');
      expect(countLane('signals_call_queue_rejections_total', 'default')).toBe(1);
      expect(countLane('signals_call_queue_rejections_total', 'token')).toBe(0);
    });

    it('each lane is bounded by its OWN concurrency + max queue', async () => {
      const { withSignals } = await load({
        SIGNALS_CALL_CONCURRENCY: 1,
        SIGNALS_CALL_MAX_QUEUE: 1,
        SIGNALS_TOKEN_CALL_CONCURRENCY: 2,
        SIGNALS_TOKEN_CALL_MAX_QUEUE: 3,
      });

      // token: 2 + 3 admitted, the 6th shed. default: 1 + 1 admitted, the 3rd shed.
      const token = Array.from({ length: 6 }, () => track(withSignals(hang, { lane: 'token' })));
      const def = Array.from({ length: 3 }, () => track(withSignals(hang)));
      await Promise.resolve();
      expect(token.filter((t) => t.settled)).toHaveLength(1);
      expect(def.filter((d) => d.settled)).toHaveLength(1);
      // …and each lane's limiter really runs its own concurrency.
      await vi.advanceTimersByTimeAsync(0);
      expect(await laneGauge('signals_call_active', 'token')).toBe(2);
      expect(await laneGauge('signals_call_active', 'default')).toBe(1);
      expect(countLane('signals_call_queue_rejections_total', 'token')).toBe(1);
      expect(countLane('signals_call_queue_rejections_total', 'default')).toBe(1);
    });

    it('a token storm cannot open the shared circuit through its own queue (pushes keep flowing)', async () => {
      const { withSignals } = await load({
        SIGNALS_TOKEN_CALL_MAX_QUEUE: 0,
        SIGNALS_CIRCUIT_TRIP_THRESHOLD: 3,
      });

      // One real token-lane backend timeout: counted (1) AND backend evidence.
      track(withSignals(hang, { lane: 'token' }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(count('signals_call_timeouts_total')).toBe(1);

      // Then a token storm overflows the token queue — with evidence in the
      // window these would count on the default lane, but token-lane queue
      // rejections measure demand and never count.
      track(withSignals(hang, { lane: 'token' }));
      Array.from({ length: 5 }, () => track(withSignals(async () => 't', { lane: 'token' })));
      await Promise.resolve();
      expect(count('signals_circuit_trips_total')).toBe(0);
      expect(countLane('signals_call_queue_rejections_total', 'token')).toBe(5);

      const push = track(withSignals(async () => 'pushed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(push.value).toBe('pushed');
    });

    it('token calls not started for lack of budget never count either', async () => {
      const { withSignals } = await load({ SIGNALS_CIRCUIT_TRIP_THRESHOLD: 2 });
      const ok600 = () => new Promise<string>((r) => setTimeout(() => r('ok'), 600));

      // One token-lane backend timeout: counted (1) and backend evidence.
      track(withSignals(hang, { lane: 'token' }));
      await vi.advanceTimersByTimeAsync(1000);

      // t=1000: one token call holds the slot for 600ms; three more queue
      // behind it and reach it at t=1600 with 400ms of 1000 left — not started.
      track(withSignals(ok600, { lane: 'token' }));
      const queuedFns = [1, 2, 3].map(() => vi.fn(hang));
      queuedFns.forEach((fn) => track(withSignals(fn, { lane: 'token' })));
      await vi.advanceTimersByTimeAsync(600);

      expect(count('signals_circuit_trips_total')).toBe(0);
      expect(countLane('signals_call_queue_expirations_total', 'token')).toBe(3);
      expect(queuedFns.every((fn) => fn.mock.calls.length === 0)).toBe(true);
    });

    it('backend evidence from the token lane still lets DEFAULT-lane queue failures count', async () => {
      const { withSignals } = await load({
        SIGNALS_CALL_MAX_QUEUE: 0,
        SIGNALS_CIRCUIT_TRIP_THRESHOLD: 3,
      });

      track(withSignals(hang, { lane: 'token' }));
      await vi.advanceTimersByTimeAsync(1000); // token backend timeout: 1 + evidence
      track(withSignals(hang)); // default lane: the only slot
      [1, 2].forEach(() => track(withSignals(async () => 'p')));
      await Promise.resolve();
      expect(countLane('signals_call_queue_rejections_total', 'default')).toBe(2);
      expect(count('signals_circuit_trips_total')).toBe(1); // 1 + 2 = threshold
    });

    it('the circuit breaker is SHARED: a sick backend seen by one lane stops the other', async () => {
      const { withSignals } = await load({ SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1 });

      track(withSignals(hang, { lane: 'token' }));
      await vi.advanceTimersByTimeAsync(1000); // token-lane backend timeout → OPEN
      expect(count('signals_circuit_trips_total')).toBe(1);

      const pushFn = vi.fn(async () => 'p');
      await expect(withSignals(pushFn)).rejects.toThrow(/circuit open/);
      expect(pushFn).not.toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('active and queue depth are reported per lane, and the queue drains to 0', async () => {
      const { withSignals } = await load({ SIGNALS_CALL_CONCURRENCY: 1 });

      // default lane: 1 running + 3 waiting. token lane: 1 running + 1 waiting.
      track(withSignals(hang));
      [1, 2, 3].forEach(() => track(withSignals(hang)));
      track(withSignals(hang, { lane: 'token' }));
      track(withSignals(hang, { lane: 'token' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await laneGauge('signals_call_queue_depth', 'default')).toBe(3);
      expect(await laneGauge('signals_call_queue_depth', 'token')).toBe(1);
      expect(await laneGauge('signals_call_active', 'default')).toBe(1);
      expect(await laneGauge('signals_call_active', 'token')).toBe(1);

      // Everything hits its deadline; nothing is left waiting or running.
      await vi.advanceTimersByTimeAsync(1000);
      expect(await laneGauge('signals_call_queue_depth', 'default')).toBe(0);
      expect(await laneGauge('signals_call_queue_depth', 'token')).toBe(0);
      expect(await laneGauge('signals_call_active', 'default')).toBe(0);
    });

    it('a backend timeout and a queue expiration are counted apart, per lane', async () => {
      const { withSignals } = await load();

      track(withSignals(hang, { lane: 'token' })); // started → backend timeout
      track(withSignals(hang, { lane: 'token' })); // never started → expiration
      await vi.advanceTimersByTimeAsync(1000);

      expect(count('signals_call_timeouts_total')).toBe(1);
      expect(countLane('signals_call_queue_expirations_total', 'token')).toBe(1);
      expect(countLane('signals_call_queue_expirations_total', 'default')).toBe(0);
    });
  });
});
