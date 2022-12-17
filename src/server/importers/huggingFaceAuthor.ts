import { ImportStatus } from '@prisma/client';
import { createImporter } from '~/server/importers/importer';

// Find match for URL like: https://huggingface.co/nitrosocke/Arcane-Diffusion
const hfAuthorRegex = /^https:\/\/huggingface\.co\/([\w\-]+)$/;
export const hfAuthorImporter = createImporter(
  (source) => {
    return hfAuthorRegex.test(source);
  },
  async ({ source }) => {
    // Get the author and model name from the URL
    const [, author] = hfAuthorRegex.exec(source) ?? [];

    // Get the model from HuggingFace
    const hfModels = await getHuggingFaceModels(author);

    return {
      status: ImportStatus.Completed,
      dependencies: hfModels.map((hfModel) => ({
        source: `https://huggingface.co/${hfModel.id}`,
        data: hfModel,
      })),
    };
  }
);

async function getHuggingFaceModels(author: string) {
  const result = (await fetch(`https://huggingface.co/api/models?author=${author}&full=true`).then(
    (r) => r.json()
  )) as HuggingFaceModel[];

  return result;
}

type HuggingFaceModel = {
  id: string;
  author: string;
  lastModified: string;
  tags: string[];
  downloads: number;
  likes: number;
  siblings: {
    rfilename: string;
  }[];
};
