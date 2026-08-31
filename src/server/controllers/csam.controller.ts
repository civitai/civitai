import { handleDenyTrainingData } from '~/server/controllers/training.controller';
import type { ProtectedContext } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { reviewConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';
import type {
  CreateCsamReportSchema,
  CreateExternalCsamReportSchema,
} from '~/server/schema/csam.schema';
import { createCsamReport } from '~/server/services/csam.service';
import { createExternalCsamReport } from '~/server/services/csam.service-new';
import { bulkAddBlockedImages } from '~/server/services/image.service';
import { bulkSetReportStatus } from '~/server/services/report.service';
import { softDeleteUser } from '~/server/services/user.service';
import { BlockImageReason, ReportStatus } from '~/shared/utils/prisma/enums';

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
  const { userId, imageIds = [], details, type, reportedById } = input;
  let denyFailed = false;
  await createCsamReport(input);

  // Resolve reports concerning csam images
  if (type === 'Image' && !!imageIds.length) {
    const affectedImages = await dbWrite.image.findMany({
      where: { id: { in: imageIds } },
      select: { pHash: true },
    });

    await Promise.all([
      bulkAddBlockedImages({
        data: affectedImages
          .filter((img) => !!img.pHash)
          .map((x) => ({
            hash: x.pHash as bigint,
            reason: BlockImageReason.CSAM,
          })),
      }),
      bulkSetReportStatus({
        ids: imageIds,
        status: ReportStatus.Actioned,
        userId: reportedById,
      }),
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
        await handleDenyTrainingData({ input: { id: modelVersionId } });
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
  } else if (type === 'GeneratedImage') {
    await reviewConsumerStrikes({ consumerId: `civitai-${userId}`, moderatorId: reportedById });
  }

  if (userId !== -1) {
    await softDeleteUser({ id: userId, userId: reportedById });
  }

  // Reported and removed either way; the caller decides how loudly to say the run is still open.
  return { denyFailed };
}

export async function createExternalCsamReportHandler({
  input,
  ctx,
}: {
  input: CreateExternalCsamReportSchema;
  ctx: ProtectedContext;
}) {
  // No auto soft-delete/ban here: external offenders are typically already
  // banned, and there is no on-Civitai content to remove. The report row is
  // picked up and sent to NCMEC by the hourly send-csam-reports job.
  await createExternalCsamReport({ ...input, reportedById: ctx.user.id });
}
