import * as z from 'zod';
import { fileCsamReport } from '~/server/controllers/csam.controller';
import { csamReportDetails } from '~/server/schema/csam.schema';
import { CsamReportType } from '~/shared/utils/prisma/enums';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('csam.trainingDataReport', {
  summary: 'File a CSAM report against a training dataset.',
  returns: '{ reported }',
  notes: [
    'Also denies the training run and soft-deletes the reported account — the report is not a flag, it is the action.',
    'Scoped to TrainingData: image and generated-image reports select content this endpoint has no way to receive.',
  ],
  rateLimit: { max: 20, windowSeconds: 60 },
  input: z.object({
    userId: z.coerce.number().int().positive().describe('The account that uploaded the dataset.'),
    modelVersionId: z.coerce.number().int().positive().describe('The training run being reported.'),
    minorDepiction: csamReportDetails.shape.minorDepiction.describe('Real or non-real minor.'),
    contents: csamReportDetails.shape.contents.describe('What the material may involve.'),
  }),
  async handler(input, ctx) {
    await fileCsamReport({
      userId: input.userId,
      type: CsamReportType.TrainingData,
      details: {
        modelVersionIds: [input.modelVersionId],
        minorDepiction: input.minorDepiction,
        contents: input.contents,
      },
      reportedById: ctx.actor.id,
    });
    return { reported: true, affected: { userIds: [input.userId] } };
  },
});
