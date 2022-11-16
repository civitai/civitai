import { ImportStatus, ModelFileType, ModelType, Prisma } from '@prisma/client';
import { createImporter } from '~/server/importers/importer';
import { prisma } from '~/server/db/client';
import { uploadViaUrl } from '~/utils/cf-images-utils';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { markdownToHtml } from '~/utils/markdown-helpers';
import { bytesToKB } from '~/utils/number-helpers';
import { imageToBlurhash } from '~/utils/image-utils';

// Find match for URL like: https://huggingface.co/nitrosocke/Arcane-Diffusion
const hfModelRegex = /^https:\/\/huggingface\.co\/([\w\-]+)\/([\w\-]+)/;
export const hfModelImporter = createImporter(
  (source) => {
    return hfModelRegex.test(source);
  },
  async (id, source) => {
    // Get the author and model name from the URL
    const [, author, modelName] = hfModelRegex.exec(source) ?? [];

    // Get the model from HuggingFace
    let hfModel: HuggingFaceModel | undefined;
    try {
      hfModel = await getHuggingFaceModel(author, modelName);
    } catch (error) {
      throw new Error(`Could not find model ${author}/${modelName}`);
    }

    await importModelFromHuggingFace(hfModel, { id, source });

    return {
      status: ImportStatus.Completed,
    };
  }
);

const modelFileRegex = /\.(ckpt|pt|bin)$/;
export async function importModelFromHuggingFace(
  { id, siblings, author }: HuggingFaceModel,
  { id: importId, source }: { id?: number; source?: string } = {}
) {
  const hfRootUrl = `https://huggingface.co/${id}/resolve/main/`;
  const files = siblings.map((x) => ({
    name: x.rfilename,
    url: hfRootUrl + x.rfilename,
  }));

  // check for previous models imported from same hfModel.id
  let model = await prisma.model.findFirst({
    where: { fromImport: { source } },
    select: { id: true, modelVersions: { select: { files: true, images: true } } },
  });
  const images: { id: number }[] =
    model?.modelVersions[0]?.images.map((x) => ({ id: x.imageId })) ?? [];

  // Prep image and description if needed
  const imagesToCreate: Prisma.ImageUncheckedCreateInput[] = [];
  let description = `<p>Originally posted to <a href="https://huggingface.co/${id}">HuggingFace by ${author}</a></p>`;
  if (!model) {
    // Get README
    try {
      const readme = await fetch(hfRootUrl + 'README.md').then((r) => r.text());
      description += await markdownToHtml(readme);
    } catch (error) {
      // This is fine... 🔥
    }

    // Upload images
    const imageFiles = files.filter((f) => isImage(f.name));
    if (!imageFiles.length)
      // if no images, use the default
      imageFiles.push({
        name: 'default.png',
        url: `https://thumbnails.huggingface.co/social-thumbnails/models/${id}.png`,
      });

    // Process images
    for (const { name, url } of imageFiles) {
      try {
        const { id } = await uploadViaUrl(url, {
          userId: 1,
          source: 'huggingface',
        });
        const { hash, height, width } = await getImageProps(id);
        imagesToCreate.push({ name, url: id, userId: 1, hash, height, width });
      } catch (error) {
        console.error(error);
      }
    }
  }

  // Prepare modelVersions files
  // for each file in the model, create a modelVersion on the model
  const modelVersions: Prisma.ModelVersionUncheckedCreateInput[] = [];
  let type: ModelType = ModelType.Checkpoint;
  for (const { name, url } of files) {
    // TODO Import: Improve this to handle models that aren't saved as `.ckpt`
    // Example: https://huggingface.co/sd-dreambooth-library/the-witcher-game-ciri/tree/main
    if (!modelFileRegex.test(name)) continue;

    const existingVersion = model?.modelVersions.find((v) => v.files.some((f) => f.name === name));
    if (existingVersion) continue;

    // HEAD the file to get the size
    const { headers } = await fetch(url, { method: 'HEAD' });
    const size = bytesToKB(parseInt(headers.get('Content-Length') ?? '0'));
    type = fileToModelType(name, size);

    modelVersions.push({
      modelId: 0,
      name: filenameToVersionName(name, id),
      fromImportId: importId,
      files: {
        create: [
          {
            url,
            sizeKB: size,
            name,
            type: ModelFileType.Model,
          },
        ],
      },
    });
  }

  await prisma.$transaction(
    async (tx) => {
      // if it doesn't exist, create it
      if (!model) {
        // Create model
        model = await tx.model.create({
          data: {
            name: id.split('/').pop() ?? id,
            description,
            fromImportId: importId,
            type,
            userId: 1,
          },
          select: { id: true, modelVersions: { select: { files: true, images: true } } },
        });

        for (const data of imagesToCreate) {
          const image = await tx.image.create({
            data,
            select: { id: true },
          });
          images.push(image);
        }
      }

      for (const data of modelVersions) {
        data.modelId = model.id;
        data.images = {
          create: images.map((image, index) => ({ imageId: image.id, index })),
        };
        await tx.modelVersion.create({ data });
      }
    },
    {
      maxWait: 5000,
      timeout: 10000,
    }
  );
}

async function getHuggingFaceModel(author: string, modelName: string) {
  const result = (await fetch(`https://huggingface.co/api/models/${author}/${modelName}`).then(
    (r) => r.json()
  )) as HuggingFaceModel;

  return result;
}

function filenameToVersionName(filename: string, hfModelId: string) {
  const modelName = hfModelId.split('/')[1];
  const versionName = filename
    .replace(modelName, '')
    .replace(modelFileRegex, '')
    .replace(/[-_]/g, ' ')
    .trim();
  return versionName;
}

function isImage(filename: string) {
  return /\.(png|gif|jpg|jpeg)$/.test(filename);
}

function fileToModelType(filename: string, sizeKB: number) {
  if (/\.(pt|bin)$/.test(filename)) {
    if (sizeKB > 10 * 1000) return ModelType.Hypernetwork;
    if (sizeKB < 1000) return ModelType.TextualInversion;
    // TODO ModelType Importing: determine some way of determining if something is a Aesthetic Gradient or TI
  }
  return ModelType.Checkpoint;
}

async function getImageProps(id: string) {
  const url = getEdgeUrl(id, { width: 512 });
  return await imageToBlurhash(url);
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
