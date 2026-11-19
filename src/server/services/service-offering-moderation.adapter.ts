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
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { csamHoldBars } from '~/server/services/text-scan/csam-hold-bars';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { loadServiceOfferingSubjects } from '~/server/services/text-scan/profiles/service-offering.profile';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import {
  EntityModerationStatus,
  ReportReason,
  ServiceOfferingIngestionStatus,
} from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

const ENTITY_TYPE = 'ServiceOffering';

export function buildServiceOfferingModerationText(offering: {
  title: string;
  description: string;
}) {
  return [offering.title, offering.description].filter(Boolean).join(' ');
}

/**
 * A result applies only to the text it was for. `workflowId` is the check that produced it; a
 * result reached without one (a stored verdict for unchanged text, or the reconcile job's own
 * check) applies as is.
 */
type CurrentText = {
  workflowId?: string;
  /** The offering is unchanged since this `updatedAt`, read with the text that was checked. */
  unchangedSince?: Date;
};
const forCurrentText = (offeringId: number, { workflowId, unchangedSince }: CurrentText) => ({
  id: offeringId,
  ...(workflowId ? { scanWorkflowId: workflowId } : {}),
  ...(unchangedSince ? { updatedAt: unchangedSince } : {}),
});

/**
 * The rating takes the verdict, then the offering is marked scanned; a blocked one stays blocked.
 * Reached only through the hold checks below.
 */
async function markServiceOfferingScanned(offeringId: number, current: CurrentText = {}) {
  await updateServiceOfferingNsfwLevels([offeringId]);
  await dbWrite.serviceOffering.updateMany({
    where: {
      ...forCurrentText(offeringId, current),
      ingestion: {
        in: [ServiceOfferingIngestionStatus.Pending, ServiceOfferingIngestionStatus.Error],
      },
    },
    data: { ingestion: ServiceOfferingIngestionStatus.Scanned, scannedAt: new Date() },
  });
}

const readCsamHolds = (offeringId: number) =>
  dbWrite.textScanHold.findMany({
    where: { entityType: ENTITY_TYPE, entityId: offeringId, label: 'csam' },
    select: { status: true, textHash: true, meta: true },
  });

/**
 * Sends a blocked offering's new text back to its check, unless the csam queue holds it: a hold
 * pending or confirmed there, or a csam verdict no moderator dismissed for its text. Only that
 * queue's decisions let such an offering out.
 */
export async function requeueBlockedServiceOffering(offeringId: number) {
  await dbWrite.$executeRaw`
    UPDATE "ServiceOffering" SET "ingestion" = 'Pending', "scanWorkflowId" = NULL
    WHERE "id" = ${offeringId} AND "ingestion" = 'Blocked'
      AND NOT EXISTS (SELECT 1 FROM "TextScanHold" h
        WHERE h."entityType" = ${ENTITY_TYPE} AND h."entityId" = ${offeringId} AND h."label" = 'csam'
          AND h."status" IN ('Pending', 'Confirmed'))
      AND NOT EXISTS (SELECT 1 FROM "EntityModeration" em
        WHERE em."entityType" = ${ENTITY_TYPE} AND em."entityId" = ${offeringId}
          AND em."status" = 'Succeeded' AND 'csam' = ANY(em."triggeredLabels")
          AND NOT EXISTS (SELECT 1 FROM "TextScanHold" h
            WHERE h."entityType" = ${ENTITY_TYPE} AND h."entityId" = ${offeringId}
              AND h."label" = 'csam' AND h."status" = 'Dismissed'
              AND h."textHash" = em."result"->>'textHash'
              AND h."meta"->>'decision' IS DISTINCT FROM 'superseded'))`;
}

export type ServiceOfferingHoldState = 'held' | 'clear' | 'unverified';

/**
 * Whether the offering is held for the csam queue, read from the stored rows alone. `unverified`
 * when the stored verdict is not about the current text, or there is none; such an offering is not
 * shown.
 */
export async function serviceOfferingHoldState(
  offeringId: number
): Promise<ServiceOfferingHoldState> {
  const holds = await readCsamHolds(offeringId);
  if (csamHoldBars(null, holds)) return 'held';
  const verdict = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: ENTITY_TYPE, entityId: offeringId } },
    select: { status: true, triggeredLabels: true, result: true },
  });
  if (verdict?.status !== EntityModerationStatus.Succeeded) return 'unverified';
  const held = csamHoldBars(verdict, holds);
  const result = verdict.result as { version?: unknown; textHash?: unknown } | null;
  // A fallback-check row carries no text hash and never this label.
  if (result?.version === undefined) return held ? 'held' : 'clear';
  const subject = (await loadServiceOfferingSubjects([offeringId])).get(offeringId);
  if (typeof result.textHash !== 'string' || !subject) return held ? 'held' : 'unverified';
  if (textScanTextHash(subject) !== result.textHash) return 'unverified';
  return held ? 'held' : 'clear';
}

/** Settles a check, unless it is held: `verdict` is the check's own, when it has one to give. */
async function settleUnlessHeld(
  offeringId: number,
  current: CurrentText = {},
  verdict: Parameters<typeof csamHoldBars>[0] = null
) {
  if (csamHoldBars(verdict, await readCsamHolds(offeringId)))
    await blockServiceOffering(offeringId, current, { inHoldQueue: true });
  else await markServiceOfferingScanned(offeringId, current);
}

/**
 * Applies a passed check from the stored rows: a held offering is blocked, an unverified one is
 * left unshown. Returns what it found.
 */
export async function settleOrHoldServiceOffering(offeringId: number, current: CurrentText = {}) {
  const state = await serviceOfferingHoldState(offeringId);
  if (state === 'held') await blockServiceOffering(offeringId, current, { inHoldQueue: true });
  else if (state === 'clear') await markServiceOfferingScanned(offeringId, current);
  return state;
}

/** False when the offering is no longer the text checked, or is already blocked. */
export async function blockServiceOffering(
  offeringId: number,
  current: CurrentText = {},
  { inHoldQueue = false } = {}
): Promise<boolean> {
  const where = {
    ...forCurrentText(offeringId, current),
    ingestion: { not: ServiceOfferingIngestionStatus.Blocked },
  };
  // The primary: the check id this matches was written there a moment ago.
  const offering = await dbWrite.serviceOffering.findFirst({
    where,
    select: { sellerId: true, seller: { select: { username: true } } },
  });
  if (!offering) return false;
  await updateServiceOfferingNsfwLevels([offeringId]);
  // Filed before the offering is held, so a failure here leaves it Pending for the reconcile job to
  // try again rather than held with nothing for a moderator to review. It joins only a report still
  // waiting for a moderator, so a block after an earlier ruling reaches the queue again. An
  // offering in the hold queue is reviewed there instead.
  if (!inHoldQueue)
    await createReport({
      type: ReportEntity.ServiceOffering,
      id: offeringId,
      userId: constants.system.user.id,
      isModerator: true,
      reason: ReportReason.TOSViolation,
      foldIntoPendingOnly: true,
      details: {
        violation: 'Held by the automated content check',
        comment: 'The title or description did not pass the automated content check.',
      },
    });
  // The transition decides the notice, so a redelivered callback sends it once.
  const { count } = await dbWrite.serviceOffering.updateMany({
    where,
    data: { ingestion: ServiceOfferingIngestionStatus.Blocked, scannedAt: new Date() },
  });
  if (count === 0) return false;
  await createNotification({
    userId: offering.sellerId,
    category: NotificationCategory.System,
    type: 'system-message',
    key: `service-offering-text-blocked-${offeringId}`,
    details: {
      message: 'Your service is hidden while a moderator reviews it.',
      url: offering.seller.username
        ? `/user/${offering.seller.username}/shop/manage?tab=services`
        : '/',
    },
  });
  return true;
}

/**
 * Records the check submitted for the text as it was read, unless the text changed since. Raw SQL,
 * so `updatedAt` stays the edit's: the reconcile job compares a result's time against it. A result
 * that landed before the check was recorded was matched to nothing, so it is applied here.
 */
async function trackSubmit(
  offeringId: number,
  readAt: Date,
  submit: () => Promise<{ id?: string | null } | null | undefined>
) {
  const workflow = await submit();
  const workflowId = workflow?.id;
  if (!workflowId) return workflow;
  const recorded = await dbWrite.$executeRaw`
    UPDATE "ServiceOffering" SET "scanWorkflowId" = ${workflowId}
    WHERE id = ${offeringId} AND "updatedAt" = ${readAt}`;
  if (!recorded) return workflow;
  const early = await dbWrite.entityModeration.findFirst({
    where: {
      entityType: ENTITY_TYPE,
      entityId: offeringId,
      workflowId,
      status: EntityModerationStatus.Succeeded,
    },
    select: { blocked: true },
  });
  if (early) {
    const current = { workflowId, unchangedSince: readAt };
    if (early.blocked) await blockServiceOffering(offeringId, current);
    else await settleOrHoldServiceOffering(offeringId, current);
  }
  return workflow;
}

const settleSkipped = (offeringId: number, reason: SkipReason, readAt?: Date) =>
  // A removed offering is never shown, so its skipped scan has nothing to settle.
  reason === 'not-public'
    ? Promise.resolve()
    : settleSkippedScan(
        ENTITY_TYPE,
        offeringId,
        reason,
        (_level, { stored }) =>
          stored
            ? settleOrHoldServiceOffering(offeringId, { unchangedSince: readAt })
            : settleUnlessHeld(offeringId, { unchangedSince: readAt }),
        {
          offeringId,
        }
      );

/** `fresh`: a new submit, not the retry cron's, so the check gets a full retry budget again. */
const xguard =
  (offeringId: number, content: string, { fresh = false, forceRescan = false } = {}) =>
  () =>
    submitTextModeration({
      entityType: ENTITY_TYPE,
      entityId: offeringId,
      content,
      labels: ['nsfw'],
      priority: 'low',
      forceRescan,
      rearmRetries: fresh,
    });

/** Queues the title and description for the content check; the adapter below applies the result. */
export async function scanServiceOffering(offeringId: number, { forceRescan = false } = {}) {
  // The primary: called right after a write, and a lagging replica would scan the old text.
  const offering = await dbWrite.serviceOffering.findUnique({
    where: { id: offeringId },
    select: { title: true, description: true, updatedAt: true },
  });
  if (!offering) return;
  try {
    await trackSubmit(offeringId, offering.updatedAt, () =>
      submitTextModerationOrScan({
        entityType: ENTITY_TYPE,
        entityId: offeringId,
        force: forceRescan,
        onActiveSkip: (reason) => settleSkipped(offeringId, reason, offering.updatedAt),
        xguard: xguard(offeringId, buildServiceOfferingModerationText(offering), {
          fresh: true,
          forceRescan,
        }),
      })
    );
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

  submit: async ({ entityId, content }) => {
    const offering = await dbWrite.serviceOffering.findUnique({
      where: { id: entityId },
      select: { updatedAt: true },
    });
    const submit = () =>
      submitTextModerationOrScan({
        entityType: ENTITY_TYPE,
        entityId,
        fromRetry: true,
        onActiveSkip: (reason) => settleSkipped(entityId, reason, offering?.updatedAt),
        xguard: xguard(entityId, content),
      });
    return offering ? trackSubmit(entityId, offering.updatedAt, submit) : submit();
  },

  applyResult: async ({ entityId, workflowId, blocked }) => {
    if (blocked) await blockServiceOffering(entityId, { workflowId });
    else await settleUnlessHeld(entityId, { workflowId });
  },

  // Scoped to Pending so a failed rescan can't hide an offering that already passed.
  applyFailure: async ({ entityId }) => {
    await dbWrite.serviceOffering.updateMany({
      where: { id: entityId, ingestion: ServiceOfferingIngestionStatus.Pending },
      data: { ingestion: ServiceOfferingIngestionStatus.Error },
    });
  },

  // Its own verdict, read with the holds: a ruling on the same text stands, and a hold still
  // pending from earlier text holds it too.
  applyTextScan: withCsamHold(ENTITY_TYPE, ({ entityId, workflowId, outcome, textHash }) =>
    settleUnlessHeld(
      entityId,
      { workflowId },
      { triggeredLabels: outcome.csam?.detected ? ['csam'] : [], result: { textHash } }
    )
  ),
};
