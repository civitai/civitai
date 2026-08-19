import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { pickBestTrainingFile } from '~/server/schema/model-file.schema';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { resolveDownloadUrl } from '~/utils/delivery-worker';

export default defineModeratorEndpoint('trainingData.resolve', {
  summary: "Resolve a version's training data to a signed download URL.",
  returns: '{ url, name }',
  notes: [
    'Scoped to `Training Data` on the named version — it cannot be used to reach model weights.',
    'The URL is short-lived and grants whoever holds it the bytes; treat it as the evidence itself.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    modelVersionId: z.coerce
      .number()
      .int()
      .positive()
      .describe('The version whose training data to resolve.'),
  }),
  async handler(input) {
    const files = await dbRead.modelFile.findMany({
      where: { modelVersionId: input.modelVersionId, type: 'Training Data', dataPurged: false },
      select: { id: true, url: true, name: true, metadata: true },
    });

    // The same scoring the review pages use, so the bytes match the workflow the page is showing.
    const file = pickBestTrainingFile(files);
    // Thrown, not returned: the wrapper maps a TRPCError to its status, and a returned `{error}` would
    // be sent as a 200 with an error-shaped body.
    if (!file) throw throwNotFoundError('No training data on this version');

    try {
      const { url } = await resolveDownloadUrl(file.id, file.url, file.name);
      return { url, name: file.name, affected: { modelVersionIds: [input.modelVersionId] } };
    } catch {
      // Storage resolver and delivery-worker fallback both rejected it: registered but not deliverable.
      throw throwNotFoundError('Training data could not be resolved');
    }
  },
});
