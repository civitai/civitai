import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { isAppBlocksBackpayEnabled } from '~/server/services/app-blocks-flag';
import {
  ACTIVE_RATE_CARD,
  computeSpendShare,
  computeSubscriptionShare,
} from './rate-card';

/**
 * App Blocks BACKPAY reader (W3 attribution back-half — Slice 4 read leg).
 *
 * ## What this is
 *
 * Two attribution tables now write TRACK-ONLY rows (PR #2629 membership,
 * PR #2635 buzz-spend): `block_subscription_attribution` and
 * `block_spend_attribution`. A track-only row records the EVENT + the MONEY
 * BASIS (gross_value_cents [+ provider_fee_cents for subscription]) with
 * `status='tracked'`, `app_owner_share_cents=0`, share-pct 0, and
 * `rate_card_version='unrated'` (the `UNRATED_RATE_CARD_VERSION` sentinel).
 * NO rate is applied at write time — deliberately, so immutable rows are never
 * locked to an unsigned placeholder rate.
 *
 * This module is the BACKPAY: when (and ONLY when) a rate is signed off by
 * monetization leadership, it reads `status='tracked'` rows, computes the
 * author share at the signed-off rate (via the SAME `computeSpendShare` /
 * `computeSubscriptionShare` helpers in rate-card.ts), stamps it, and
 * transitions the row to `confirmed`. A SEPARATE payout rail (PR #2605) later
 * disburses `confirmed` rows.
 *
 * ## What this is NOT
 *
 * This module moves NO money. It does not call `createBuzzTransaction`, touch
 * Tipalti, or credit any account. It ONLY transitions `tracked → confirmed`
 * (or `tracked → held` for the Sybil cap) and stamps the computed share onto
 * the row. The returned summary is purely informational.
 *
 * ## DOUBLE-DARK GATE (fail-closed — the load-bearing safety property)
 *
 * The reader REFUSES to write unless BOTH of these hold; otherwise it returns
 * a summary with `{ skipped: <reason> }` and writes nothing:
 *
 *   1. `isAppBlocksBackpayEnabled()` — a dedicated GLOBAL fail-closed Flipt
 *      flag (`app-blocks-backpay-enabled`). The flag does NOT exist in Flipt
 *      yet, so as-merged `isFlipt` returns false → the reader is DARK.
 *
 *   2. `SIGNED_OFF_RATE_CARD_VERSION` is non-null AND === ACTIVE_RATE_CARD.version.
 *      It is `null` TODAY (leadership has not signed off). This guarantees the
 *      backpay can NEVER apply a placeholder/unsigned rate: even with the flag
 *      on, a null or mismatched signed-off version → refuse.
 *
 * Flipping `SIGNED_OFF_RATE_CARD_VERSION` to a real version is a MONETIZATION-
 * LEADERSHIP action, not an engineering one. Do not change it without an
 * explicit, recorded sign-off on the rate-card percentages.
 */

const BACKPAY_LOG_NAME = 'block-attribution-backpay';

/**
 * The rate-card version that monetization leadership has SIGNED OFF for backpay.
 *
 * ⚠️⚠️⚠️ NULL TODAY — leadership has NOT signed off on any rate. ⚠️⚠️⚠️
 *
 * Flipping this to a real version string (e.g. 'v6') is a MONETIZATION-
 * LEADERSHIP decision, NOT an engineering change. It authorizes the backpay to
 * stamp every tracked row's author share at THAT card's percentages and confirm
 * it for eventual disbursement. Do NOT change this without a recorded sign-off
 * on the rate-card values, AND only to a version that equals
 * `ACTIVE_RATE_CARD.version` (the gate refuses a mismatch — see the double-dark
 * gate above). The backpay reads this via {@link getSignedOffRateCardVersion}
 * so the gate is testable without weakening this production default.
 */
export const SIGNED_OFF_RATE_CARD_VERSION: string | null = null;

/**
 * Internal getter for the signed-off version. Exists ONLY so tests can force
 * the gate open WITHOUT weakening the production default of `null`.
 *
 * Production always resolves the version through `internal.getSignedOffRateCardVersion`
 * (the indirection object below) — tests override `internal.getSignedOffRateCardVersion`
 * to force the gate open. The production default returned here stays `null`.
 */
export function getSignedOffRateCardVersion(): string | null {
  return SIGNED_OFF_RATE_CARD_VERSION;
}

/**
 * Indirection object the service reads through, so a test can override the
 * signed-off-version resolver WITHOUT mutating the `SIGNED_OFF_RATE_CARD_VERSION`
 * const (whose production default must stay `null`). In ESM a same-module call
 * to a top-level export can't be spied, so the service calls
 * `internal.getSignedOffRateCardVersion()` rather than the bare function.
 */
export const internal = { getSignedOffRateCardVersion };

/**
 * Per-app Sybil accrual cap (gate c).
 *
 * ⚠️ PLACEHOLDER VALUE — the real number is a PRODUCT DECISION, not an
 * engineering one. 100_00 = $100.00 of confirmed author share per app per run
 * is an explicit, conservative starting point.
 *
 * The cap is per `app_block_id` (NOT per `app_owner_user_id`): "per app" is the
 * block being credited, and the threat model is a Sybil viewer ring driving
 * unbounded events toward ONE app/block. Capping by owner would lump an
 * author's many distinct apps into one bucket — too coarse, and it would let a
 * single abusive app drain the budget of the author's other (legitimate) apps.
 * Capping by block matches "protect each app's accrual independently."
 *
 * When an app's CUMULATIVE confirmed share within a single run would exceed
 * this cap, its further rows are routed to `status='held'` (reviewable /
 * releasable — NOT confirmed, NOT voided) with `voided_reason='manual_review'`,
 * and the app is logged + reported in `cappedApps`. Held rows can be released
 * by a later manual review; the cap is forward-only and reversible.
 */
export const MAX_BACKPAY_CENTS_PER_APP_PER_RUN = 100_00;

export type BackpaySummary = {
  /** True when both gate halves passed (flag on AND signed-off version valid). */
  enabled: boolean;
  /** True when the run computed but wrote nothing. */
  dryRun: boolean;
  /** The version the gate resolved (null when not signed off). */
  signedOffVersion: string | null;
  /** Rows examined (status='tracked', entry_type='charge') per table. */
  processed: { subscription: number; spend: number };
  /** Rows transitioned tracked → confirmed (0 in dryRun; "would confirm" count). */
  confirmedCount: number;
  /** Sum of confirmed author share, in cents (the "would confirm" total in dryRun). */
  confirmedShareCents: number;
  /** Rows routed to 'held' by the Sybil cap (0 in dryRun; "would hold" count). */
  heldCount: number;
  /** app_block_ids that hit the cap this run, with the share that breached it. */
  cappedApps: Array<{ appBlockId: string; confirmedShareCents: number; heldCount: number }>;
  /** Present (and the ONLY meaningful field besides enabled/signedOffVersion) when the gate refused. */
  skipped?: string;
};

type BackpayOpts = { dryRun?: boolean; limit?: number };

const DEFAULT_LIMIT = 1000;

/**
 * Read `status='tracked'` attribution rows in both tables, compute the author
 * share at the SIGNED-OFF rate, and transition them `tracked → confirmed`
 * (or `tracked → held` when an app exceeds the per-run Sybil cap). Moves no
 * money. Idempotent — only ever acts on `status='tracked'`, and the update is
 * gated `WHERE status='tracked'` so a row can never be double-confirmed.
 *
 * @param opts.dryRun  Compute the full summary but write nothing. The eventual
 *   job caller defaults to dryRun.
 * @param opts.limit   Max rows to process PER TABLE per run, for safe
 *   incremental rollout. Defaults to {@link DEFAULT_LIMIT}.
 */
export async function backpayTrackedAttributions(
  opts: BackpayOpts = {}
): Promise<BackpaySummary> {
  const dryRun = opts.dryRun ?? false;
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));

  const signedOffVersion = internal.getSignedOffRateCardVersion();

  const empty: Omit<BackpaySummary, 'skipped' | 'enabled'> = {
    dryRun,
    signedOffVersion,
    processed: { subscription: 0, spend: 0 },
    confirmedCount: 0,
    confirmedShareCents: 0,
    heldCount: 0,
    cappedApps: [],
  };

  const refuse = (skipped: string): BackpaySummary => {
    const summary: BackpaySummary = { ...empty, enabled: false, skipped };
    logToAxiom(
      {
        name: BACKPAY_LOG_NAME,
        type: 'warning',
        message: `backpay refused: ${skipped}`,
        skipped,
        dryRun,
        signedOffVersion,
      },
      'webhooks'
    ).catch(() => null);
    return summary;
  };

  // ── DOUBLE-DARK GATE half 1: global fail-closed Flipt flag ──────────────
  const flagOn = await isAppBlocksBackpayEnabled();
  if (!flagOn) return refuse('flag-disabled');

  // ── DOUBLE-DARK GATE half 2: a signed-off rate-card version that matches
  // the active card. null (today) OR a mismatch → refuse, so the backpay can
  // never apply a placeholder/unsigned rate even with the flag on. ──────────
  if (signedOffVersion == null) return refuse('no-signed-off-rate');
  if (signedOffVersion !== ACTIVE_RATE_CARD.version) {
    return refuse('signed-off-version-mismatch');
  }

  // Gate passed. From here we either WRITE (tracked → confirmed/held) or, in
  // dryRun, compute the identical summary without persisting.
  const internalOwnerIds = new Set(ACTIVE_RATE_CARD.internalAppOwnerUserIds);

  // Per-app (app_block_id) accrual within this run, for the Sybil cap.
  const accrualByApp = new Map<string, number>();
  const cappedByApp = new Map<string, { confirmedShareCents: number; heldCount: number }>();

  let confirmedCount = 0;
  let confirmedShareCents = 0;
  let heldCount = 0;

  // ── Subscription (block_subscription_attribution) ────────────────────────
  const subRows = await dbRead.blockSubscriptionAttribution.findMany({
    where: { status: 'tracked', entryType: 'charge' },
    select: {
      id: true,
      grossValueCents: true,
      providerFeeCents: true,
      appBlockId: true,
      appOwnerUserId: true,
    },
    orderBy: { attributedAt: 'asc' },
    take: limit,
  });

  for (const row of subRows) {
    // Belt-and-braces: internal-owner rows are written 'voided' at record time
    // (never 'tracked'), so they won't appear here — but skip defensively so a
    // future write-path change can't leak an internal payout through backpay.
    if (internalOwnerIds.has(row.appOwnerUserId)) continue;

    const share = computeSubscriptionShare({
      rateCard: ACTIVE_RATE_CARD,
      grossCents: row.grossValueCents,
      providerFeeCents: row.providerFeeCents,
      isSelfPurchase: false,
      appOwnerUserId: row.appOwnerUserId,
    });

    // Conservation invariant: fee + platform + author = gross. By construction
    // safeFee + (net - author) + author = safeGross; assert before persisting.
    const platformShareCents =
      row.grossValueCents - share.providerFeeCents - share.appOwnerShareCents;
    const conserved =
      share.providerFeeCents + platformShareCents + share.appOwnerShareCents ===
      row.grossValueCents;
    if (!conserved) {
      // A conservation break is a compute bug; never persist it. Log + skip.
      logToAxiom(
        {
          name: BACKPAY_LOG_NAME,
          type: 'error',
          message: `subscription conservation invariant broken; skipping ${row.id}`,
          attributionId: row.id,
          grossValueCents: row.grossValueCents,
          providerFeeCents: share.providerFeeCents,
          platformShareCents,
          appOwnerShareCents: share.appOwnerShareCents,
        },
        'webhooks'
      ).catch(() => null);
      continue;
    }

    const decision = applyCap(
      accrualByApp,
      cappedByApp,
      row.appBlockId,
      share.appOwnerShareCents
    );

    if (decision === 'held') {
      heldCount += 1;
      if (!dryRun) {
        await dbWrite.blockSubscriptionAttribution.updateMany({
          where: { id: row.id, status: 'tracked' },
          data: { status: 'held', voidedReason: 'manual_review' },
        });
      }
      continue;
    }

    confirmedCount += 1;
    confirmedShareCents += share.appOwnerShareCents;
    if (!dryRun) {
      await dbWrite.blockSubscriptionAttribution.updateMany({
        // WHERE status='tracked' makes the confirm idempotent — a concurrent
        // run or a re-run can never double-confirm an already-confirmed row.
        where: { id: row.id, status: 'tracked' },
        data: {
          status: 'confirmed',
          confirmedAt: new Date(),
          rateCardVersion: signedOffVersion,
          subscriptionSharePct: share.subscriptionSharePct,
          appOwnerShareCents: share.appOwnerShareCents,
          platformShareCents,
          providerFeeCents: share.providerFeeCents,
        },
      });
    }
  }

  // ── Spend (block_spend_attribution) ──────────────────────────────────────
  const spendRows = await dbRead.blockSpendAttribution.findMany({
    where: { status: 'tracked' },
    select: {
      id: true,
      grossValueCents: true,
      appBlockId: true,
      appOwnerUserId: true,
    },
    orderBy: { attributedAt: 'asc' },
    take: limit,
  });

  for (const row of spendRows) {
    // tracked spend rows are never self/internal (those are written 'voided');
    // skip internal owners defensively all the same.
    if (internalOwnerIds.has(row.appOwnerUserId)) continue;

    const share = computeSpendShare({
      rateCard: ACTIVE_RATE_CARD,
      grossValueCents: row.grossValueCents,
      isSelfSpend: false,
      appOwnerUserId: row.appOwnerUserId,
    });

    // Invariant: the platform-funded bounty can never exceed the gross it
    // rewards. computeSpendShare already clamps to gross; assert before write.
    if (share.appOwnerShareCents > row.grossValueCents) {
      logToAxiom(
        {
          name: BACKPAY_LOG_NAME,
          type: 'error',
          message: `spend share exceeds gross; skipping ${row.id}`,
          attributionId: row.id,
          grossValueCents: row.grossValueCents,
          appOwnerShareCents: share.appOwnerShareCents,
        },
        'webhooks'
      ).catch(() => null);
      continue;
    }

    const decision = applyCap(
      accrualByApp,
      cappedByApp,
      row.appBlockId,
      share.appOwnerShareCents
    );

    if (decision === 'held') {
      heldCount += 1;
      if (!dryRun) {
        await dbWrite.blockSpendAttribution.updateMany({
          where: { id: row.id, status: 'tracked' },
          data: { status: 'held', voidedReason: 'manual_review' },
        });
      }
      continue;
    }

    confirmedCount += 1;
    confirmedShareCents += share.appOwnerShareCents;
    if (!dryRun) {
      await dbWrite.blockSpendAttribution.updateMany({
        where: { id: row.id, status: 'tracked' },
        data: {
          status: 'confirmed',
          confirmedAt: new Date(),
          rateCardVersion: signedOffVersion,
          spendSharePct: share.spendSharePct,
          appOwnerShareCents: share.appOwnerShareCents,
        },
      });
    }
  }

  const cappedApps = Array.from(cappedByApp.entries()).map(([appBlockId, v]) => ({
    appBlockId,
    confirmedShareCents: v.confirmedShareCents,
    heldCount: v.heldCount,
  }));

  const summary: BackpaySummary = {
    enabled: true,
    dryRun,
    signedOffVersion,
    processed: { subscription: subRows.length, spend: spendRows.length },
    confirmedCount,
    confirmedShareCents,
    heldCount,
    cappedApps,
  };

  for (const capped of cappedApps) {
    logToAxiom(
      {
        name: BACKPAY_LOG_NAME,
        type: 'warning',
        message: `backpay Sybil cap hit for app ${capped.appBlockId}`,
        appBlockId: capped.appBlockId,
        confirmedShareCents: capped.confirmedShareCents,
        heldCount: capped.heldCount,
        capCents: MAX_BACKPAY_CENTS_PER_APP_PER_RUN,
        dryRun,
      },
      'webhooks'
    ).catch(() => null);
  }

  logToAxiom(
    {
      name: BACKPAY_LOG_NAME,
      type: 'info',
      message: dryRun ? 'backpay dry-run complete' : 'backpay run complete',
      dryRun,
      signedOffVersion,
      processedSubscription: summary.processed.subscription,
      processedSpend: summary.processed.spend,
      confirmedCount,
      confirmedShareCents,
      heldCount,
      cappedAppCount: cappedApps.length,
    },
    'webhooks'
  ).catch(() => null);

  return summary;
}

/**
 * Fold a row's computed share into the per-app accrual and decide whether it
 * is confirmable or must be held. Routes a row to 'held' the moment confirming
 * it would push the app's CUMULATIVE confirmed share over the per-run cap (so
 * the FIRST breaching row and all subsequent rows for that app are held).
 * Returns 'confirm' or 'held'; mutates `accrualByApp` only for confirmed rows
 * and records held rows in `cappedByApp`.
 */
function applyCap(
  accrualByApp: Map<string, number>,
  cappedByApp: Map<string, { confirmedShareCents: number; heldCount: number }>,
  appBlockId: string,
  shareCents: number
): 'confirm' | 'held' {
  const current = accrualByApp.get(appBlockId) ?? 0;
  if (current + shareCents > MAX_BACKPAY_CENTS_PER_APP_PER_RUN) {
    const prev = cappedByApp.get(appBlockId) ?? {
      confirmedShareCents: current,
      heldCount: 0,
    };
    cappedByApp.set(appBlockId, {
      confirmedShareCents: current,
      heldCount: prev.heldCount + 1,
    });
    return 'held';
  }
  accrualByApp.set(appBlockId, current + shareCents);
  return 'confirm';
}
