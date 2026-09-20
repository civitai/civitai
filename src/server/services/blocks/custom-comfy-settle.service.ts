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
// `pollWorkflow` / `cancelWorkflow` — NOT by `cancelAppWorkflow`, which is a
// third terminal observer that does not settle; see the accepted-limitation
// block on `settleCustomComfySpend` below) we refund the over-reservation
// (`ceiling - actual`) back to EACH reservation counter (per-user daily, per-app
// aggregate, the viewer's per-(user, app) CONSENT BUDGET when they set one, and —
// when the submit came from an active on-site dev tunnel — the per-dev-session
// cap), so every cap converges on the REAL accrued cost.
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

/** Same round-trip-and-cast reasoning as BuzzCapKey, for the consent-budget key. */
type ConsentBudgetKey = `${typeof REDIS_SYS_KEYS.BLOCKS.CONSENT_BUDGET}:${string}`;

function settleKey(
  workflowId: string
): `${typeof REDIS_SYS_KEYS.BLOCKS.CUSTOM_COMFY_SETTLE}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.CUSTOM_COMFY_SETTLE}:${workflowId}`;
}

type SettleRecord = {
  /** The per-user daily buzz-cap Redis key the ceiling was reserved against. */
  buzzCapKey: string;
  /** The per-app aggregate daily key; null for dev tokens (no per-app reserve). */
  appSpendKey: string | null;
  /**
   * The per-(user, app, UTC-day) CONSENT BUDGET key the ceiling was ALSO reserved
   * against, when the viewer set a budget for this app. Absent for every submit
   * where they did not (and for dev / run-for-real tokens, which take no consent
   * reservation at all) — so that leg simply no-ops and the record is the exact
   * shape it was before this field existed, which is what makes an in-flight
   * pre-deploy record settle cleanly.
   *
   * 🔴 IT MUST BE SETTLED LIKE THE OTHERS. A post-paid job reserves the CEILING;
   * without this leg the consent budget alone would stay charged at the ceiling
   * while every other counter converged on the real accrued cost, so a user's own
   * limit would exhaust far faster than their actual spend — visible to them, and
   * wrong in the direction they would report as a bug.
   */
  consentBudgetKey?: string | null;
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
  /** The consent-budget key, when the viewer set a per-app budget. */
  consentBudgetKey?: string | null;
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
    consentBudgetKey = null,
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
  // Same rule for the consent-budget key: omitted when the viewer set no budget,
  // so that record is byte-identical to a pre-consent-budget one.
  if (consentBudgetKey) record.consentBudgetKey = consentBudgetKey;
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ACCEPTED LIMITATION — A RESERVATION CAN STAY UNSETTLED FOR THE FULL 25h TTL
// WHEN THE APP IS REVOKED MID-GENERATION (clawgate #572, option 1 of three).
//
// THE SHAPE. `settleCustomComfySpend` runs only on a TERMINAL OBSERVATION, and
// its only two production CALLERS are `pollWorkflow` and `cancelWorkflow` in
// `src/server/routers/blocks.router.ts` — both of them behind
// `authorizeBlockBridgeToken`, which #4806 put deliberately ahead of them. So if
// a moderator suspends the app, the publisher is banned, or the viewer
// uninstalls while a post-paid job is still running, every later poll/cancel
// 403s in the guard and this function is never reached, and the reservation
// stays at the recipe's declared `maxBuzz` CEILING for the rest of the window.
//
// 🔴 CALLERS AND OBSERVERS ARE DIFFERENT SETS, AND THE SECOND ONE IS WIDER.
// `cancelAppWorkflow` (`blocks.router.ts`) is a THIRD terminal observer — the
// router's own comment calls it that — and it does NOT settle: it issues a real
// orchestrator cancel, re-reads to terminal, reverses the author fee, and
// returns the projection. A customComfy workflow is fully eligible for it (its
// ownership guard is the same `block_workflows` row the submit writes), and the
// block has no reason to poll afterwards, so that path strands a reservation
// with no revocation and no closed tab involved. It is named here because the
// ledger test below pins CALLERS, which would otherwise make this gap read as
// correct-by-construction to the next reader. Like the closed-tab case, it is
// knowingly unaddressed by option 1.
//
// WHAT THAT COSTS A USER, stated plainly rather than as "the safe direction".
// The record settles four counters, and the two that a user feels are:
//   - the PER-USER DAILY block-Buzz cap, which is deliberately NOT app-scoped
//     (`buzzCapRedisKey` is `userId:<day>` — "all of a user's installed blocks
//     share ONE daily ceiling"). A strand therefore pins headroom in their
//     GLOBAL day cap and degrades every OTHER app they run for the rest of the
//     window. This is the bigger leg.
//   - the viewer's CONSENT BUDGET for that app, which reads as spent up to the
//     ceiling instead of to what the job accrued — observable to them only if
//     they regain access to the same app inside the window (reinstall, or the
//     suspension lifted), and then only in the next submit's rejection copy.
// One suspension does this to EVERY in-flight user at once, since the in-flight
// population at that instant is arbitrary and may be large.
//
// 🔴 AND A THIRD COUNTER THAT CROSSES USERS: `appSpendKey` is
// `appSpendDailyKey(appBlockId)` — per-APP, no user in the key. A strand
// therefore eats the app's SHARED daily ceiling for every other user of it.
// That is moot for a suspension (the app is down anyway) but NOT for the
// `cancelAppWorkflow` population above, where the app stays live: one user's
// unsettled ceiling degrades everyone else's submits on that app until the
// window rolls.
//
// 🔴 AND THE WINDOW IS THE RESERVATION COUNTER'S TTL, NOT THIS RECORD'S. Both
// are 25h, but they are armed at different instants: `reserveCumulativeBuzzKey`
// arms the counter's TTL on the first write of the UTC-day window, typically
// hours before the stranded submit, while the settle record's
// `SETTLE_TTL_SECONDS` is armed at submit. So "up to 25h" is a correct UPPER
// BOUND and usually an overestimate — do not read it as the expected duration.
//
// THIS IS ACCEPTED, NOT OVERLOOKED. Four measurements, 2026-09-20:
//   1. The caller set is exactly those two, re-verified at HEAD BY SYMBOL — the
//      ticket's own line numbers were already stale, so do not re-derive this by
//      line. It is pinned by
//      `src/server/services/__tests__/no-unledgered-settle-caller.test.ts`,
//      which fails when the set GROWS or SHRINKS. The whole decision rests on
//      that set, so a third caller has to be loud rather than silent.
//   2. The guard genuinely does precede both settles — ONE
//      `authorizeBlockBridgeToken` call immediately ahead of each, inside the
//      same procedure. (The router has 14 such calls in total; only these two
//      are on the settle path, and the ledger test asserts the per-procedure
//      ordering rather than the count.) The defect is real and stands; this is a
//      decision about it, not a refutation of it.
//   3. Severity is bounded IN CODE rather than assumed: the module header above
//      documents an unsettled record as over-counting the caps by
//      `ceiling - actual` — STRICTER, never looser. These are abuse/consent CAPS,
//      not wallet debits, so nothing is wrongly charged to real Buzz and no
//      refund is owed. That is the assumption the whole decision rests on, and
//      it is the one that would change the severity if it stopped holding.
//
//      🔴 IT IS CONTINGENT ON ONE BOOLEAN, NOT STRUCTURAL. The real-money
//      neighbour is the author fee, and it is not charged on any path that
//      writes a settle record TODAY only because the single production step
//      entry hardcodes `postPaidSettle: false`
//      (`src/server/services/blocks/steps/index.ts`). `submitStepWorkflow` in
//      `blocks.router.ts` already contains BOTH the `plan.postPaidSettle`-gated
//      `persistCustomComfySettle` AND an unconditional `chargeBlockAuthorFee`,
//      and the comment beside the gate anticipates the flip in as many words
//      ("a future `timeBounded` entry sets it true and reuses the same
//      machinery customComfy does"). On that flip a settle-record-producing
//      submit also carries a real `TransactionType.Fee` debit whose reversal
//      runs only in these same guarded observers — so a strand would hold REAL
//      MONEY rather than abuse counters, and this decision would have to be
//      re-taken. See WHAT WOULD CHANGE THIS.
//   4. Volume is what ruled out the background reconciler: 585
//      `ai:write:budgeted` / `workflow:submit` invocations in
//      `block_scope_invocations` between 2026-08-05 and 2026-09-18 — 13.3/day
//      AVERAGED over those 44 days. Read it as an UPPER BOUND on the affected
//      population, because it counts every budgeted submit and not only the
//      post-paid customComfy ones that write a settle record. ⚠️ It is a MEAN,
//      so it is NOT an upper bound on the PEAK — a peak day is higher by an
//      amount nobody derived, and the mean is the weaker figure in the
//      direction of the re-open trigger below. Net-new scheduled infrastructure
//      is still disproportionate to a rate of this order.
//
// 🔴 AND THE LIMIT OF THAT EVIDENCE, because the obvious health check here
// returns a zero that means nothing. A scan of prod sysRedis for outstanding
// `system:blocks:custom-comfy-settle:*` records returned ZERO, with the probe
// validated (a `system:*` control returned 12 keys, so it was not wired to
// nothing). That zero is NOT evidence that reservations settle correctly: the
// last budgeted submit was ~36h before the scan and the TTL is 25h, so any
// record it created had already aged out. The window was empty BY CONSTRUCTION,
// and the observation is equally consistent with "all settled" and with
// "orphaned, then expired". Do not cite it as a health signal.
//
// 🔴 THE CLOSED-TAB CASE IS KNOWINGLY UNADDRESSED. Poll/cancel being the only
// settle path means a reservation ALSO fails to settle when a user simply closes
// the tab mid-generation — no revocation involved anywhere. Revocation made that
// shape visible; it did not create it, and this decision does nothing for it.
// There is no server-side completion callback to fall back on: the orchestrator's
// `workflow-completed` handler updates the read-model only, and the router
// records that it is not wired to fire. Together with `cancelAppWorkflow` above,
// this is the larger population, and it stays open.
//
// WHAT WOULD CHANGE THIS. Either of these reopens it as a real fix — a
// settle-only carve-out through the guard, or an out-of-band reconciler, which
// is the only option that would also cover the closed tab and
// `cancelAppWorkflow`:
//   - 🔴 `postPaidSettle` FLIPPING TRUE for any step entry. This is the nearest
//     and already-scaffolded trigger, not a hypothetical: per (3) it is the one
//     boolean standing between "abuse counters" and "a stranded real-Buzz fee
//     debit", and the machinery on the other side of it is already written. Do
//     not flip it without re-taking this decision.
//   - a materially higher budgeted-submit rate, so a window of pinned daily cap
//     stops being rare. Re-run the `block_scope_invocations` count in (4),
//     narrowed to the post-paid customComfy population rather than the same
//     over-broad one, and read the PEAK day rather than the mean.
//   - the caps becoming WALLET-BACKED rather than abuse counters by any other
//     route, which turns "stricter, never looser" from a safe direction into
//     real money held.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settle a customComfy workflow to its REAL accrued cost on the FIRST terminal
 * observation. Reads + atomically claims the settle record (GET then DEL, gated
 * on DEL===1 so only one caller refunds), then refunds `ceiling - actual` to
 * EVERY counter the record names — the per-user daily cap, the per-app aggregate
 * cap, the viewer's consent budget, and the dev-session cap.
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

  // Cumulative buzz cap: DECRBY the over-reservation on the EXACT key reserved.
  // `buzzCapKey` is whichever cumulative key the submit reserved against — the
  // per-user daily cap for a normal token, OR the per-(mod, publishRequestId)
  // run-for-real session key for a review run-for-real submit (#2831). Pinning the
  // stored key (not re-deriving) settles the right window either way and avoids a
  // midnight-UTC / re-derivation race (mirrors refundBlockBuzzSpend).
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

  // CONSENT BUDGET: present ONLY when the viewer set a per-app daily budget, which
  // the submit reserved the same CEILING against. Refund the SAME over-reservation
  // so the user's own limit converges on their real accrued spend like every other
  // counter. Best-effort (a lost refund over-counts — stricter) and never throws.
  if (record.consentBudgetKey) {
    await sysRedis.decrBy(record.consentBudgetKey as ConsentBudgetKey, refund).catch(() => {
      /* best-effort — a lost refund over-counts (stricter cap) */
    });
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
