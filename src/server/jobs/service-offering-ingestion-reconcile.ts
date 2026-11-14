import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import {
  TEXT_MODERATION_PENDING_TIMEOUT_MINUTES,
  TEXT_MODERATION_RETRY_LIMIT,
} from '~/server/jobs/text-moderation-retry';
import {
  blockServiceOffering,
  scanServiceOffering,
  settleOrHoldServiceOffering,
} from '~/server/services/service-offering-moderation.adapter';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';

// Gives the callback time to land before the job steps in.
const STUCK_THRESHOLD_MINUTES = 10;
// A check that spent its retries is sent again after this, with a fresh retry budget.
export const EXHAUSTED_RESUBMIT_AFTER_HOURS = 24;
const FETCH_LIMIT = 200;
const CONCURRENCY = 5;

const TERMINAL: EntityModerationStatus[] = [
  EntityModerationStatus.Failed,
  EntityModerationStatus.Expired,
  EntityModerationStatus.Canceled,
];

export type ReconcileAction = 'submit' | 'resubmit-exhausted' | 'settle' | 'block' | 'leave';

type Moderation = {
  status: EntityModerationStatus;
  blocked: boolean | null;
  updatedAt: Date;
  retryCount: number;
};

/**
 * What to do with an offering still Pending, or in Error, past the grace window. A failed check
 * with retries left is the retry cron's; one that spent them is sent again after a cooldown.
 */
export function reconcileAction(
  moderation: Moderation | null,
  {
    offeringUpdatedAt,
    pendingBefore,
    exhaustedBefore,
  }: { offeringUpdatedAt: Date; pendingBefore: Date; exhaustedBefore: Date }
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
  if (
    TERMINAL.includes(moderation.status) &&
    moderation.retryCount >= TEXT_MODERATION_RETRY_LIMIT &&
    moderation.updatedAt < exhaustedBefore
  )
    return 'resubmit-exhausted';
  return 'leave';
}

type Candidate = {
  id: number;
  updatedAt: Date;
  moderation: Moderation | null;
};

/**
 * The offerings `reconcileAction` would act on, oldest first. Rows it would leave are filtered
 * here, so they cannot fill the batch.
 */
export async function serviceOfferingReconcileCandidates({
  stuckBefore,
  pendingBefore,
  exhaustedBefore,
}: {
  stuckBefore: Date;
  pendingBefore: Date;
  exhaustedBefore: Date;
}): Promise<Candidate[]> {
  const rows = await dbRead.$queryRaw<
    {
      id: number;
      updatedAt: Date;
      status: EntityModerationStatus | null;
      blocked: boolean | null;
      moderationUpdatedAt: Date | null;
      retryCount: number | null;
    }[]
  >`
    SELECT o.id, o."updatedAt", em.status::text AS status, em.blocked,
      em."updatedAt" AS "moderationUpdatedAt", em."retryCount"
    FROM "ServiceOffering" o
    LEFT JOIN "EntityModeration" em
      ON em."entityType" = 'ServiceOffering' AND em."entityId" = o.id
    -- Error too: a held result whose report failed to file is retried from here.
    WHERE o.ingestion IN ('Pending', 'Error')
      AND o.status <> 'Removed'
      AND o."updatedAt" < ${stuckBefore}
      AND (
        em."entityId" IS NULL
        OR em.status = 'Succeeded'
        OR (em.status = 'Pending' AND em."updatedAt" < ${pendingBefore})
        OR (em.status IN ('Failed', 'Expired', 'Canceled')
          AND em."retryCount" >= ${TEXT_MODERATION_RETRY_LIMIT}
          AND em."updatedAt" < ${exhaustedBefore})
      )
    ORDER BY o."updatedAt" ASC
    LIMIT ${FETCH_LIMIT}`;
  return rows.map(({ id, updatedAt, status, blocked, moderationUpdatedAt, retryCount }) => ({
    id,
    updatedAt,
    moderation:
      status && moderationUpdatedAt
        ? { status, blocked, updatedAt: moderationUpdatedAt, retryCount: retryCount ?? 0 }
        : null,
  }));
}

/** Settles offerings whose check never did, and first submits the ones that predate it. */
export const serviceOfferingIngestionReconcile = createJob(
  'service-offering-ingestion-reconcile',
  '*/10 * * * *',
  async () => {
    const now = new Date();
    const stuckBefore = decreaseDate(now, STUCK_THRESHOLD_MINUTES, 'minutes');
    const pendingBefore = decreaseDate(now, TEXT_MODERATION_PENDING_TIMEOUT_MINUTES, 'minutes');

    const exhaustedBefore = decreaseDate(now, EXHAUSTED_RESUBMIT_AFTER_HOURS, 'hours');

    const candidates = await serviceOfferingReconcileCandidates({
      stuckBefore,
      pendingBefore,
      exhaustedBefore,
    });
    if (!candidates.length) return { candidates: 0 };

    const counts: Record<ReconcileAction, number> = {
      submit: 0,
      'resubmit-exhausted': 0,
      settle: 0,
      block: 0,
      leave: 0,
    };
    let errors = 0;
    await limitConcurrency(
      candidates.map(({ id, updatedAt, moderation }) => async () => {
        const action = reconcileAction(moderation, {
          offeringUpdatedAt: updatedAt,
          pendingBefore,
          exhaustedBefore,
        });
        counts[action]++;
        try {
          if (action === 'resubmit-exhausted')
            logToAxiom({
              type: 'warning',
              name: 'service-offering-ingestion-reconcile',
              message: 'content check spent its retries; resubmitting',
              offeringId: id,
              moderationStatus: moderation?.status,
            }).catch(() => null);
          if (action === 'submit' || action === 'resubmit-exhausted')
            await scanServiceOffering(id, { forceRescan: true });
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
