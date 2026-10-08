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
// imports the DB pools at load, and the wrapper only needs these two helpers.
// Each counter is captured by name so tests can assert which fast-fail path ran.
const counters = vi.hoisted(() => new Map<string, { inc: ReturnType<typeof vi.fn> }>());
vi.mock('~/server/prom/client', () => ({
  registerCounter: ({ name }: { name: string }) => {
    const c = { inc: vi.fn() };
    counters.set(name, c);
    return c;
  },
  registerHistogram: () => ({ startTimer: () => () => undefined }),
}));

vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));

const DEFAULT_ENV = {
  SIGNALS_CALL_TIMEOUT_MS: 1000,
  SIGNALS_CALL_CONCURRENCY: 1,
  SIGNALS_CALL_MAX_QUEUE: 50,
  SIGNALS_CIRCUIT_TRIP_THRESHOLD: 100,
  SIGNALS_CIRCUIT_WINDOW_SECONDS: 60,
  SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 5,
};

async function load(overrides: Partial<typeof DEFAULT_ENV> = {}) {
  for (const k of Object.keys(envMock)) delete envMock[k];
  Object.assign(envMock, DEFAULT_ENV, overrides);
  vi.resetModules();
  counters.clear();
  return import('~/server/signals/wrapper');
}

const count = (name: string) => counters.get(name)?.inc.mock.calls.length ?? 0;

/** A call that never settles on its own — holds a limiter slot until the deadline. */
const hang = () => new Promise<never>(() => undefined);

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
    expect(count('signals_call_timeouts_total')).toBe(2);
  });

  it('a call that reaches a slot late only gets the REMAINING budget, not a fresh deadline', async () => {
    const { withSignals, SignalsCallTimeoutError } = await load();

    track(withSignals(hang)); // holds the slot until t=1000
    await vi.advanceTimersByTimeAsync(300);
    const lateFn = vi.fn(hang);
    const late = track(withSignals(lateFn)); // enters at t=300 → deadline t=1300

    await vi.advanceTimersByTimeAsync(700); // t=1000: slot frees, late call starts
    expect(lateFn).toHaveBeenCalledTimes(1);
    expect(late.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(299); // t=1299
    expect(late.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // t=1300 — not t=2000
    expect(late.error).toBeInstanceOf(SignalsCallTimeoutError);
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

  it('a storm of queue-full rejections trips the circuit; later calls fail fast at the gate', async () => {
    const { withSignals } = await load({
      SIGNALS_CALL_MAX_QUEUE: 0,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 3,
    });

    track(withSignals(hang)); // occupies the only slot
    const storm = [1, 2, 3].map(() => track(withSignals(async () => 'x')));
    await Promise.resolve();
    expect(storm.every((s) => s.settled && s.error)).toBe(true);
    expect(count('signals_call_queue_rejections_total')).toBe(3);
    expect(count('signals_circuit_trips_total')).toBe(1);

    const gated = track(withSignals(async () => 'x'));
    await Promise.resolve();
    expect((gated.error as Error).message).toMatch(/circuit open/);
    expect(count('signals_circuit_rejections_total')).toBe(1);
    // The gate, not the queue bound, rejected it.
    expect(count('signals_call_queue_rejections_total')).toBe(3);
  });

  it('calls timing out in the queue count toward the circuit', async () => {
    const { withSignals } = await load({ SIGNALS_CIRCUIT_TRIP_THRESHOLD: 3 });

    // 1 running + 4 queued; all five hit the deadline at t=1000. Before the
    // fix only the running one could time out by then (1 < threshold).
    const calls = [1, 2, 3, 4, 5].map(() => track(withSignals(hang)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.every((c) => c.settled)).toBe(true);
    expect(count('signals_call_timeouts_total')).toBe(5);
    expect(count('signals_circuit_trips_total')).toBe(1);

    const gatedFn = vi.fn(async () => 'x');
    await expect(withSignals(gatedFn)).rejects.toThrow(/circuit open/);
    expect(gatedFn).not.toHaveBeenCalled();
  });

  it('a HALF_OPEN trial rejected by the full queue re-opens the circuit instead of sticking trialInFlight', async () => {
    let releaseA!: (v: string) => void;
    const { withSignals } = await load({
      SIGNALS_CALL_TIMEOUT_MS: 60_000,
      SIGNALS_CALL_MAX_QUEUE: 0,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    const a = track(withSignals(() => new Promise<string>((r) => (releaseA = r))));
    // Queue full → failure → threshold 1 → OPEN. (track + assert rather than
    // `await expect(...).rejects`, so a missing queue bound fails on an
    // assertion instead of hanging until the test timeout.)
    const b = track(withSignals(async () => 'b'));
    await Promise.resolve();
    expect((b.error as Error | undefined)?.message).toMatch(/queue full/);
    expect(count('signals_circuit_trips_total')).toBe(1);

    // Cooldown elapses → next call is the HALF_OPEN trial, but A still holds
    // the only slot so the trial is shed by the queue bound.
    await vi.advanceTimersByTimeAsync(1000);
    const trialFn = vi.fn(async () => 'c');
    const trial = track(withSignals(trialFn));
    await Promise.resolve();
    expect((trial.error as Error | undefined)?.message).toMatch(/queue full/);
    expect(trialFn).not.toHaveBeenCalled();
    // Failed trial → OPEN again (a re-trip), not HALF_OPEN-with-trial-busy.
    expect(count('signals_circuit_trips_total')).toBe(2);

    releaseA('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(a.value).toBe('a');

    // After the next cooldown a fresh trial is admitted and closes the circuit.
    await vi.advanceTimersByTimeAsync(1000);
    await expect(withSignals(async () => 'd')).resolves.toBe('d');
    await expect(withSignals(async () => 'e')).resolves.toBe('e');
  });

  it('under event-loop lag, a HALF_OPEN trial that reaches its slot past its deadline never runs and re-opens the circuit', async () => {
    let releaseA!: (v: string) => void;
    const { withSignals, SignalsCallTimeoutError } = await load({
      SIGNALS_CALL_MAX_QUEUE: 1,
      SIGNALS_CIRCUIT_TRIP_THRESHOLD: 1,
      SIGNALS_CIRCUIT_COOLDOWN_SECONDS: 1,
    });

    // A holds the slot, B queues behind it, C overflows → trip (OPEN).
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
    expect(count('signals_circuit_trips_total')).toBe(2); // failed trial → OPEN

    // Not stuck: after the next cooldown a fresh trial runs and closes it.
    vi.setSystemTime(Date.now() + 1000);
    await expect(withSignals(async () => 'ok')).resolves.toBe('ok');
  });
});
