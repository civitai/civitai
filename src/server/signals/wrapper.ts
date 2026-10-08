import pLimit from 'p-limit';
import client from 'prom-client';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { registerCounter, registerHistogram } from '~/server/prom/client';

const log = createLogger('signals', 'cyan');

/**
 * withSignals — surgical per-call wrapper around outbound HTTP fetches to the
 * civitai-signals service.
 *
 * Mirrors `withMeili()` (src/server/meilisearch/client.ts) but for the signals
 * dependency. Trigger: 2026-05-30 chronic-brownout investigation found Meili
 * QUIET while signals Traefik P99 was pegged at the router 30s timeout —
 * signals.getToken and similar HTTP paths were the unwrapped hot fetch driving
 * api-primary event-loop blocking past kubelet's 5s TCP probe and SIGKILL.
 *
 * Single-backend design (no `backend` label) — signals has exactly one HTTP
 * endpoint (`SIGNALS_ENDPOINT`). p-limit limiter, per-call timeout, circuit
 * breaker. Identical state machine to the Meili wrapper:
 *   CLOSED → (failures >= TRIP_THRESHOLD in WINDOW_SECONDS) → OPEN
 *   OPEN → (now >= cooldownUntil) → HALF_OPEN
 *   HALF_OPEN → (trial success) → CLOSED
 *   HALF_OPEN → (trial failure) → OPEN (new cooldown)
 *   HALF_OPEN → (trial shed by the queue) → HALF_OPEN, trial slot released
 *
 * Minimum start budget: a queued call that reaches its slot with less than
 * half its deadline left (MIN_BUDGET_FRACTION) is NOT started — it rejects
 * with SignalsCallTimeoutError('timeout') at once, fn() never runs, and the
 * slot goes to the next call. A slot is never spent on a call that has
 * probably already lost, and it follows that EVERY started call that times
 * out held its slot for at least half the deadline — the backend's time, not
 * the queue's.
 *
 * What counts toward TRIP_THRESHOLD (the breaker exists to stop calling a SICK
 * backend; shedding excess DEMAND is the queue bound's job):
 *   - backend timeout — a started call hit the deadline: ALWAYS counts, and is
 *     "backend evidence" (it held its slot >= half the deadline, see above).
 *   - slow fn() rejection — rejected after running >= half the deadline:
 *     never counts by itself (fn errors never did), but is backend evidence.
 *   - fast fn() rejection (e.g. an instant `fetch failed`): neither — it freed
 *     its slot at once, so it cannot be why the queue is full.
 *   - queue-side failure — a queue-full rejection, a deadline that expired
 *     while still queued, or a call not started for lack of budget (fn() never
 *     ran in any of them): counts ONLY if the window holds backend evidence.
 *   So a healthy burst far past the queue bound (e.g. a synchronized client
 *   reconnect after recovery, even one following a fast-failing outage) and a
 *   healthy-but-overloaded backend (latency < half the deadline) are shed and
 *   never open the circuit: every call they start completes. A hang — from an
 *   idle or an already-saturated pool — trips it: the calls it starts time
 *   out. Evidence is pruned with the same window as failures and cleared when
 *   the circuit CLOSES.
 *   - A HALF_OPEN trial that suffers a queue-side failure probed nothing, so it
 *     is NOT a failed trial: it releases `trialInFlight` and the circuit stays
 *     HALF_OPEN; the next caller becomes the trial. A trial whose fn() rejects
 *     closes the circuit (unchanged).
 *
 * Defaults are HIGHER than Meili because signals normally takes longer (Orleans
 * grain init):
 *   SIGNALS_CALL_TIMEOUT_MS       5000  (Meili: 2500) — total deadline from
 *                                       withSignals() entry: queue wait + call
 *   SIGNALS_CALL_CONCURRENCY      30    (Meili: 50)
 *   SIGNALS_CALL_MAX_QUEUE        200   (Meili: unbounded) — live queued calls
 *                                       beyond this reject at 0ms
 *   SIGNALS_CIRCUIT_WINDOW_SECONDS 60   (Meili: 30)
 *   SIGNALS_CIRCUIT_TRIP_THRESHOLD 10
 *   SIGNALS_CIRCUIT_COOLDOWN_SECONDS 30
 *
 * Why the deadline covers the queue (2026-10-08): during a signals-service
 * outage a client reconnect storm queued >1,000 calls per pod in front of the
 * limiter. The old deadline only started once a call acquired a slot, so queued
 * calls waited until the upstream proxy's 30s timeout (→ 504s on
 * signals.getToken, which is designed to fail soft), and because queue wait was
 * never counted as a failure the circuit almost never opened. Now a call that
 * cannot FINISH within SIGNALS_CALL_TIMEOUT_MS of entry rejects with
 * SignalsCallTimeoutError('timeout') — and if it was still queued, its fn()
 * never runs. Queue-side failures feed the circuit per the rules above.
 *
 * SCOPE: wrap ONLY the actual `fetch(SIGNALS_ENDPOINT/...)` call. Do NOT wrap
 * surrounding DB/Redis work — those are independent dependencies and should not
 * consume a signals semaphore slot nor be attributed to a signals timeout.
 *
 * The SignalR websocket itself is NOT wrapped — only the HTTP API.
 */

/**
 * Typed error thrown by withSignals() when a wrapped signals call exceeds
 * SIGNALS_CALL_TIMEOUT_MS (reason 'timeout'), or when it is shed at 0ms because
 * the circuit breaker is OPEN or the per-pod queue is full (reason
 * 'concurrency').
 *
 * Hot-path callers (signals.getToken tRPC handler, webhooks/resource-training
 * REST handlers) catch this and return a fast 408 / TRPCError(TIMEOUT) instead
 * of bleeding event-loop time waiting for Traefik's 30s router timeout.
 */
export class SignalsCallTimeoutError extends Error {
  readonly code = 'SIGNALS_CALL_TIMEOUT';
  readonly reason: 'timeout' | 'concurrency';

  constructor(reason: 'timeout' | 'concurrency', message?: string) {
    super(
      message ??
        (reason === 'timeout'
          ? `Signals call exceeded ${env.SIGNALS_CALL_TIMEOUT_MS}ms timeout`
          : `Signals call concurrency limit exceeded`)
    );
    this.name = 'SignalsCallTimeoutError';
    this.reason = reason;
  }
}

const limiter = pLimit(env.SIGNALS_CALL_CONCURRENCY);

// Calls inside withSignals() that are queued or running and have not yet
// settled. Bounds the queue instead of `limiter.pendingCount`, which (a) lags a
// microtask behind enqueue even when a slot is free and (b) still counts calls
// that already timed out while queued — those are drained without running fn()
// but would otherwise make a dead backlog look like a full queue.
let outstanding = 0;

// ────────────────────────────────────────────────────────────────────────────
// Observability — single-backend, no label
// ────────────────────────────────────────────────────────────────────────────

const signalsCallTimeoutsCounter = registerCounter({
  name: 'signals_call_timeouts_total',
  help: 'Signals wrapped-call timeouts (deadline from entry exceeded or not reachable: queue wait + call)',
});

// Calls rejected at 0ms because SIGNALS_CALL_MAX_QUEUE live calls were already
// waiting for a slot. Separate from the circuit-rejection counter so a storm
// that fills the queue is distinguishable from an OPEN circuit.
const signalsCallQueueRejectionsCounter = registerCounter({
  name: 'signals_call_queue_rejections_total',
  help: 'Signals calls rejected at 0ms because the per-pod queue was full',
});

// Active/queue gauges are sampled lazily on /metrics scrape so the hot path
// stays untouched. Use raw prom-client + HMR guard so we don't need to plumb
// label-less helpers through prom/client.ts.
declare global {
  // eslint-disable-next-line no-var
  var signalsWrapperGaugesRegistered: boolean | undefined;
}

function unlabeledGauge(name: string, help: string, collect: (g: client.Gauge<string>) => void) {
  const full = `civitai_app_${name}`;
  try {
    return new client.Gauge({
      name: full,
      help,
      collect() {
        collect(this as unknown as client.Gauge<string>);
      },
    });
  } catch {
    return client.register.getSingleMetric(full) as client.Gauge<string>;
  }
}

if (!global.signalsWrapperGaugesRegistered) {
  unlabeledGauge('signals_call_active', 'In-flight wrapped signals calls', (g) => {
    g.set(limiter.activeCount);
  });
  unlabeledGauge(
    'signals_call_queue_depth',
    'Queued (not-yet-running) wrapped signals calls',
    (g) => {
      g.set(limiter.pendingCount);
    }
  );
  unlabeledGauge(
    'signals_circuit_state',
    'Signals circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
    (g) => {
      const s = circuit.state;
      g.set(s === 'CLOSED' ? 0 : s === 'HALF_OPEN' ? 1 : 2);
    }
  );
  global.signalsWrapperGaugesRegistered = true;
}

const signalsCallDurationHistogram = registerHistogram({
  name: 'signals_call_duration_seconds',
  help: 'Wall-clock duration of wrapped signals HTTP calls',
  // Spans 1ms → 30s. Denser between 100ms and 10s where signals normal+brownout
  // zone lives (signals is slower than Meili in healthy state).
  buckets: [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3.5, 5, 7.5, 10, 15, 30],
});

// Per-trip counter (CLOSED→OPEN transitions). Separate from the rejection
// counter below for the same reason as the Meili wrapper:
// trips = rate of state changes; rejections = rate of fast-fail events.
const signalsCircuitTripsCounter = registerCounter({
  name: 'signals_circuit_trips_total',
  help: 'Count of CLOSED→OPEN (or HALF_OPEN→OPEN re-trips) transitions for signals',
});

// Per-call rejections while the circuit is OPEN or HALF_OPEN-with-trial-busy.
// Kept SEPARATE from signals_call_timeouts_total — that counter's documented
// meaning is "backend timed out at SIGNALS_CALL_TIMEOUT_MS". Conflating
// circuit-open rejections (which never touch the backend) would inflate it
// at request-arrival rate during OPEN and falsely trigger any alert keyed on
// rate(signals_call_timeouts_total). Operators wanting "all fast-fail events"
// should sum these two.
const signalsCircuitRejectionsCounter = registerCounter({
  name: 'signals_circuit_rejections_total',
  help: 'Calls rejected at 0ms because circuit was OPEN or HALF_OPEN-busy',
});

// ────────────────────────────────────────────────────────────────────────────
// Circuit breaker — single backend, no label
// ────────────────────────────────────────────────────────────────────────────

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

type Circuit = {
  state: CircuitState;
  // Unix ms timestamps of recent counted failures. Pruned on each access.
  failures: number[];
  // Unix ms timestamps of recent backend EVIDENCE (header comment) — what lets
  // queue-side failures count. Pruned with the same window as `failures`.
  backendFailures: number[];
  // ms-since-epoch; only meaningful when state === 'OPEN'.
  cooldownUntil: number;
  // While HALF_OPEN, whether the single trial slot is currently in flight.
  // Prevents a thundering-herd retry against a still-broken backend.
  trialInFlight: boolean;
};

const circuit: Circuit = {
  state: 'CLOSED',
  failures: [],
  backendFailures: [],
  cooldownUntil: 0,
  trialInFlight: false,
};

function circuitWindowMs() {
  return env.SIGNALS_CIRCUIT_WINDOW_SECONDS * 1000;
}
function circuitCooldownMs() {
  return env.SIGNALS_CIRCUIT_COOLDOWN_SECONDS * 1000;
}

function pruneWindow(timestamps: number[], cutoff: number) {
  let i = 0;
  while (i < timestamps.length && timestamps[i] < cutoff) i++;
  if (i > 0) timestamps.splice(0, i);
}

function pruneFailures(c: Circuit, now: number) {
  const cutoff = now - circuitWindowMs();
  pruneWindow(c.failures, cutoff);
  pruneWindow(c.backendFailures, cutoff);
}

function transition(c: Circuit, next: CircuitState, now: number) {
  if (c.state === next) return;
  const wasOpen = c.state === 'OPEN' || c.state === 'HALF_OPEN';
  c.state = next;
  if (next === 'OPEN') {
    c.cooldownUntil = now + circuitCooldownMs();
    c.trialInFlight = false;
    signalsCircuitTripsCounter.inc();
  } else if (next === 'HALF_OPEN') {
    c.trialInFlight = false;
  } else if (next === 'CLOSED') {
    c.failures = [];
    c.backendFailures = [];
    c.cooldownUntil = 0;
    c.trialInFlight = false;
  }
  if (wasOpen || next !== 'CLOSED') {
    log(`signals circuit → ${next}`);
  }
}

function admitCall(): { admitted: boolean; isTrial: boolean } {
  const c = circuit;
  const now = Date.now();
  pruneFailures(c, now);

  if (c.state === 'OPEN') {
    if (now >= c.cooldownUntil) {
      transition(c, 'HALF_OPEN', now);
      // Fall through into HALF_OPEN handling below.
    } else {
      return { admitted: false, isTrial: false };
    }
  }

  if (c.state === 'HALF_OPEN') {
    if (c.trialInFlight) {
      return { admitted: false, isTrial: false };
    }
    c.trialInFlight = true;
    return { admitted: true, isTrial: true };
  }

  return { admitted: true, isTrial: false };
}

// Fraction of SIGNALS_CALL_TIMEOUT_MS that (a) a queued call must still have
// left to be started, and (b) fn() must have run before a rejection counts as
// backend evidence (header comment).
const MIN_BUDGET_FRACTION = 0.5;
function minBudgetMs() {
  return env.SIGNALS_CALL_TIMEOUT_MS * MIN_BUDGET_FRACTION;
}

/**
 * How a wrapped call ended, from the circuit's point of view:
 *   success        — fn() resolved before the deadline
 *   fastError      — fn() rejected (or threw) after running < half the deadline
 *   backendError   — fn() rejected after running >= half the deadline
 *   backendTimeout — fn() was started and the deadline fired
 *   queueFull      — rejected at entry, queue bound reached; fn() never ran
 *   queueExpired   — deadline reached while queued, or not started for lack of
 *                    budget; fn() never ran
 */
type CallOutcome =
  | 'success'
  | 'fastError'
  | 'backendError'
  | 'backendTimeout'
  | 'queueFull'
  | 'queueExpired';

function classifyOutcome(
  timedOut: boolean,
  rejected: boolean,
  startedAt: number | undefined,
  deadlineAt: number
): CallOutcome {
  if (startedAt === undefined) return 'queueExpired';
  if (timedOut) return 'backendTimeout';
  if (!rejected) return 'success';
  // How long fn() held its slot before rejecting (capped at the deadline).
  const heldFor = Math.min(Date.now(), deadlineAt) - startedAt;
  return heldFor >= minBudgetMs() ? 'backendError' : 'fastError';
}

function recordCallOutcome(isTrial: boolean, outcome: CallOutcome) {
  const c = circuit;
  const now = Date.now();
  pruneFailures(c, now);

  if (outcome === 'backendTimeout' || outcome === 'backendError') {
    c.backendFailures.push(now);
  }
  const shed = outcome === 'queueFull' || outcome === 'queueExpired';
  // See the header comment: a backend timeout always counts; a queue-side
  // failure counts only when backend evidence is in the window.
  const counted = outcome === 'backendTimeout' || (shed && c.backendFailures.length > 0);
  if (counted) {
    c.failures.push(now);
  }

  if (isTrial) {
    c.trialInFlight = false;
    // A shed trial never probed the backend, so it is not a trial result:
    // stay HALF_OPEN and let the next caller probe.
    if (shed) return;
    // Any fn() rejection (fast or slow) closes, as before this change.
    transition(c, outcome === 'backendTimeout' ? 'OPEN' : 'CLOSED', now);
    return;
  }

  if (c.state === 'CLOSED' && counted && c.failures.length >= env.SIGNALS_CIRCUIT_TRIP_THRESHOLD) {
    transition(c, 'OPEN', now);
  }
}

/**
 * Run a single signals HTTP call under per-pod concurrency cap + hard per-call
 * timeout + circuit breaker. Throws SignalsCallTimeoutError on the timeout /
 * circuit-rejection paths so callers can fail-fast (408 / TRPCError TIMEOUT)
 * instead of hanging until Traefik's 30s router timeout fires.
 *
 * SCOPE: wrap ONLY the outbound `fetch(SIGNALS_ENDPOINT/...)` call. Do NOT
 * wrap surrounding DB/Redis/cache work — those are independent dependencies
 * and a slow query should not consume a signals semaphore slot.
 *
 * Many existing signals call sites are fire-and-forget (`fetch(...).catch()`).
 * Those callers can still benefit from withSignals() — once the limiter is
 * saturated or the circuit is OPEN, the wrapper short-circuits at 0ms and the
 * `.catch()` swallows the error as it does today. The benefit is that the
 * orphan fetch promise no longer hogs an event-loop slot for the full
 * router-timeout duration.
 *
 * Queue: bounded at SIGNALS_CALL_MAX_QUEUE live waiting calls. The deadline
 * runs from entry, so a call that waits in the queue past it — or reaches its
 * slot with less than half of it left — rejects with
 * SignalsCallTimeoutError('timeout') and its fn() is never invoked (no
 * outbound fetch fires for a caller that gave up). A full queue rejects at 0ms
 * with reason 'concurrency'. Whether either counts toward the circuit depends on
 * backend evidence in the window (header comment); a shed HALF_OPEN trial
 * always releases `trialInFlight`.
 */
export async function withSignals<T>(fn: () => Promise<T>): Promise<T> {
  // Circuit breaker gate — runs synchronously before the pLimit acquire.
  const decision = admitCall();
  if (!decision.admitted) {
    signalsCircuitRejectionsCounter.inc();
    throw new SignalsCallTimeoutError('concurrency', 'Signals circuit open — failing fast');
  }
  const isTrial = decision.isTrial;

  // Queue bound. `outstanding` counts running + live-queued calls, so the
  // queue is full once it reaches concurrency + max queue.
  if (outstanding >= env.SIGNALS_CALL_CONCURRENCY + env.SIGNALS_CALL_MAX_QUEUE) {
    signalsCallQueueRejectionsCounter.inc();
    recordCallOutcome(isTrial, 'queueFull');
    throw new SignalsCallTimeoutError('concurrency', 'Signals call queue full — failing fast');
  }

  const endTimer = signalsCallDurationHistogram.startTimer();
  const deadlineAt = Date.now() + env.SIGNALS_CALL_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  // When fn() was invoked (undefined: never), and whether the call rejected
  // for any reason — with `timedOut` these classify the outcome (classifyOutcome).
  let startedAt: number | undefined;
  let rejected = false;
  // One deadline for the whole call, armed at entry: it covers queue wait AND
  // execution. It rejects both the outer race (the caller's promise) and the
  // inner race (which releases the limiter slot).
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      signalsCallTimeoutsCounter.inc();
      reject(new SignalsCallTimeoutError('timeout'));
    }, env.SIGNALS_CALL_TIMEOUT_MS);
    timer.unref?.();
  });
  deadline.catch(() => undefined);

  // Increment immediately before the `try` whose `finally` decrements it —
  // anything that could throw in between would leak a slot of the queue bound.
  outstanding++;
  try {
    return await Promise.race([
      limiter(async () => {
        // Deadline already fired while queued: the caller has its rejection and
        // the timeout was counted. (Not reachable today — FIFO + one deadline
        // length means every slot frees by our deadline, holder first on a tie
        // — but it keeps the check below from counting the timeout twice.)
        if (timedOut) return deadline;
        // Minimum start budget (header comment): less than half the deadline
        // left → never call fn() (no outbound fetch for a caller that has
        // probably lost), reject the caller now and free the slot now. This
        // also covers a slot that frees in the same ms as our own deadline:
        // the slot holder's timer can fire just before ours does.
        if (deadlineAt - Date.now() < minBudgetMs()) {
          signalsCallTimeoutsCounter.inc();
          throw new SignalsCallTimeoutError(
            'timeout',
            'Signals call could not start with enough of its deadline left'
          );
        }
        // Capture the call so we can absorb a late rejection if the deadline
        // wins the race. The underlying `fetch` may continue running
        // (especially if the caller didn't provide an AbortSignal); the orphan
        // settles silently. Without this catch, a late rejection bubbles to
        // `unhandledRejection` — Node ≥15's default exit-on-unhandled would turn
        // our brownout protection into pod-crash amplification.
        startedAt = Date.now();
        const call = fn();
        call.catch(() => undefined);
        return await Promise.race([call, deadline]);
      }),
      deadline,
    ]);
  } catch (err) {
    rejected = true;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    outstanding--;
    // EMERGENCY 2026-05-30: a metric-observation error MUST NOT propagate
    // into the app request path. We observed prom-client Histogram.observe
    // throwing `Cannot read properties of undefined (reading 'length')` at
    // 22/s per pod on signals.getToken (PR #2366 deploy), turning every
    // wrapped signals call into an INTERNAL_SERVER_ERROR — the exact
    // cascade pattern the wrap was supposed to prevent. Root cause of the
    // bad histogram state is still under investigation; this catch is the
    // unconditional safety net so a broken observation can't kill traffic.
    try {
      endTimer();
    } catch {
      // intentionally swallowed
    }
    recordCallOutcome(isTrial, classifyOutcome(timedOut, rejected, startedAt, deadlineAt));
  }
}
