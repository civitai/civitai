import { constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { createNotification } from '~/server/services/notification.service';
import { updateServiceOfferingNsfwLevels } from '~/server/services/nsfwLevels.service';
import { createReport } from '~/server/services/report.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import {
  settleSkippedScan,
  type SkipReason,
} from '~/server/services/text-scan/actions/settle-skipped';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import { ReportReason, ServiceOfferingIngestionStatus } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

const ENTITY_TYPE = 'ServiceOffering';

export function buildServiceOfferingModerationText(offering: {
  title: string;
  description: string;
}) {
  return [offering.title, offering.description].filter(Boolean).join(' ');
}

/**
 * Settles a check that passed: the rating takes the verdict, then the offering is marked scanned.
 * A blocked offering stays blocked; only a moderator releases it.
 */
export async function settleServiceOfferingScan(offeringId: number) {
  await updateServiceOfferingNsfwLevels([offeringId]);
  await dbWrite.serviceOffering.updateMany({
    where: {
      id: offeringId,
      ingestion: {
        in: [ServiceOfferingIngestionStatus.Pending, ServiceOfferingIngestionStatus.Error],
      },
    },
    data: { ingestion: ServiceOfferingIngestionStatus.Scanned, scannedAt: new Date() },
  });
}

export async function blockServiceOffering(offeringId: number) {
  await updateServiceOfferingNsfwLevels([offeringId]);
  // The transition decides the report and the notice, so a redelivered callback files neither twice.
  const { count } = await dbWrite.serviceOffering.updateMany({
    where: { id: offeringId, ingestion: { not: ServiceOfferingIngestionStatus.Blocked } },
    data: { ingestion: ServiceOfferingIngestionStatus.Blocked, scannedAt: new Date() },
  });
  if (count === 0) return;
  const offering = await dbRead.serviceOffering.findUnique({
    where: { id: offeringId },
    select: { sellerId: true, seller: { select: { username: true } } },
  });
  if (!offering) return;
  await createReport({
    type: ReportEntity.ServiceOffering,
    id: offeringId,
    userId: constants.system.user.id,
    isModerator: true,
    reason: ReportReason.TOSViolation,
    details: {
      violation: 'Held by the automated content check',
      comment: 'The title or description did not pass the automated content check.',
    },
  }).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'service-offering-scan',
      message: 'block report failed',
      offeringId,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  await createNotification({
    userId: offering.sellerId,
    category: NotificationCategory.System,
    type: 'system-message',
    key: `service-offering-text-blocked-${offeringId}`,
    details: {
      message:
        'Your service is hidden while a moderator reviews it: its title or description did not pass our content check.',
      url: offering.seller.username
        ? `/user/${offering.seller.username}/shop/manage?tab=services`
        : '/',
    },
  });
}

const settleSkipped = (offeringId: number, reason: SkipReason) =>
  // A removed offering is never shown, so its skipped scan has nothing to settle.
  reason === 'not-public'
    ? Promise.resolve()
    : settleSkippedScan(
        ENTITY_TYPE,
        offeringId,
        reason,
        () => settleServiceOfferingScan(offeringId),
        {
          offeringId,
        }
      );

const xguard = (offeringId: number, content: string, forceRescan?: boolean) => () =>
  submitTextModeration({
    entityType: ENTITY_TYPE,
    entityId: offeringId,
    content,
    labels: ['nsfw'],
    priority: 'low',
    forceRescan,
  });

/** Queues the title and description for the content check; the adapter below applies the result. */
export async function scanServiceOffering(offeringId: number, { forceRescan = false } = {}) {
  // The primary: called right after a write, and a lagging replica would scan the old text.
  const offering = await dbWrite.serviceOffering.findUnique({
    where: { id: offeringId },
    select: { title: true, description: true },
  });
  if (!offering) return;
  try {
    await submitTextModerationOrScan({
      entityType: ENTITY_TYPE,
      entityId: offeringId,
      force: forceRescan,
      onActiveSkip: (reason) => settleSkipped(offeringId, reason),
      xguard: xguard(offeringId, buildServiceOfferingModerationText(offering), forceRescan),
    });
  } catch (e) {
    // The reconcile job resubmits an offering left Pending; saving must not fail on this.
    logToAxiom({
      type: 'error',
      name: 'service-offering-scan',
      message: e instanceof Error ? e.message : String(e),
      offeringId,
    });
  }
}

export const serviceOfferingModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.serviceOffering.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, description: true },
    });
    return new Map(rows.map((r) => [r.id, buildServiceOfferingModerationText(r)]));
  },

  // Only the retry cron calls submit.
  submit: ({ entityId, content }) =>
    submitTextModerationOrScan({
      entityType: ENTITY_TYPE,
      entityId,
      fromRetry: true,
      onActiveSkip: (reason) => settleSkipped(entityId, reason),
      xguard: xguard(entityId, content),
    }),

  applyResult: async ({ entityId, blocked }) => {
    if (blocked) await blockServiceOffering(entityId);
    else await settleServiceOfferingScan(entityId);
  },

  // Scoped to Pending so a failed rescan can't hide an offering that already passed.
  applyFailure: async ({ entityId }) => {
    await dbWrite.serviceOffering.updateMany({
      where: { id: entityId, ingestion: ServiceOfferingIngestionStatus.Pending },
      data: { ingestion: ServiceOfferingIngestionStatus.Error },
    });
  },

  applyTextScan: async ({ entityId }) => {
    await settleServiceOfferingScan(entityId);
  },
};
