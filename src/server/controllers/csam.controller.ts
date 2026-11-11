import { handleDenyTrainingData } from '~/server/controllers/training.controller';
import type { ProtectedContext } from '~/server/createContext';
import {
  FEEDBACK_CAPTURE_OWNER_REFUSAL,
  isFeedbackCaptureOwner,
} from '@civitai/shared/feedback-capture';
import { BanReasonCode } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  FlaggedConsumerFetchError,
  reviewConsumerStrikes,
} from '~/server/http/orchestrator/flagged-consumers';
import type {
  CreateCsamReportSchema,
  CreateExternalCsamReportSchema,
  CsamReportFormOutput,
} from '~/server/schema/csam.schema';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { createCsamReport } from '~/server/services/csam.service';
import type { CsamContextText } from '~/server/services/csam-context-text';
import { reportedUserIdsOf, snapshotCsamContextText } from '~/server/services/csam-context-text';
import { createSupplementalCsamReport } from '~/server/services/csam-supplemental.service';
import { createExternalCsamReport } from '~/server/services/csam.service-new';
import { releaseReviewFlagsToReportHold } from '~/server/services/image-appeal-flag';
import { bulkAddBlockedImages } from '~/server/services/image.service';
import { bulkSetReportStatus, csamReportRewardExclusions } from '~/server/services/report.service';
import { softDeleteUser } from '~/server/services/user.service';
import {
  AppealStatus,
  BlockImageReason,
  EntityType,
  ReportStatus,
} from '~/shared/utils/prisma/enums';

export async function createCsamReportHandler({
  input,
  ctx,
}: {
  input: CreateCsamReportSchema;
  ctx: ProtectedContext;
}) {
  return fileCsamReport({ ...input, reportedById: ctx.user.id });
}

/** The report plus everything it triggers. Split from the tRPC handler so `/api/mod/csam/*` can reach
 *  it with the acting moderator's id rather than a fabricated tRPC context. */
export async function fileCsamReport(input: CreateCsamReportSchema & { reportedById: number }) {
  const { contextSources, ...filing } = input;
  const { userId, imageIds = [], details, type, reportedById, supplementalOf } = filing;
  let denyFailed = false;
  let denyBookkeepingFailed = false;
  let strikesReviewFailed = false;
  if (
    isFeedbackCaptureOwner(userId) ||
    isFeedbackCaptureOwner((details as { secondaryUserId?: unknown } | undefined)?.secondaryUserId)
  )
    throwBadRequestError(FEEDBACK_CAPTURE_OWNER_REFUSAL);
  if (contextSources && type !== 'Image')
    throwBadRequestError('Text can be attached to an image report only');
  const contextText = contextSources
    ? await snapshotCsamContextText({
        imageIds,
        ...(userId > 0 && { ownerId: userId }),
        sources: contextSources,
        reportedUserIds: reportedUserIdsOf(userId, details),
        capturedById: reportedById,
      })
    : [];
  const withContext: CsamReportFormOutput & { contextText?: CsamContextText[] } = {
    ...details,
    contextText,
  };
  const filed = contextText.length ? { ...filing, details: withContext } : filing;
  if (supplementalOf) await createSupplementalCsamReport({ ...filed, supplementalOf });
  else await createCsamReport(filed);

  // Resolve reports concerning csam images
  if (type === 'Image' && !!imageIds.length) {
    const [affectedImages, imageReports] = await Promise.all([
      dbWrite.image.findMany({ where: { id: { in: imageIds } }, select: { pHash: true } }),
      dbWrite.imageReport.findMany({
        where: { imageId: { in: imageIds } },
        select: { reportId: true, image: { select: { userId: true } } },
      }),
    ]);

    await Promise.all([
      bulkAddBlockedImages({
        data: affectedImages
          .filter((img) => !!img.pHash)
          .map((x) => ({
            hash: x.pHash as bigint,
            reason: BlockImageReason.CSAM,
          })),
      }),
      // Bookkeeping only: a failure here must not stop the account being removed below.
      bulkSetReportStatus({
        ids: imageReports.map((report) => report.reportId),
        status: ReportStatus.Actioned,
        userId: reportedById,
        noRewardFor: csamReportRewardExclusions(userId, imageReports),
        rewardRemovedReporters: false,
      }).catch((e) =>
        logToAxiom({
          name: 'csam-report',
          type: 'error',
          important: true,
          message: 'actioning the reports on filed images failed',
          userId,
          reportedById,
          error: (e as Error)?.message,
        }).catch(() => undefined)
      ),
    ]);
  } else if (type === 'TrainingData') {
    const modelVersionId = details?.modelVersionIds?.[0];
    if (modelVersionId) {
      // Isolated on purpose. The report row is already committed and the hourly job will forward it to
      // NCMEC, so letting this throw would abandon the fan-out BEFORE the soft-delete below — leaving a
      // reported account fully active with its content live, while the caller sees only a deny error.
      // The deny is the least certain step (the gate can be already resolved, expired, or the
      // orchestrator briefly down) and the one that is safe to retry, so it must not gate the rest.
      try {
        const denied = await handleDenyTrainingData({
          input: { id: modelVersionId },
          moderatorId: reportedById,
        });
        // The gate IS released here, so this is not a failed deny — the run is stopped and repeating
        // the action would refuse. Only our own record is behind, which still needs a human.
        denyBookkeepingFailed = denied.webhookFailed;
      } catch (e) {
        denyFailed = true;
        logToAxiom({
          name: 'csam-report',
          type: 'error',
          important: true,
          message: 'training deny failed; report filed and account still removed',
          modelVersionId,
          userId,
          reportedById,
          error: (e as Error)?.message,
        }).catch(() => undefined);
      }
    }
  }

  // A supplemental report follows one that removed the account for this; one restored or banned for
  // something else since is removed again.
  const removed = !!supplementalOf && (await removedForCsam(userId));
  if (userId !== -1 && !removed) {
    await softDeleteUser({ id: userId, userId: reportedById });
  }

  if (type === 'GeneratedImage') {
    // After the removal, so a slow or failing orchestrator can never hold it up. A 404 is the retired
    // route, which leaves nothing to review.
    try {
      await reviewConsumerStrikes({ consumerId: `civitai-${userId}`, moderatorId: reportedById });
    } catch (e) {
      if (e instanceof FlaggedConsumerFetchError && e.status === 404) {
        logToAxiom({
          name: 'csam-report',
          type: 'info',
          message: 'strikes review not found at the orchestrator; nothing to review',
        }).catch(() => undefined);
      } else {
        strikesReviewFailed = true;
        logToAxiom({
          name: 'csam-report',
          type: 'error',
          important: true,
          message: 'strikes review failed after the report was filed and the account removed',
          userId,
          reportedById,
          error: (e as Error)?.message,
        }).catch(() => undefined);
      }
    }
  }

  if (type === 'Image' && imageIds.length) {
    await dbWrite.appeal.updateMany({
      where: {
        entityType: EntityType.Image,
        entityId: { in: imageIds },
        status: AppealStatus.Pending,
      },
      data: {
        status: AppealStatus.Rejected,
        resolvedBy: reportedById,
        resolvedAt: new Date(),
        internalNotes: 'Closed by CSAM report',
      },
    });
    // Every filed image's deferred block effects, whether or not its flag comes off below.
    await dbWrite.$executeRaw`
      DELETE FROM "ImageDeferredBlockEffect" WHERE "imageId" = ANY(${imageIds}::int[])
    `;
    // Last, so the images are already blocked and the report row committed when the flag comes off.
    await releaseReviewFlagsToReportHold(imageIds);
  }

  // Reported and removed either way; the caller decides how loudly to say the run is still open.
  return { denyFailed, denyBookkeepingFailed, strikesReviewFailed };
}

export async function createExternalCsamReportHandler({
  input,
  ctx,
}: {
  input: CreateExternalCsamReportSchema;
  ctx: ProtectedContext;
}) {
  if (isFeedbackCaptureOwner(input.userId) || isFeedbackCaptureOwner(input.secondaryUserId))
    throwBadRequestError(FEEDBACK_CAPTURE_OWNER_REFUSAL);
  // No auto soft-delete/ban here: external offenders are typically already
  // banned, and there is no on-Civitai content to remove. The report row is
  // picked up and sent to NCMEC by the hourly send-csam-reports job.
  await createExternalCsamReport({ ...input, reportedById: ctx.user.id });
}

async function removedForCsam(userId: number) {
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true, meta: true },
  });
  const reasonCode = (user?.meta as { banDetails?: { reasonCode?: string } } | null)?.banDetails
    ?.reasonCode;
  return !!user?.bannedAt && reasonCode === BanReasonCode.SexualMinor;
}
