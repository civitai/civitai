import { ImportStatus, ModelFileType, ModelType } from '@prisma/client';
import { createImporter } from '~/server/importers/importer';
import { prisma } from '~/server/db/client';
import { uploadViaUrl } from '~/utils/cf-images-utils';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { markdownToHtml } from '~/utils/markdown-helpers';
import { bytesToKB } from '~/utils/number-helpers';
import { imageToBlurhash } from '~/utils/image-utils';

// Find match for URL like: https://huggingface.co/nitrosocke/Arcane-Diffusion
const huggingFaceRegex = /^https:\/\/huggingface\.co\/([\w\-]+)\/([\w\-]+)/;
export const huggingFaceImporter = createImporter(
  (source) => {
    return huggingFaceRegex.test(source);
  },
  async (id, source) => {
    // Get the author and model name from the URL
    const [, author, modelName] = huggingFaceRegex.exec(source) ?? [];

    // Get the model from HuggingFace
    let hfModel: HuggingFaceModel | undefined;
    try {
      hfModel = await getHuggingFaceModel(author, modelName);
    } catch (error) {
      throw new Error(`Could not find model ${author}/${modelName}`);
    }
    const hfRootUrl = `https://huggingface.co/${hfModel.id}/resolve/main/`;
    const files = hfModel.siblings.map((x) => ({
      name: x.rfilename,
      url: hfRootUrl + x.rfilename,
    }));

    await prisma.$transaction(async (tx) => {
      // check for previous models imported from same hfModel.id
      let model = await tx.model.findFirst({
        where: { fromImport: { source } },
        select: { id: true, modelVersions: { select: { files: true, images: true } } },
      });
      const images: { id: number }[] =
        model?.modelVersions[0]?.images.map((x) => ({ id: x.imageId })) ?? [];

      // if it doesn't exist, create it
      if (!model) {
        let description = `<p>Originally posted to <a href="${source}">HuggingFace by ${author}</a></p>`;
        // Get README
        try {
          const readme = await fetch(hfRootUrl + 'README.md').then((r) => r.text());
          description += await markdownToHtml(readme);
        } catch (error) {
          // This is fine... 🔥
        }

        // Create model
        model = await tx.model.create({
          data: {
            name: modelName,
            description,
            fromImportId: id,
            type: ModelType.Checkpoint,
            userId: 1,
          },
          select: { id: true, modelVersions: { select: { files: true, images: true } } },
        });

        // Upload images
        const imageFiles = files.filter((f) => isImage(f.name));
        if (!imageFiles.length)
          // if no images, use the default
          imageFiles.push({
            name: 'default.png',
            url: `https://thumbnails.huggingface.co/social-thumbnails/models/${hfModel.id}.png`,
          });

        // Process images
        for (const { name, url } of imageFiles) {
          try {
            const { id } = await uploadViaUrl(url, {
              modelId: model.id,
              userId: 1,
              source: 'huggingface',
            });
            const { hash, height, width } = await getImageProps(id);
            const image = await tx.image.create({
              data: { name, url: id, userId: 1, hash, height, width },
              select: { id: true },
            });
            images.push(image);
          } catch (error) {
            console.error(error);
          }
        }
      }

      // for each file in the model, create a modelVersion on the model
      for (const { name, url } of files) {
        if (!name.endsWith('.ckpt')) continue;

        const existingVersion = model.modelVersions.find((v) =>
          v.files.some((f) => f.name === name)
        );
        if (existingVersion) continue;

        // HEAD the file to get the size
        const { headers } = await fetch(url, { method: 'HEAD' });
        const size = parseInt(headers.get('Content-Length') ?? '0');

        await tx.modelVersion.create({
          data: {
            modelId: model.id,
            name: filenameToVersionName(name, hfModel),
            fromImportId: id,
            files: {
              create: [
                {
                  url,
                  sizeKB: bytesToKB(size),
                  name,
                  type: ModelFileType.Model,
                },
              ],
            },
            images: {
              create: images.map((image, index) => ({ imageId: image.id, index })),
            },
          },
        });
      }
    });

    return {
      status: ImportStatus.Completed,
    };
  }
);

async function getHuggingFaceModel(author: string, modelName: string) {
  const result = (await fetch(`https://huggingface.co/api/models/${author}/${modelName}`).then(
    (r) => r.json()
  )) as HuggingFaceModel;

  return result;
}

function filenameToVersionName(filename: string, hfModel: HuggingFaceModel) {
  const modelName = hfModel.id.split('/')[1];
  const versionName = filename
    .replace(modelName, '')
    .replace(/\.ckpt$/, '')
    .replace(/[-_]/g, ' ')
    .trim();
  return versionName;
}

function isImage(filename: string) {
  return /\.(png|gif|jpg|jpeg)$/.test(filename);
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
