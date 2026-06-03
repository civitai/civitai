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
 *
 * Defaults are HIGHER than Meili because signals normally takes longer (Orleans
 * grain init):
 *   SIGNALS_CALL_TIMEOUT_MS       5000  (Meili: 2500)
 *   SIGNALS_CALL_CONCURRENCY      30    (Meili: 50)
 *   SIGNALS_CIRCUIT_WINDOW_SECONDS 60   (Meili: 30)
 *   SIGNALS_CIRCUIT_TRIP_THRESHOLD 10
 *   SIGNALS_CIRCUIT_COOLDOWN_SECONDS 30
 *
 * SCOPE: wrap ONLY the actual `fetch(SIGNALS_ENDPOINT/...)` call. Do NOT wrap
 * surrounding DB/Redis work — those are independent dependencies and should not
 * consume a signals semaphore slot nor be attributed to a signals timeout.
 *
 * The SignalR websocket itself is NOT wrapped — only the HTTP API.
 */

/**
 * Typed error thrown by withSignals() when a wrapped signals call exceeds
 * SIGNALS_CALL_TIMEOUT_MS, or when the circuit breaker is OPEN.
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

// ────────────────────────────────────────────────────────────────────────────
// Observability — single-backend, no label
// ────────────────────────────────────────────────────────────────────────────

const signalsCallTimeoutsCounter = registerCounter({
  name: 'signals_call_timeouts_total',
  help: 'Signals wrapped-call timeouts (per-call deadline exceeded)',
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
  // ms-since-epoch; only meaningful when state === 'OPEN'.
  cooldownUntil: number;
  // While HALF_OPEN, whether the single trial slot is currently in flight.
  // Prevents a thundering-herd retry against a still-broken backend.
  trialInFlight: boolean;
};

const circuit: Circuit = {
  state: 'CLOSED',
  failures: [],
  cooldownUntil: 0,
  trialInFlight: false,
};

function circuitWindowMs() {
  return env.SIGNALS_CIRCUIT_WINDOW_SECONDS * 1000;
}
function circuitCooldownMs() {
  return env.SIGNALS_CIRCUIT_COOLDOWN_SECONDS * 1000;
}

function pruneFailures(c: Circuit, now: number) {
  const cutoff = now - circuitWindowMs();
  let i = 0;
  while (i < c.failures.length && c.failures[i] < cutoff) i++;
  if (i > 0) c.failures.splice(0, i);
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

function recordCallOutcome(isTrial: boolean, failed: boolean) {
  const c = circuit;
  const now = Date.now();
  pruneFailures(c, now);

  if (failed) {
    c.failures.push(now);
  }

  if (isTrial) {
    c.trialInFlight = false;
    if (failed) {
      transition(c, 'OPEN', now);
    } else {
      transition(c, 'CLOSED', now);
    }
    return;
  }

  if (
    c.state === 'CLOSED' &&
    failed &&
    c.failures.length >= env.SIGNALS_CIRCUIT_TRIP_THRESHOLD
  ) {
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
 * The queue is intentionally unbounded — same reasoning as withMeili. The
 * timeout is the safety net; a queue-depth cap adds a TOCTOU race without
 * strengthening the guarantee.
 */
export async function withSignals<T>(fn: () => Promise<T>): Promise<T> {
  // Circuit breaker gate — runs synchronously before the pLimit acquire.
  const decision = admitCall();
  if (!decision.admitted) {
    signalsCircuitRejectionsCounter.inc();
    throw new SignalsCallTimeoutError(
      'concurrency',
      'Signals circuit open — failing fast'
    );
  }
  const isTrial = decision.isTrial;

  const endTimer = signalsCallDurationHistogram.startTimer();
  return limiter(async () => {
    let timer: NodeJS.Timeout | undefined;
    let failedForCircuit = false;
    // Capture the call so we can absorb a late rejection if the timeout wins
    // the race. The underlying `fetch` may continue running (especially if the
    // caller didn't provide an AbortSignal); the orphan settles silently.
    // Without this catch, a late rejection bubbles to `unhandledRejection` —
    // Node ≥15's default exit-on-unhandled would turn our brownout protection
    // into pod-crash amplification.
    const call = fn();
    call.catch(() => undefined);
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            signalsCallTimeoutsCounter.inc();
            failedForCircuit = true;
            reject(new SignalsCallTimeoutError('timeout'));
          }, env.SIGNALS_CALL_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
      recordCallOutcome(isTrial, failedForCircuit);
    }
  });
}
