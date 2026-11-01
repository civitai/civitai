import pLimit from 'p-limit';
import client from 'prom-client';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import {
  registerCounter,
  registerCounterWithLabels,
  registerHistogram,
} from '~/server/prom/client';

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
 *     ran in any of them): counts ONLY if the window holds backend evidence,
 *     and never for the 'token' lane (see LANES below).
 *   So a healthy burst far past the queue bound (e.g. a synchronized client
 *   reconnect after recovery, even one following a fast-failing outage) and a
 *   healthy-but-overloaded backend are shed and never open the circuit, AS
 *   LONG AS every call's latency — tail included — stays under half the
 *   deadline: every call they start then completes. Under overload a call may
 *   start with only half the deadline left, so a call slower than its
 *   remaining budget becomes a backend timeout (evidence) by design, and the
 *   shed traffic then counts (default lane only). Token-lane backend
 *   timeouts count toward the shared threshold too, so enough token calls
 *   slower than their remaining budget can open the circuit for pushes.
 *   A hang — from an idle or an already-saturated pool — trips it: the calls
 *   it starts time out. Evidence is pruned with the same window as failures
 *   and cleared when the circuit CLOSES.
 *   - A HALF_OPEN trial that suffers a queue-side failure probed nothing, so it
 *     is NOT a failed trial: it releases `trialInFlight` and the circuit stays
 *     HALF_OPEN; the next caller becomes the trial. A trial whose fn() rejects
 *     closes the circuit (unchanged).
 *
 * Defaults are HIGHER than Meili because signals normally takes longer (Orleans
 * grain init):
 *   SIGNALS_CALL_TIMEOUT_MS       5000  (Meili: 2500) — total deadline from
 *                                       withSignals() entry: queue wait + call
 *   SIGNALS_CALL_CONCURRENCY      30    (Meili: 50)  — 'default' lane
 *   SIGNALS_CALL_MAX_QUEUE        200   (Meili: unbounded) — live queued calls
 *                                       beyond this reject at 0ms ('default')
 *   SIGNALS_TOKEN_CALL_CONCURRENCY 30   — 'token' lane (getAccessToken only)
 *   SIGNALS_TOKEN_CALL_MAX_QUEUE  200   — 'token' lane queue bound
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
 * LANES: each call runs in a lane with its OWN p-limit limiter, concurrency
 * and queue bound, so a getToken reconnect storm cannot crowd out signal
 * pushes. 'token' is used ONLY by getAccessToken (signals.service.ts); every
 * other caller (signal pushes, chat, training webhooks, orchestrator) uses
 * 'default'. The token lane's defaults equal the single limiter getToken used
 * to share (30 / 200), so getToken sees the same bounds as before; the
 * default lane keeps its own 30 / 200. A pod can therefore hold up to 60
 * signals calls in flight (30 per lane) instead of 30. The CIRCUIT BREAKER is
 * SHARED: a sick backend stops both lanes — backend timeouts and backend
 * evidence from EITHER lane feed it. But the token lane's queue-side failures
 * (queue full / expired in queue / not started) never count toward it: they
 * measure token DEMAND, and counting them would let a healthy token storm
 * open the circuit and shut down pushes — the crowding-out the lane exists to
 * prevent. A sick backend still trips it through the token lane's own backend
 * timeouts (~concurrency per deadline). Limit: that protection holds while
 * token latency, tail included, stays under the budget a queued token call
 * starts with (>= half the deadline). A token call slower than that is a real
 * backend timeout and DOES count — shared by design — so a token storm
 * against a backend whose tail nears half the deadline can still open the
 * circuit for pushes.
 * Metrics carry a `lane` label where they are per-lane (active, queue depth,
 * queue rejections, queue expirations); sum() over the label gives the
 * pod-wide figure the single-lane metric used to report.
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
 * the circuit breaker is OPEN or the call's lane queue is full (reason
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

export type SignalsLane = 'default' | 'token';
const LANE_NAMES: readonly SignalsLane[] = ['default', 'token'];

type Lane = {
  limiter: ReturnType<typeof pLimit>;
  concurrency: () => number;
  maxQueue: () => number;
  // Calls in this lane that are queued or running and have not yet settled.
  // Bounds the queue instead of `limiter.pendingCount`, which lags a microtask
  // behind enqueue even when a slot is free (a synchronous burst would read as
  // queued and be shed spuriously).
  outstanding: number;
  // Calls in this lane still waiting for a slot (live: excludes calls that
  // already settled while queued). Reported as signals_call_queue_depth.
  queued: number;
  // Whether this lane's queue-side failures may count toward the shared
  // circuit (with evidence). False for 'token' — see LANES in the header.
  shedFeedsCircuit: boolean;
};

// 🔴 SHARED_STATE: the lanes (limiters + queue counters) and the circuit live on
// globalThis, not in module scope.
//
// The production server build emits this module once per Turbopack runtime
// (`chunks/` for API routes + instrumentation, `chunks/ssr/` for page SSR —
// measured: one module id under each), and each runtime keeps its own module
// cache, so ONE Node process evaluates it twice. With module-scope state each
// copy had its own limiters, queue bounds and circuit: every per-lane limit
// applied PER COPY (a pod's real signals in-flight cap was copies × limit), a
// backend outage tripped through one copy never failed calls made through the
// other, and the collect()-based gauges read whichever copy owned the hook.
// prom-client is externalized, so both copies already share ONE registry and
// one set of counters; this makes the limiters and the circuit match.
//
// `??=`, not `=`: with `=`, a later copy would REPLACE the state and orphan the
// first copy's in-flight slots and counts. Enrolled in
// scripts/server-graph-watchlist.mjs so the build fails if an emitted copy
// loses this pin. Vitest loads each module once and cannot see any of this
// unless forced to (src/server/signals/__tests__/wrapper-gauges.dual-graph.test.ts).
// Same pattern as `__civitaiBulkheadState` (src/server/utils/request-bulkhead.ts)
// and the Meili wrapper fix in civitai/civitai#5578. Dev caveat: the state also
// survives a dev-server module reload, so a changed lane default or lane
// concurrency/queue env value takes effect only after a restart (timeout and
// circuit settings are read per call and do follow a reload; production env is
// fixed per process).
declare global {
  // eslint-disable-next-line no-var
  var __civitaiSignalsWrapperState:
    | {
        lanes: Record<SignalsLane, Lane>;
        circuit: Circuit;
      }
    | undefined;
}

const signalsWrapperState = (globalThis.__civitaiSignalsWrapperState ??= {
  lanes: {
    default: {
      limiter: pLimit(env.SIGNALS_CALL_CONCURRENCY),
      concurrency: () => env.SIGNALS_CALL_CONCURRENCY,
      maxQueue: () => env.SIGNALS_CALL_MAX_QUEUE,
      outstanding: 0,
      queued: 0,
      shedFeedsCircuit: true,
    },
    token: {
      limiter: pLimit(env.SIGNALS_TOKEN_CALL_CONCURRENCY),
      concurrency: () => env.SIGNALS_TOKEN_CALL_CONCURRENCY,
      maxQueue: () => env.SIGNALS_TOKEN_CALL_MAX_QUEUE,
      outstanding: 0,
      queued: 0,
      shedFeedsCircuit: false,
    },
  },
  circuit: {
    state: 'CLOSED',
    failures: [],
    backendFailures: [],
    cooldownUntil: 0,
    trialInFlight: false,
  },
});

// Process-wide, shared by every emitted copy of this module (SHARED_STATE above).
const lanes = signalsWrapperState.lanes;

// ────────────────────────────────────────────────────────────────────────────
// Observability — single backend; per-lane metrics carry a `lane` label
// ────────────────────────────────────────────────────────────────────────────

// BACKEND timeouts only: fn() was started and the deadline fired. A call that
// never reached the backend (expired while queued / not started for lack of
// budget) is signals_call_queue_expirations_total instead.
const signalsCallTimeoutsCounter = registerCounter({
  name: 'signals_call_timeouts_total',
  help: 'Signals backend timeouts (fn() started, deadline from entry exceeded)',
});

// Calls rejected at 0ms because the lane's queue bound was reached. Separate
// from the circuit-rejection counter so a storm that fills a queue is
// distinguishable from an OPEN circuit.
const signalsCallQueueRejectionsCounter = registerCounterWithLabels({
  name: 'signals_call_queue_rejections_total',
  help: 'Signals calls rejected at 0ms because the lane queue was full',
  labelNames: ['lane'] as const,
});

// Calls that waited in the queue and never reached the backend: the deadline
// fired while queued, or the call reached its slot with less than half its
// deadline left and was not started. They never touched the backend, so they
// are NOT signals_call_timeouts_total.
const signalsCallQueueExpirationsCounter = registerCounterWithLabels({
  name: 'signals_call_queue_expirations_total',
  help: 'Signals calls that expired in the queue or were not started for lack of deadline budget',
  labelNames: ['lane'] as const,
});

// Active/queue/circuit gauges are sampled lazily on /metrics scrape so the hot
// path stays untouched. Raw prom-client (not the ~/server/prom/client helpers,
// which many tests hand-mock without gauge exports). Every emitted copy
// get-or-creates each gauge in the one shared registry and installs its
// collect(); since every copy's collect() reads the SAME shared state, it does
// not matter which copy's hook is installed last (this replaces an earlier
// first-copy-wins registration flag).
type CollectHook = { collect: () => void };
function sharedGauge(name: string, help: string, labelNames: string[] = []) {
  const full = `civitai_app_${name}`;
  return (
    (client.register.getSingleMetric(full) as client.Gauge<string> | undefined) ??
    new client.Gauge({ name: full, help, labelNames })
  );
}
const signalsCallActiveGauge = sharedGauge(
  'signals_call_active',
  'Occupied limiter slots per lane',
  ['lane']
);
// The wrapper's own live count of waiting calls — the population the queue
// bound limits. limiter.pendingCount reports the same number on a real event
// loop (a queued call cannot settle before it is dequeued: FIFO + one deadline
// length); this keeps gauge and bound on one definition.
const signalsCallQueueDepthGauge = sharedGauge(
  'signals_call_queue_depth',
  'Live queued (waiting for a slot) signals calls per lane',
  ['lane']
);
const signalsCircuitStateGauge = sharedGauge(
  'signals_circuit_state',
  'Signals circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)'
);
(signalsCallActiveGauge as unknown as CollectHook).collect = function collect() {
  for (const lane of LANE_NAMES)
    signalsCallActiveGauge.set({ lane }, lanes[lane].limiter.activeCount);
};
(signalsCallQueueDepthGauge as unknown as CollectHook).collect = function collect() {
  for (const lane of LANE_NAMES) signalsCallQueueDepthGauge.set({ lane }, lanes[lane].queued);
};
(signalsCircuitStateGauge as unknown as CollectHook).collect = function collect() {
  const st = circuit.state;
  signalsCircuitStateGauge.set(st === 'CLOSED' ? 0 : st === 'HALF_OPEN' ? 1 : 2);
};

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
// Kept SEPARATE from signals_call_timeouts_total — that counter means "fn()
// was started and the backend timed out at SIGNALS_CALL_TIMEOUT_MS"; calls that
// never reached the backend are not in it (queue rejections / expirations have
// their own counters). Conflating
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

// Process-wide, shared by every emitted copy of this module (SHARED_STATE above).
const circuit: Circuit = signalsWrapperState.circuit;

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

function recordCallOutcome(isTrial: boolean, outcome: CallOutcome, lane: Lane) {
  const c = circuit;
  const now = Date.now();
  pruneFailures(c, now);

  if (outcome === 'backendTimeout' || outcome === 'backendError') {
    c.backendFailures.push(now);
  }
  const shed = outcome === 'queueFull' || outcome === 'queueExpired';
  // See the header comment: a backend timeout always counts; a queue-side
  // failure counts only when backend evidence is in the window, and never for
  // a lane whose queue measures demand only (shedFeedsCircuit: false).
  const counted =
    outcome === 'backendTimeout' || (shed && lane.shedFeedsCircuit && c.backendFailures.length > 0);
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
 * Run a single signals HTTP call under its lane's concurrency cap + hard per-call
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
 * Lane: `opts.lane` picks the limiter + queue bound ('default' unless given;
 * 'token' is reserved for getAccessToken — see LANES in the header).
 *
 * Queue: bounded per lane (SIGNALS_CALL_MAX_QUEUE / SIGNALS_TOKEN_CALL_MAX_QUEUE
 * live waiting calls). The deadline
 * runs from entry, so a call that waits in the queue past it — or reaches its
 * slot with less than half of it left — rejects with
 * SignalsCallTimeoutError('timeout') and its fn() is never invoked (no
 * outbound fetch fires for a caller that gave up). A full queue rejects at 0ms
 * with reason 'concurrency'. Whether either counts toward the circuit depends on
 * backend evidence in the window and on the lane (never for 'token'; header
 * comment); a shed HALF_OPEN trial always releases `trialInFlight`.
 */
export async function withSignals<T>(
  fn: () => Promise<T>,
  opts: { lane?: SignalsLane } = {}
): Promise<T> {
  const laneName = opts.lane ?? 'default';
  const lane = lanes[laneName];
  // Circuit breaker gate — runs synchronously before the pLimit acquire.
  const decision = admitCall();
  if (!decision.admitted) {
    signalsCircuitRejectionsCounter.inc();
    throw new SignalsCallTimeoutError('concurrency', 'Signals circuit open — failing fast');
  }
  const isTrial = decision.isTrial;

  // Queue bound. `outstanding` counts the lane's running + live-queued calls,
  // so the lane's queue is full once it reaches concurrency + max queue.
  if (lane.outstanding >= lane.concurrency() + lane.maxQueue()) {
    signalsCallQueueRejectionsCounter.inc({ lane: laneName });
    recordCallOutcome(isTrial, 'queueFull', lane);
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
  // Still waiting for a slot (counted in lane.queued until it gets one or the
  // call settles first).
  let waiting = true;
  const stopWaiting = () => {
    if (waiting) {
      waiting = false;
      lane.queued--;
    }
  };
  // One deadline for the whole call, armed at entry: it covers queue wait AND
  // execution. It rejects both the outer race (the caller's promise) and the
  // inner race (which releases the limiter slot).
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Backend timeout only if fn() was started; otherwise the call never
      // left the queue.
      if (startedAt !== undefined) signalsCallTimeoutsCounter.inc();
      else signalsCallQueueExpirationsCounter.inc({ lane: laneName });
      reject(new SignalsCallTimeoutError('timeout'));
    }, env.SIGNALS_CALL_TIMEOUT_MS);
    timer.unref?.();
  });
  deadline.catch(() => undefined);

  // Increment immediately before the `try` whose `finally` decrements it —
  // anything that could throw in between would leak a slot of the queue bound.
  lane.outstanding++;
  lane.queued++;
  try {
    return await Promise.race([
      lane.limiter(async () => {
        stopWaiting();
        // Deadline already fired while queued: the caller has its rejection and
        // the expiry was counted. (Not reachable on a real event loop — FIFO
        // + one deadline length means every slot frees by our deadline, holder
        // first on a tie — but it keeps the check below from counting the
        // expiry twice if timers ever fire back to back.)
        if (timedOut) return deadline;
        // Minimum start budget (header comment): less than half the deadline
        // left → never call fn() (no outbound fetch for a caller that has
        // probably lost), reject the caller now and free the slot now. This
        // also covers a slot that frees in the same ms as our own deadline:
        // the slot holder's timer can fire just before ours does.
        if (deadlineAt - Date.now() < minBudgetMs()) {
          signalsCallQueueExpirationsCounter.inc({ lane: laneName });
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
    stopWaiting();
    lane.outstanding--;
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
    recordCallOutcome(isTrial, classifyOutcome(timedOut, rejected, startedAt, deadlineAt), lane);
  }
}
