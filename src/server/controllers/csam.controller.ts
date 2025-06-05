import { handleDenyTrainingData } from '~/server/controllers/training.controller';
import type { Context } from '~/server/createContext';
import type { CreateCsamReportSchema } from '~/server/schema/csam.schema';
import { createCsamReport } from '~/server/services/csam.service';
import { bulkSetReportStatus } from '~/server/services/report.service';
import { softDeleteUser } from '~/server/services/user.service';
import { ReportStatus } from '~/shared/utils/prisma/enums';

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
    await bulkSetReportStatus({
      ids: imageIds,
      status: ReportStatus.Actioned,
      userId: reportedById,
    });
  }

  // there should not be any reports for type 'TrainingData'
  const modelVersionIds = details?.modelVersionIds ?? [];
  if (type === 'TrainingData' && !!modelVersionIds.length) {
    const modelVersionId = modelVersionIds[0];
    await handleDenyTrainingData({ input: { id: modelVersionId } });
  }

  if (userId !== -1) {
    await softDeleteUser({ id: userId, userId: reportedById });
  }
}
