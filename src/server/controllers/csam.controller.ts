import { handleDenyTrainingData } from '~/server/controllers/training.controller';
import type { Context } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { reviewConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';
import type { CreateCsamReportSchema } from '~/server/schema/csam.schema';
import { createCsamReport } from '~/server/services/csam.service';
import { bulkAddBlockedImages } from '~/server/services/image.service';
import { bulkSetReportStatus } from '~/server/services/report.service';
import { softDeleteUser } from '~/server/services/user.service';
import { BlockImageReason, ReportStatus } from '~/shared/utils/prisma/enums';

export async function createCsamReportHandler({
  input,
  ctx,
}: {
  input: CreateCsamReportSchema;
  ctx: DeepNonNullable<Context>;
}) {
  const { userId, imageIds = [], details, type } = input;
  const reportedById = ctx.user.id;
  await createCsamReport({ ...input, reportedById });

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
      await handleDenyTrainingData({ input: { id: modelVersionId } });
    }
  } else if (type === 'GeneratedImage') {
    await reviewConsumerStrikes({ consumerId: `civitai-${userId}`, moderatorId: reportedById });
  }

  if (userId !== -1) {
    await softDeleteUser({ id: userId, userId: reportedById });
  }
}
