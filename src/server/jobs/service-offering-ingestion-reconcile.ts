import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { TEXT_MODERATION_PENDING_TIMEOUT_MINUTES } from '~/server/jobs/text-moderation-retry';
import {
  blockServiceOffering,
  scanServiceOffering,
  settleOrHoldServiceOffering,
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
const FETCH_LIMIT = 200;
const CONCURRENCY = 5;

export type ReconcileAction = 'submit' | 'settle' | 'block' | 'leave';

/** What to do with an offering still Pending, or in Error, past the grace window. Failed checks are the retry cron's. */
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

/** Settles offerings whose check never did, and first submits the ones that predate it. */
export const serviceOfferingIngestionReconcile = createJob(
  'service-offering-ingestion-reconcile',
  '*/10 * * * *',
  async () => {
    const now = new Date();
    const stuckBefore = decreaseDate(now, STUCK_THRESHOLD_MINUTES, 'minutes');
    const pendingBefore = decreaseDate(now, TEXT_MODERATION_PENDING_TIMEOUT_MINUTES, 'minutes');

    const candidates = await dbRead.serviceOffering.findMany({
      where: {
        // Error too: a held result whose report failed to file is retried from here.
        ingestion: {
          in: [ServiceOfferingIngestionStatus.Pending, ServiceOfferingIngestionStatus.Error],
        },
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
          else if (action === 'settle') {
            // A verdict not about the current text is checked again rather than applied.
            if (
              (await settleOrHoldServiceOffering(id, { unchangedSince: updatedAt })) ===
              'unverified'
            )
              await scanServiceOffering(id, { forceRescan: true });
          } else if (
            action === 'block' &&
            !(await blockServiceOffering(id, { unchangedSince: updatedAt }))
          )
            // Edited since it was read: the verdict is about the old text.
            await scanServiceOffering(id, { forceRescan: true });
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
