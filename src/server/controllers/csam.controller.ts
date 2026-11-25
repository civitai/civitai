import { isDefined } from '~/utils/type-guards';
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
import { throwBadRequestError, throwServiceUnavailableError } from '~/server/utils/errorHandling';
import { createCsamReport } from '~/server/services/csam.service';
import type { CsamContextText } from '~/server/services/csam-context-text';
import { reportedUserIdsOf, snapshotCsamContextText } from '~/server/services/csam-context-text';
import { createSupplementalCsamReport } from '~/server/services/csam-supplemental.service';
import { createExternalCsamReport } from '~/server/services/csam.service-new';
import {
  releaseReviewFlagsToReportHold,
  releaseSettledAppealFlags,
} from '~/server/services/image-appeal-flag';
import {
  bulkAddBlockedImages,
  HeldMediaCopyError,
  logCsamBlocklistNoHash,
} from '~/server/services/image.service';
import { bulkSetReportStatus, csamReportRewardExclusions } from '~/server/services/report.service';
import { blockListedImagesAsCsam, softDeleteUser } from '~/server/services/user.service';
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

export const CSAM_LISTED_BLOCK_FAILED_MESSAGE =
  'Blocking the listed images failed, so nothing was filed. File the report again.';
export const CSAM_BLOCKLIST_FAILED_MESSAGE =
  'The report was filed and the account removed. Writing the image hashes to the blocklist failed and has been logged. Do not file again.';
/** The blocklist entry landed but its review copy did not. An operator repairs it with the reconcile
 *  script (scripts/oneoffs/reconcile-held-media-blocked-hashes.ts). */
export const CSAM_HELD_MEDIA_COPY_FAILED_MESSAGE =
  'The report was filed and the account removed. The blocklist entry was written, but its review copy failed and has been logged for repair. Do not file the report again.';

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
  // Before the report row: a filing whose images could not be blocked files nothing, so a retry is
  // clean. Search drops a listed image through its own row, whoever owns it.
  try {
    await blockListedImagesAsCsam(imageIds);
  } catch (error) {
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      important: true,
      message: 'blocking the listed images failed; nothing filed',
      userId,
      error: (error as Error)?.message,
      payload: { reportedById, imageCount: imageIds.length },
    });
    // A 503 so the message reaches the moderator (a 500's is replaced).
    throwServiceUnavailableError(CSAM_LISTED_BLOCK_FAILED_MESSAGE, error);
  }
  const report = supplementalOf
    ? await createSupplementalCsamReport({ ...filed, supplementalOf })
    : await createCsamReport({ ...filed, writeBlocklist: false });

  // Hashes read now, written after the account removal below, so a failed blocklist write cannot
  // hold that up.
  // A supplemental writes only for an Image report, as on main.
  const writesBlocklist = !!imageIds.length && (!supplementalOf || type === 'Image');
  const blocklistImages = writesBlocklist
    ? await dbWrite.image.findMany({
        where: { id: { in: imageIds } },
        select: { id: true, pHash: true },
      })
    : [];
  const blocklistHashes = blocklistImages.map((img) => img.pHash).filter(isDefined);
  logCsamBlocklistNoHash(
    blocklistImages.filter((img) => !img.pHash).map((img) => img.id),
    'csam-report'
  );
  // Resolve reports concerning csam images
  if (type === 'Image' && !!imageIds.length) {
    const imageReports = await dbWrite.imageReport.findMany({
      where: { imageId: { in: imageIds } },
      select: { reportId: true, image: { select: { userId: true } } },
    });

    // Bookkeeping only: a failure here must not stop the account being removed below.
    await bulkSetReportStatus({
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
        error: (e as Error)?.message,
        payload: { reportedById },
      })
    );
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
          error: (e as Error)?.message,
          payload: { reportedById },
        });
      }
    }
  }

  // A supplemental report follows one that removed the account for this; one restored or banned for
  // something else since is removed again.
  const removed = !!supplementalOf && (await removedForCsam(userId));
  let removalError: unknown;
  try {
    if (userId !== -1 && !removed) await softDeleteUser({ id: userId, userId: reportedById });
  } catch (error) {
    removalError = error;
    // Logged here: a failing blocklist write below would replace this error.
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      message: 'removing the reported account failed',
      userId,
      error: (error as Error)?.message,
      payload: { reportedById },
    });
  }
  // Written whether or not the removal succeeded. If the removal also failed, a write failure is
  // thrown here; otherwise it is thrown at the end, after the filed images' appeals are closed.
  let blocklistError: unknown;
  try {
    await bulkAddBlockedImages({
      data: blocklistHashes.map((hash) => ({ hash, reason: BlockImageReason.CSAM })),
      context: { step: 'csam-report', imageIds, actorUserId: reportedById },
    });
  } catch (error) {
    // The report id is what the missing write is redone from. No hashes.
    const failedStore = error instanceof HeldMediaCopyError ? error.store : 'blocklist';
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      message: 'CSAM blocklist write failed',
      userId,
      error: (error as Error)?.message,
      payload: { reportedById, csamReportId: report.id, imageCount: imageIds.length, failedStore },
    });
    if (removalError) throw error;
    blocklistError = error;
  }
  if (removalError) throw removalError;

  if (type === 'GeneratedImage' && !blocklistError) {
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
        });
      } else {
        strikesReviewFailed = true;
        logToAxiom({
          name: 'csam-report',
          type: 'error',
          important: true,
          message: 'strikes review failed after the report was filed and the account removed',
          userId,
          error: (e as Error)?.message,
          payload: { reportedById },
        });
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
    // The appeals closed above leave their flag on an image this report does not block.
    await releaseSettledAppealFlags(imageIds);
    // Last, so the images are already blocked and the report row committed when the flag comes off.
    await releaseReviewFlagsToReportHold(imageIds);
  }
  // A 503 so the message reaches the moderator (a 500's is replaced); it must stop a re-file,
  // which can create a second report.
  if (blocklistError)
    throwServiceUnavailableError(
      blocklistError instanceof HeldMediaCopyError
        ? CSAM_HELD_MEDIA_COPY_FAILED_MESSAGE
        : CSAM_BLOCKLIST_FAILED_MESSAGE,
      blocklistError
    );

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
