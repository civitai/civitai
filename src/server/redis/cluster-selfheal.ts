/**
 * Cluster-client self-heal watchdog (FIX #1 for the node-redis cluster inflight-leak wedge).
 *
 * WHY (civitai-dp-prod api-primary): a small fraction of cluster command promises get
 * ORPHANED across a cluster retry / `_slots.rediscover()` topology refresh and never
 * settle. The per-command deadline (withCommandDeadline / REDIS_CLUSTER_COMMAND_TIMEOUT_MS)
 * reaps each *individual* orphaned command — it turns the 125s hang into an error so the
 * inflight gauge dec's and the handler unparks — but it NEVER resets the wedged
 * client/socket. Once a pod starts orphaning, the NEXT command orphans identically, so the
 * pod 500s / slow-degrades indefinitely. ONLY a full client reconnect (rebuilds the
 * connections + `_slots`) or a process restart clears the orphaned `_execute` promises.
 *
 * TWO TRIGGERS (either forces a reconnect, subject to the shared cooldown + single-flight):
 *
 *   TRIGGER 1 — DEADLINE-HIT RATE (the real-wave signal, sawtooth-immune): N cluster
 *   command-deadline TIMEOUTS within a sliding window. A healthy client hits the 15s deadline
 *   ZERO times; a half-open client hits it on ~every command. This is the trigger that
 *   actually fires during a real fleet wave (see the bug below).
 *
 *   TRIGGER 2 — SUSTAINED INFLIGHT (legacy continuous-breach): `redis_commands_inflight`
 *   pinned above a threshold CONTINUOUSLY for the sustained window. Kept as a backstop for
 *   wedge shapes that leak inflight without deadline-rejecting.
 *
 * THE BUG TRIGGER 1 FIXES: TRIGGER 2 alone NEVER fired during real waves. The per-command
 * deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS = 15s) mass-rejects the parked commands every
 * ~15s, so inflight SAWTOOTHS to ~0 and the sustained-breach timer (sustainedMs = 20s > 15s)
 * resets before it can accumulate 20 continuous seconds. Confirmed live: 21 pods wedged to
 * inflight≈200 for 6–12 min with selfheal_reconnect_total = 0 across the fleet. The
 * deadline-TIMEOUT rate is immune to that drain (the drains ARE the timeouts).
 *
 * RECONNECT-STORM SAFETY — three independent brakes:
 *   1. SUSTAINED window: a transient spike drops back under the threshold within the window
 *      and resets the timer → no reconnect. Only a genuine pinned wedge survives the window.
 *   2. COOLDOWN: at most ONE reconnect per cooldown, regardless of how long inflight stays
 *      pinned. After a reconnect the watchdog re-arms only after the cooldown elapses.
 *   3. SINGLE-FLIGHT: while a reconnect is in progress, ticks are skipped.
 *
 * MONEY/ENTITLEMENT SAFETY: a reconnect rejects the pod's in-flight cluster commands. That
 * reject surfaces as a NORMAL command error (a rejected promise) on whatever path issued the
 * command — it can NEVER silently succeed-or-skip. The cluster client carries cache/metric
 * traffic; money/entitlement state lives in Postgres and the sysRedis (single-node) client,
 * which this watchdog NEVER touches. Any caller that does issue a money-adjacent cluster
 * command sees the same rejection it already gets for any cluster error and must retry/handle
 * it — identical to a socketTimeout teardown today.
 *
 * This module is PURE (no redis/prom imports) so it can be unit-tested by driving `tick()`
 * with a fake clock + injected counter/reconnect, mirroring the command-deadline / sentinel
 * test pattern. client.ts constructs one instance per cluster client and drives it on an
 * interval.
 */

export interface ClusterSelfHealConfig {
  /** Master kill-switch. When false, tick() is a no-op and never reconnects. */
  enabled: boolean;
  /** Inflight count strictly above which a pod is considered potentially wedged. */
  inflightThreshold: number;
  /** Inflight must stay above the threshold continuously for this long before reconnecting. */
  sustainedMs: number;
  /** Minimum wall-clock time between two reconnects. */
  cooldownMs: number;
  /**
   * DEADLINE-HIT TRIGGER (the sawtooth-immune signal — see deadlineHitWindowMs note below).
   * If this many cluster command-deadline TIMEOUTS occur within `deadlineHitWindowMs`, force a
   * reconnect IMMEDIATELY (subject to the cooldown), WITHOUT requiring inflight to stay
   * continuously above the threshold. <= 0 disables this trigger (inflight path only).
   *
   * WHY this exists: the inflight-continuity trigger above can NEVER fire during a real
   * half-open park, because the per-command deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS = 15s)
   * mass-rejects the parked commands every ~15s → inflight sawtooths to ~0 → the sustained
   * timer (sustainedMs = 20s > 15s) resets before it can accumulate. Confirmed live: 21 pods
   * wedged to inflight≈200 for minutes with selfheal_reconnect_total = 0. The deadline-TIMEOUT
   * rate is immune to that drain (the drains ARE the timeouts), so a half-open trips this fast.
   */
  deadlineHitThreshold: number;
  /**
   * Sliding window (ms) over which deadlineHitThreshold deadline timeouts are counted. A
   * healthy client hits the 15s deadline ZERO times in any window; a half-open client hits it
   * continuously. Default sized so a genuine wedge (every cluster read deadline-rejecting)
   * trips well inside the kubelet readiness-shed threshold, while a one-off transient slow
   * command (a single deadline hit) does not.
   */
  deadlineHitWindowMs: number;
}

export interface ClusterSelfHealDeps {
  /** Reads the current in-process cluster inflight count (same source as the gauge). */
  getInflight: () => number;
  /**
   * Reads the number of cluster command-deadline timeouts within the last `deadlineHitWindowMs`
   * (the sawtooth-immune wedge signal). Receives the window so the recorder owns the windowing.
   * Optional so existing callers/tests that only drive the inflight path can omit it (treated
   * as 0 → deadline trigger inert).
   */
  getDeadlineHits?: (windowMs: number) => number;
  /**
   * Clears the deadline-hit window. Called right after a reconnect is triggered so the
   * post-heal window starts clean and the same wedge can't immediately re-trigger inside the
   * cooldown. Optional (no-op if omitted).
   */
  resetDeadlineHits?: () => void;
  /**
   * Forces a full client reconnect (destroy → connect, rebuilding `_slots`). The teardown must
   * REJECT in-flight commands immediately (client.ts uses the v5 cluster `destroy()`, NOT the
   * draining `close()`) so it can't hang and pin `reconnecting` true forever. Rejecting is fine
   * — the watchdog logs it and re-arms after the cooldown. Must resolve/settle.
   */
  reconnect: () => Promise<void>;
  /** Monotonic-ish clock in ms (injected so tests are deterministic). Defaults to Date.now. */
  now?: () => number;
  /** Structured logger. */
  log: (msg: string, ...rest: unknown[]) => void;
  /**
   * Called once per successful (or attempted) self-heal reconnect with the inflight value at
   * trigger time AND which trigger fired ('deadline' = the sawtooth-immune deadline-hit rate;
   * 'inflight' = the legacy sustained-inflight breach), so client.ts can increment the
   * Prometheus counter (labeled by trigger) + emit a Loki line. Distinguishing the trigger is
   * how the next prod wave is confirmed to have fired the DEADLINE path (the one the inflight
   * path could never reach) rather than a stray inflight breach.
   */
  onReconnect: (inflightAtTrigger: number, trigger: ClusterSelfHealTrigger) => void;
}

/** Which watchdog trigger forced a given reconnect (for the labeled metric + log line). */
export type ClusterSelfHealTrigger = 'deadline' | 'inflight';

export class ClusterSelfHealWatchdog {
  private readonly cfg: ClusterSelfHealConfig;
  private readonly deps: Required<Pick<ClusterSelfHealDeps, 'now'>> & ClusterSelfHealDeps;

  /**
   * Timestamp (ms) at which inflight FIRST crossed above the threshold in the current
   * continuous run, or null when inflight is at/under the threshold. Reset whenever inflight
   * drops back under the threshold — this is what makes the trigger require a SUSTAINED breach.
   */
  private breachStartedAt: number | null = null;
  /** Timestamp of the last reconnect (for the cooldown). null = never reconnected. */
  private lastReconnectAt: number | null = null;
  /** Single-flight guard: true while a reconnect promise is in flight. */
  private reconnecting = false;

  constructor(cfg: ClusterSelfHealConfig, deps: ClusterSelfHealDeps) {
    this.cfg = cfg;
    this.deps = { ...deps, now: deps.now ?? Date.now };
  }

  /** Expose internal state for assertions/observability (read-only snapshot). */
  getState() {
    return {
      breachStartedAt: this.breachStartedAt,
      lastReconnectAt: this.lastReconnectAt,
      reconnecting: this.reconnecting,
    };
  }

  /**
   * One watchdog sample. Returns true iff this tick TRIGGERED a reconnect. Safe to call on a
   * fixed interval. Never throws — a reconnect rejection is caught and logged.
   */
  tick(): boolean {
    if (!this.cfg.enabled) {
      // Kill-switch: also clear any in-progress breach timer so flipping it back on starts clean.
      this.breachStartedAt = null;
      return false;
    }
    if (this.reconnecting) return false; // single-flight

    const now = this.deps.now();
    const inflight = this.deps.getInflight();

    // ── TRIGGER 1: DEADLINE-HIT RATE (sawtooth-immune — the real-wave signal) ──────────
    // A half-open park makes ~every cluster command deadline-reject; the per-command deadline
    // then drains inflight, which is exactly why the inflight-continuity trigger below never
    // fired during real waves. The deadline-TIMEOUT count is immune to that drain. Evaluate it
    // FIRST and independently of the inflight breach timer.
    const deadlineHits =
      this.cfg.deadlineHitThreshold > 0 && this.deps.getDeadlineHits
        ? this.deps.getDeadlineHits(this.cfg.deadlineHitWindowMs)
        : 0;
    const deadlineTriggered =
      this.cfg.deadlineHitThreshold > 0 && deadlineHits >= this.cfg.deadlineHitThreshold;

    // ── TRIGGER 2: SUSTAINED INFLIGHT (legacy continuous-breach path) ──────────────────
    let inflightTriggered = false;
    if (inflight <= this.cfg.inflightThreshold) {
      // Healthy / recovered / transient-spike-ended: reset the sustained timer.
      this.breachStartedAt = null;
    } else if (this.breachStartedAt == null) {
      // Inflight just crossed above the threshold. Start the sustained-breach timer.
      this.breachStartedAt = now;
    } else if (now - this.breachStartedAt >= this.cfg.sustainedMs) {
      inflightTriggered = true;
    }

    if (!deadlineTriggered && !inflightTriggered) return false;

    // Respect the cooldown — at most one reconnect per cooldown window (either trigger).
    if (this.lastReconnectAt != null && now - this.lastReconnectAt < this.cfg.cooldownMs) {
      return false;
    }

    // ── TRIGGER ──────────────────────────────────────────────────────────────────────
    // Mark the reconnect time + clear the breach timer up front so a long-running reconnect
    // can't re-trigger and so the cooldown is measured from the trigger, not completion. Also
    // clear the deadline-hit window so the post-heal window starts clean (the same wedge can't
    // instantly re-count the pre-heal hits).
    this.lastReconnectAt = now;
    this.breachStartedAt = null;
    this.reconnecting = true;
    this.deps.resetDeadlineHits?.();

    this.deps.log(
      deadlineTriggered
        ? `Cluster self-heal: ${deadlineHits} command-deadline timeouts in ${this.cfg.deadlineHitWindowMs}ms (>= ${this.cfg.deadlineHitThreshold}), inflight=${inflight} — forcing reconnect`
        : `Cluster self-heal: inflight pinned at ${inflight} > ${this.cfg.inflightThreshold} for >=${this.cfg.sustainedMs}ms — forcing reconnect`
    );
    // onReconnect is a fire-and-forget observability hook (Prom counter + Loki line). A throw
    // from it must NOT abort the reconnect or wedge the watchdog (it would leave reconnecting
    // pinned true), so it's isolated.
    try {
      // 'deadline' takes precedence: it's the trigger we expect during a real fleet wave and
      // the one we need confirmed at the next wave. (If both conditions are somehow true, the
      // deadline-hit rate is the more specific wedge signal.)
      this.deps.onReconnect(inflight, deadlineTriggered ? 'deadline' : 'inflight');
    } catch (err) {
      this.deps.log(
        `Cluster self-heal: onReconnect hook threw (ignored): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // Fire-and-forget the actual reconnect; the watchdog stays responsive (single-flight
    // guard prevents overlap). Any rejection is logged, not thrown.
    void this.deps
      .reconnect()
      .then(() => {
        this.deps.log('Cluster self-heal: reconnect completed');
      })
      .catch((err: unknown) => {
        this.deps.log(
          `Cluster self-heal: reconnect failed: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        this.reconnecting = false;
      });

    return true;
  }
}
