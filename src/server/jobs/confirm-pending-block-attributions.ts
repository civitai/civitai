import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REFUND_WINDOWS_DAYS } from '~/server/services/blocks/buzz-attribution.service';
import { createJob } from './job';

/**
 * Conservative manual-review trigger: park (don't auto-confirm) an owner
 * whose aging-pending batch in a single sweep exceeds this row count.
 *
 * This is NOT a fraud detector — it's a volume circuit-breaker so a
 * sudden burst of attributions on one publisher gets a human eye before
 * the money ripens. Tunable; raise/lower as real traffic shapes show up.
 */
export const HOLD_VELOCITY_COUNT = 200;

/**
 * Conservative manual-review trigger: park an owner whose aging-pending
 * publisher share in a single sweep exceeds this many cents ($1,000).
 *
 * Same intent as HOLD_VELOCITY_COUNT — a dollar-value circuit-breaker,
 * not a fraud signal. Tunable.
 */
export const HOLD_VELOCITY_CENTS = 100_000;

/**
 * Promote pending block_buzz_attribution rows to confirmed once they're
 * past the provider's refund window — UNLESS the owner's aging batch
 * trips a velocity/volume hold, in which case the rows are parked in
 * status='held' for manual review instead.
 *
 * confirmed rows are eligible for the bulk payout job; until they're
 * confirmed, no payout can fire. held rows are the actionable ops signal:
 * a human reviews them and either confirms (re-run picks them up once
 * unparked back to pending, or a manual UPDATE confirms them) or voids.
 *
 * Runs daily at 03:15 UTC — well clear of the buzz/referral midnight
 * batch jobs. Each provider has its own refund window.
 *
 * Idempotent: only ever touches status='pending'. Re-running never
 * re-touches rows already confirmed/held/voided/paid_out — the per-owner
 * grouping and both updateMany statements all filter status='pending'.
 */
export const confirmPendingBlockAttributions = createJob(
  'confirm-pending-block-attributions',
  '15 3 * * *',
  async () => {
    let totalConfirmed = 0;
    let totalHeld = 0;

    for (const provider of Object.keys(REFUND_WINDOWS_DAYS) as Array<
      keyof typeof REFUND_WINDOWS_DAYS
    >) {
      const days = REFUND_WINDOWS_DAYS[provider];
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const candidateWhere = {
        status: 'pending' as const,
        paymentProvider: provider,
        attributedAt: { lt: cutoff },
      };

      // Group the aging-pending candidates per owner so we can decide
      // per owner whether to confirm or hold. One small grouped read,
      // then at most two updateMany writes (held owners, everyone else).
      type OwnerGroup = {
        appOwnerUserId: number;
        _count: number;
        _sum: { appOwnerShareCents: number | null };
      };
      const groups = (await dbWrite.blockBuzzAttribution.groupBy({
        by: ['appOwnerUserId'],
        where: candidateWhere,
        _count: true,
        _sum: { appOwnerShareCents: true },
      })) as unknown as OwnerGroup[];

      const heldOwnerIds = groups
        .filter(
          (g) =>
            g._count > HOLD_VELOCITY_COUNT ||
            (g._sum.appOwnerShareCents ?? 0) > HOLD_VELOCITY_CENTS
        )
        .map((g) => g.appOwnerUserId);

      let confirmedCount = 0;
      let heldCount = 0;
      const now = new Date();

      if (heldOwnerIds.length > 0) {
        const heldResult = await dbWrite.blockBuzzAttribution.updateMany({
          where: { ...candidateWhere, appOwnerUserId: { in: heldOwnerIds } },
          data: {
            status: 'held',
            holdReason: 'velocity',
            heldAt: now,
          },
        });
        heldCount = heldResult.count;
      }

      // Everyone not held → confirm. The notIn keeps this idempotent and
      // disjoint from the held write; when no owner is held this is a
      // plain promote-all (same behavior as before this gate existed).
      const confirmResult = await dbWrite.blockBuzzAttribution.updateMany({
        where:
          heldOwnerIds.length > 0
            ? { ...candidateWhere, appOwnerUserId: { notIn: heldOwnerIds } }
            : candidateWhere,
        data: {
          status: 'confirmed',
          confirmedAt: now,
        },
      });
      confirmedCount = confirmResult.count;

      totalConfirmed += confirmedCount;
      totalHeld += heldCount;

      if (confirmedCount > 0 || heldCount > 0) {
        logToAxiom(
          {
            name: 'block-buzz-attribution',
            type: heldCount > 0 ? 'warning' : 'info',
            stage: 'confirm-pending',
            provider,
            windowDays: days,
            confirmedCount,
            heldCount,
            heldOwnerCount: heldOwnerIds.length,
            message:
              `confirmed ${confirmedCount} / held ${heldCount} pending ${provider} ` +
              `attribution(s)` +
              (heldCount > 0
                ? ` — ${heldOwnerIds.length} owner(s) parked for manual review (velocity)`
                : ''),
          },
          'webhooks'
        ).catch(() => null);
      }
    }

    return { totalConfirmed, totalHeld };
  }
);
