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
 * SIGNATURE of a wedged pod: `redis_commands_inflight{client="cluster"}` jumps PAST the
 * threshold and stays PINNED (hundreds–thousands of leaked inflight); a healthy pod sits
 * near 0 and a busy pod only SPIKES transiently. This watchdog samples the same in-process
 * inflight counter that feeds the gauge and forces ONE reconnect when it stays above the
 * threshold CONTINUOUSLY for the sustained window, then waits out a cooldown.
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
}

export interface ClusterSelfHealDeps {
  /** Reads the current in-process cluster inflight count (same source as the gauge). */
  getInflight: () => number;
  /**
   * Forces a full client reconnect (disconnect → connect, rebuilding `_slots`). Rejecting
   * is fine — the watchdog logs it and re-arms after the cooldown. Must resolve/settle.
   */
  reconnect: () => Promise<void>;
  /** Monotonic-ish clock in ms (injected so tests are deterministic). Defaults to Date.now. */
  now?: () => number;
  /** Structured logger. */
  log: (msg: string, ...rest: unknown[]) => void;
  /**
   * Called once per successful (or attempted) self-heal reconnect with the inflight value at
   * trigger time, so client.ts can increment the Prometheus counter + emit a Loki line.
   */
  onReconnect: (inflightAtTrigger: number) => void;
}

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

    if (inflight <= this.cfg.inflightThreshold) {
      // Healthy / recovered / transient-spike-ended: reset the sustained timer.
      this.breachStartedAt = null;
      return false;
    }

    // Inflight is above the threshold. Start (or continue) the sustained-breach timer.
    if (this.breachStartedAt == null) {
      this.breachStartedAt = now;
      return false;
    }

    // Require the breach to have lasted at least sustainedMs.
    if (now - this.breachStartedAt < this.cfg.sustainedMs) return false;

    // Respect the cooldown — at most one reconnect per cooldown window.
    if (this.lastReconnectAt != null && now - this.lastReconnectAt < this.cfg.cooldownMs) {
      return false;
    }

    // ── TRIGGER ──────────────────────────────────────────────────────────────────────
    // Mark the reconnect time + clear the breach timer up front so a long-running reconnect
    // can't re-trigger and so the cooldown is measured from the trigger, not completion.
    this.lastReconnectAt = now;
    this.breachStartedAt = null;
    this.reconnecting = true;

    this.deps.log(
      `Cluster self-heal: inflight pinned at ${inflight} > ${this.cfg.inflightThreshold} for >=${this.cfg.sustainedMs}ms — forcing reconnect`
    );
    // onReconnect is a fire-and-forget observability hook (Prom counter + Loki line). A throw
    // from it must NOT abort the reconnect or wedge the watchdog (it would leave reconnecting
    // pinned true), so it's isolated.
    try {
      this.deps.onReconnect(inflight);
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
