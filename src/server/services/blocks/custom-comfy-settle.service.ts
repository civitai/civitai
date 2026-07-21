import {
  observeCustomComfyActualBuzz,
  observeCustomComfyWallclockSeconds,
} from '~/server/metrics/app-block-runtime.metrics';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { AppSpendDailyKey } from '~/server/services/blocks/app-spend-cap.service';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks `customComfy` bridge — post-paid SETTLE-TO-ACTUAL (plan §5.3).
//
// A post-paid `$type:'customComfy'` job whatIfs to 0, so the router reserves the
// recipe's declared `maxBuzz` CEILING against the per-user daily cap
// (`reserveBlockBuzzSpend`) and the per-app aggregate cap (`reserveAppSpend`) at
// submit — keeping those caps honest against a spend the orchestrator only
// realizes at runtime. When the job reaches a TERMINAL status (observed by
// `pollWorkflow` / `cancelWorkflow`) we refund the over-reservation
// (`ceiling - actual`) back to EACH reservation counter (per-user daily, per-app
// aggregate, and — when the submit came from an active on-site dev tunnel — the
// per-dev-session cap), so every cap converges on the REAL accrued cost.
//
// This module owns the small durable link between the two: a per-workflow Redis
// record of the exact reservation keys + the ceiling, written at submit and
// consumed EXACTLY ONCE (GET+DEL) at the first terminal observation. The GET+DEL
// is the idempotency guard — a block polls to terminal repeatedly, and cancel +
// a trailing poll can both observe terminal, but only the caller that wins the
// DEL performs the refund.
//
// FAIL-SAFE in both directions:
//   - a lost PERSIST degrades to reserve-without-settle: the caps over-count by
//     `ceiling - actual` for the ~25h TTL (the documented R5 fallback) — STRICTER,
//     never looser.
//   - a lost/failed SETTLE leaves the ceiling reserved (same over-count) — again
//     the safe direction for an abuse cap.
// Neither ever throws into the poll/cancel/ submit response path.
// ─────────────────────────────────────────────────────────────────────────────

// Same 25h window as the reservation counters (BLOCK_BUZZ_CAP_TTL_SECONDS /
// DAILY_CAP_TTL_SECONDS): comfortably covers a UTC-day window plus clock skew, so
// the settle record outlives the reservation it must unwind even across midnight.
const SETTLE_TTL_SECONDS = 25 * 60 * 60;

// The per-user daily buzz-cap key the router reserved against. It is a branded
// `${BUZZ_CAP}:${string}` at the router; persisted/read here as a plain string
// and cast back at DECRBY time (the value round-trips the exact key that was
// reserved, so the cast is sound — same key, same window).
type BuzzCapKey = `${typeof REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${string}`;

function settleKey(workflowId: string): `${typeof REDIS_SYS_KEYS.BLOCKS.CUSTOM_COMFY_SETTLE}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.CUSTOM_COMFY_SETTLE}:${workflowId}`;
}

type SettleRecord = {
  /** The per-user daily buzz-cap Redis key the ceiling was reserved against. */
  buzzCapKey: string;
  /** The per-app aggregate daily key; null for dev tokens (no per-app reserve). */
  appSpendKey: string | null;
  /**
   * The dev-tunnel SESSION id the ceiling was ALSO reserved against, when the
   * submit came from an active on-site dev tunnel (F4). Absent for every non-dev
   * submit — so the dev-session refund leg no-ops (a plain reserve-without-a-third
   * key, byte-identical to the pre-F4 record). Stored as the opaque `bki_<ulid>`
   * session id (not a raw Redis key) so the settle reuses `refundDevSessionBuzz`,
   * which derives the session spend key itself.
   */
  devSessionId?: string | null;
  /** The declared per-job ceiling that was reserved (recipe.maxBuzz). */
  ceiling: number;
  /**
   * The resolved per-engine id (`params.engine ?? recipe default`) and the recipe
   * id, both known at submit. Carried purely for per-engine runtime/cost
   * OBSERVABILITY at settle (`civitai_app_block_customcomfy_actual_buzz` /
   * `_wallclock_seconds`) — they never affect the refund math. Optional so a
   * pre-deploy record (or any future non-engine settle) still settles cleanly;
   * the metric emit self-skips when `engine` is absent.
   */
  engine?: string;
  recipe?: string;
  /**
   * Server wall-clock (ms epoch) captured at submit. Enables the cheap
   * submit→terminal-observation WALL-CLOCK metric (`_wallclock_seconds`) — the
   * truer signal for the step-timeout clip risk (incl. GPU queue-wait). Optional
   * for the same back-compat reason; the wall-clock emit self-skips when absent.
   */
  submittedAt?: number;
};

/**
 * Persist the settle record at submit, AFTER the ceiling has been reserved
 * against the caps (per-user daily + per-app + optional dev-session). Awaited
 * (not fire-and-forget) so the record is durably
 * written before the router hands the workflowId back to the block — otherwise a
 * very fast terminal poll could race the write and miss the settle. Best-effort:
 * a Redis error is swallowed (degrades to reserve-without-settle, the R5
 * fallback), NEVER thrown into the submit response.
 */
export async function persistCustomComfySettle(input: {
  workflowId: string;
  buzzCapKey: string;
  appSpendKey: string | null;
  devSessionId?: string | null;
  ceiling: number;
  /** Resolved engine + recipe id, for per-engine settle-time observability. */
  engine?: string;
  recipe?: string;
  /** Submit ms-epoch, for the wall-clock metric. Defaults to now if omitted. */
  submittedAt?: number;
}): Promise<void> {
  const {
    workflowId,
    buzzCapKey,
    appSpendKey,
    devSessionId = null,
    ceiling,
    engine,
    recipe,
    submittedAt = Date.now(),
  } = input;
  if (!workflowId) return;
  const record: SettleRecord = { buzzCapKey, appSpendKey, ceiling };
  // Include the dev-session id ONLY when present, so a non-dev submit persists the
  // exact record shape it did before F4 (the dev-session refund leg then no-ops).
  if (devSessionId) record.devSessionId = devSessionId;
  // Observability-only fields (never affect the refund). Present for every real
  // customComfy submit going forward; absent-safe at settle.
  if (engine) record.engine = engine;
  if (recipe) record.recipe = recipe;
  if (Number.isFinite(submittedAt)) record.submittedAt = submittedAt;
  try {
    await sysRedis.set(settleKey(workflowId), JSON.stringify(record), {
      EX: SETTLE_TTL_SECONDS,
    });
  } catch {
    /* best-effort — a lost persist over-counts the caps (stricter), never looser */
  }
}

/**
 * Settle a customComfy workflow to its REAL accrued cost on the FIRST terminal
 * observation. Reads + atomically claims the settle record (GET then DEL, gated
 * on DEL===1 so only one caller refunds), then refunds `ceiling - actual` to
 * BOTH the per-user daily cap and the per-app aggregate cap.
 *
 * Idempotent + self-scoping: a record exists ONLY for a customComfy submit and is
 * deleted on the first successful claim, so this can be called unconditionally on
 * ANY block workflow's terminal poll/cancel — a txt2img workflow (no record) or a
 * second terminal observation (already claimed) simply no-ops.
 *
 * `actualCost` is the workflow's realized `cost.total` (accrued Buzz). The refund
 * is clamped to `[0, ceiling]`: an `actual >= ceiling` refunds nothing (the full
 * ceiling stays counted), a missing/zero `actual` refunds the whole ceiling. Both
 * DECRBYs are best-effort; a lost refund over-counts (stricter cap). Never throws.
 */
export async function settleCustomComfySpend(input: {
  workflowId: string;
  actualCost: number;
}): Promise<void> {
  const { workflowId, actualCost } = input;
  if (!workflowId) return;
  const key = settleKey(workflowId);

  let record: SettleRecord;
  try {
    const raw = await sysRedis.get<string>(key);
    if (!raw) return; // not a customComfy workflow, or already settled
    // Atomically claim: DEL returns 1 iff WE removed it. A concurrent terminal
    // observation (cancel + trailing poll) that already claimed it returns 0 →
    // we must NOT double-refund.
    const removed = await sysRedis.del(key);
    if (removed !== 1) return;
    record = JSON.parse(raw) as SettleRecord;
  } catch {
    // A GET/DEL error → leave the record (if any) in place; the ceiling stays
    // reserved (stricter cap). Never throw into poll/cancel.
    return;
  }

  const ceiling = Math.ceil(record.ceiling ?? 0);
  const actual = Math.ceil(Number.isFinite(actualCost) ? Math.max(0, actualCost) : 0);

  // ── Per-engine runtime/cost OBSERVABILITY (instrument-ahead-of-demand) ───────
  // Emitted BEFORE the refund early-return below so a job that spent the FULL
  // ceiling (actual >= ceiling → refund 0 → the ceiling-pressing case we most
  // want to see) is still observed. Only for a record that carries the engine
  // (every real customComfy submit going forward).
  //
  // BELT-AND-SUSPENDERS FAIL-SOFT: the two helpers already each wrap their emit
  // in an internal try/catch, so this is redundant TODAY — but the never-throw
  // guarantee on the MONEY path (the refund + all three DECRBYs below) must NOT
  // depend on that internal catch never regressing. Wrapping the whole emit block
  // here makes the invariant structural at the call site: even if an emit throws
  // (a future helper edit, a synchronous label-validation error, etc.), the
  // `refund <= 0` check + every refund below still execute unchanged.
  try {
    if (record.engine) {
      const recipeLabel = record.recipe ?? 'unknown';
      // GPU-runtime ≈ billed `actual` Buzz. Helper skips a 0/failed/no-op gen.
      observeCustomComfyActualBuzz(record.engine, recipeLabel, actual);
      // Wall-clock incl. queue: submit→THIS terminal observation. Emitted
      // independently of `actual` so a job clipped at its timeout with ~0 accrued
      // Buzz (the purest clip signal) is still captured. Helper skips a non-positive
      // value.
      if (typeof record.submittedAt === 'number') {
        observeCustomComfyWallclockSeconds(
          record.engine,
          recipeLabel,
          (Date.now() - record.submittedAt) / 1000
        );
      }
    }
  } catch {
    /* instrument-only — a metrics emit error can NEVER perturb the refund below */
  }

  const refund = Math.max(0, ceiling - actual);
  if (refund <= 0) return; // nothing to give back (job spent the full ceiling)

  // Per-user daily cap: DECRBY the over-reservation on the EXACT key reserved
  // (mirrors refundBlockBuzzSpend — pin the key so a midnight-UTC settle can't
  // decrement the next day's window).
  if (record.buzzCapKey) {
    await sysRedis.decrBy(record.buzzCapKey as BuzzCapKey, refund).catch(() => {
      /* best-effort — a lost refund over-counts (stricter cap) */
    });
  }

  // Per-app aggregate cap: reuse the service's own pinned-key refund. Absent for
  // dev tokens (no per-app reservation was made).
  if (record.appSpendKey) {
    const { refundAppSpend } = await import('~/server/services/blocks/app-spend-cap.service');
    await refundAppSpend(record.appSpendKey as AppSpendDailyKey, refund);
  }

  // Dev-tunnel SESSION cap (F4): present ONLY when the submit came from an active
  // on-site dev tunnel, which reserved the same CEILING against the per-session
  // cumulative cap. Refund the SAME over-reservation there so the session cap
  // converges on the real accrued cost like the other two. `refundDevSessionBuzz`
  // is itself best-effort (a lost refund over-counts — stricter) and never throws.
  if (record.devSessionId) {
    const { refundDevSessionBuzz } = await import('~/server/services/blocks/dev-tunnel.service');
    await refundDevSessionBuzz(record.devSessionId, refund);
  }
}
