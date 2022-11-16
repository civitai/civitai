import { Import, ImportStatus } from '@prisma/client';
import { createImporter } from '~/server/importers/importer';
import { prisma } from '~/server/db/client';
import { chunk } from 'lodash';

// Find match for URL like: https://huggingface.co/nitrosocke/Arcane-Diffusion
const hfAuthorRegex = /^https:\/\/huggingface\.co\/([\w\-]+)$/;
export const hfAuthorImporter = createImporter(
  (source) => {
    return hfAuthorRegex.test(source);
  },
  async (id, source, userId) => {
    // Get the author and model name from the URL
    const [, author] = hfAuthorRegex.exec(source) ?? [];

    // Get the model from HuggingFace
    const hfModels = await getHuggingFaceModels(author);
    const sources = hfModels.map((hfModel) => `https://huggingface.co/${hfModel.id}`);

    let importJobs: Import[] = [];
    const batches: string[][] = chunk(sources, 20);
    for (const batch of batches) {
      // Add the import jobs
      await prisma.import.createMany({
        data: batch.map((source) => ({
          source,
          userId,
          data: { fromJobId: id },
        })),
      });

      // Get them for processing
      const addedJobs = await prisma.import.findMany({
        where: {
          source: { in: batch },
          status: ImportStatus.Pending,
        },
      });

      importJobs = [...importJobs, ...addedJobs];
    }

    return {
      status: ImportStatus.Completed,
      dependencies: importJobs,
    };
  }
);

async function getHuggingFaceModels(author: string) {
  const result = (await fetch(`https://huggingface.co/api/models?author${author}`).then((r) =>
    r.json()
  )) as HuggingFaceModelStub[];

  return result;
}

type HuggingFaceModelStub = {
  id: string;
};
