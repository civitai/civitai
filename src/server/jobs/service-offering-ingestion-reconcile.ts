import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import {
  blockServiceOffering,
  scanServiceOffering,
  settleServiceOfferingScan,
} from '~/server/services/service-offering-moderation.adapter';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  EntityModerationStatus,
  ServiceOfferingIngestionStatus,
  ServiceOfferingStatus,
} from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';

// Gives the callback time to land before the job steps in.
const STUCK_THRESHOLD_MINUTES = 10;
// Matches the retry cron's pending timeout, so the two agree on when a submit was lost.
const PENDING_MODERATION_TIMEOUT_MINUTES = 30;
const FETCH_LIMIT = 200;
const CONCURRENCY = 5;

export type ReconcileAction = 'submit' | 'settle' | 'block' | 'leave';

/**
 * What to do with an offering still Pending past the grace window. A succeeded check whose result
 * never reached the offering is applied; a missing or lost submit is resubmitted. Failed rows are
 * the retry cron's.
 */
export function reconcileAction(
  moderation: { status: EntityModerationStatus; blocked: boolean | null; updatedAt: Date } | null,
  { offeringUpdatedAt, pendingBefore }: { offeringUpdatedAt: Date; pendingBefore: Date }
): ReconcileAction {
  if (!moderation) return 'submit';
  // A result from before the last edit may be about the old text.
  if (moderation.status === EntityModerationStatus.Succeeded)
    return moderation.updatedAt < offeringUpdatedAt
      ? 'submit'
      : moderation.blocked
      ? 'block'
      : 'settle';
  if (moderation.status === EntityModerationStatus.Pending && moderation.updatedAt < pendingBefore)
    return 'submit';
  return 'leave';
}

/**
 * Offerings whose content check never settled: a lost submit or a callback whose result never
 * reached the offering. Also how offerings that predate the check are first submitted.
 */
export const serviceOfferingIngestionReconcile = createJob(
  'service-offering-ingestion-reconcile',
  '*/10 * * * *',
  async () => {
    const now = new Date();
    const stuckBefore = decreaseDate(now, STUCK_THRESHOLD_MINUTES, 'minutes');
    const pendingBefore = decreaseDate(now, PENDING_MODERATION_TIMEOUT_MINUTES, 'minutes');

    const candidates = await dbRead.serviceOffering.findMany({
      where: {
        ingestion: ServiceOfferingIngestionStatus.Pending,
        status: { not: ServiceOfferingStatus.Removed },
        updatedAt: { lt: stuckBefore },
      },
      select: { id: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: FETCH_LIMIT,
    });
    if (!candidates.length) return { candidates: 0 };

    const moderations = await dbRead.entityModeration.findMany({
      where: { entityType: 'ServiceOffering', entityId: { in: candidates.map((c) => c.id) } },
      select: { entityId: true, status: true, blocked: true, updatedAt: true },
    });
    const byId = new Map(moderations.map((m) => [m.entityId, m]));

    const counts: Record<ReconcileAction, number> = { submit: 0, settle: 0, block: 0, leave: 0 };
    let errors = 0;
    await limitConcurrency(
      candidates.map(({ id, updatedAt }) => async () => {
        const action = reconcileAction(byId.get(id) ?? null, {
          offeringUpdatedAt: updatedAt,
          pendingBefore,
        });
        counts[action]++;
        try {
          if (action === 'submit') await scanServiceOffering(id, { forceRescan: true });
          else if (action === 'settle') await settleServiceOfferingScan(id);
          else if (action === 'block') await blockServiceOffering(id);
        } catch (error) {
          errors++;
          logToAxiom({
            type: 'error',
            name: 'service-offering-ingestion-reconcile',
            message: error instanceof Error ? error.message : String(error),
            offeringId: id,
            action,
          }).catch(() => null);
        }
      }),
      CONCURRENCY
    );
    return { candidates: candidates.length, ...counts, errors };
  }
);
