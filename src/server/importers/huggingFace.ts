import { ImportStatus, ModelFileType, ModelType } from '@prisma/client';
import { createImporter } from '~/server/importers/importer';
import { prisma } from '~/server/db/client';
import { getS3Client } from '~/utils/s3-utils';
import { uploadViaUrl } from '~/utils/cf-images-utils';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import matter from 'gray-matter';

// Find match for URL like: https://huggingface.co/nitrosocke/Arcane-Diffusion
const huggingFaceRegex = /^https:\/\/huggingface\.co\/([\w\-]+)\/([\w\-]+)/;
export const huggingFaceImporter = createImporter(
  (source) => {
    return huggingFaceRegex.test(source);
  },
  async (id, source) => {
    // TODO Import: Implement HuggingFace importer
    // Using https://huggingface.co/docs/hub/api

    // Get the author and model name from the URL
    const [, author, modelName] = huggingFaceRegex.exec(source) ?? [];

    let hfModel: HuggingFaceModel | undefined;
    try {
      hfModel = await getHuggingFaceModel(author, modelName);
    } catch (error) {
      throw new Error(`Could not find model ${author}/${modelName}`);
    }
    const files = hfModel.siblings.map((x) => x.rfilename);

    // check for previous models imported from same hfModel.id
    let model = await prisma.model.findFirst({
      where: { fromImport: { source } },
      select: { id: true, modelVersions: { select: { files: true, images: true } }}
    });
    const images: {id: number}[] = model?.modelVersions[0]?.images.map(x=>({id: x.imageId})) ?? [];

    // if it doesn't exist, create it
    const createModel = model == null;
    if (!model) {
      let description = `<p>Originally posted to <a href="${source}">HuggingFace by ${author}</a></p>`
      // Get README
      try {
        const readme = await fetch(`https://huggingface.co/${hfModel.id}/raw/main/README.md`).then(
          (r) => r.text()
        );
        // TODO IMPORT: Use Remark to parse markdown
        const { data: frontmatter, content } = matter(readme);
        description += content
      } catch (error) {
        // This is fine... 🔥
      }

      // Create model
      model = await prisma.model.create({
        data: {
          name: modelName,
          ,
          fromImportId: id,
          type: ModelType.Checkpoint,
          userId: 1,
        },
        select: { id: true, modelVersions: { select: { files: true, images: true } }}
      })

      // Upload images
      for (const file of files) {
        if (!isImage(file)) continue;
        const url = `https://huggingface.co/${hfModel.id}/resolve/main/${file}`;
        try {
          const { id } = await uploadViaUrl(url, { modelId: model.id, userId: 1, source: 'huggingface' });\
          const { hash, height, width } = getImageProps(id);
          const image = await prisma.image.create({
            data: { url: id, userId: 1, hash, height, width },
            select: { id: true }
          });
          images.push(image);
        } catch (error) {
          console.error(error);
        }
      }
    }

    // for each file in the model, create a modelVersion on the model
    for (const file of files) {
      if (!file.endsWith('.ckpt')) continue;

      const existingVersion = model.modelVersions.find((v) => v.files.some((f) => f.name === file));
      const url = `https://huggingface.co/${author}/${modelName}/resolve/main/${file}`;
      if (existingVersion) continue;

      // HEAD the file to get the size
      const { headers } = await fetch(url, { method: 'HEAD' });
      const size = parseInt(headers.get('content-length') ?? '0');
      const name = filenameToVersionName(file, hfModel);

      await prisma.modelVersion.create({
        data: {
          modelId: model.id,
          name,
          fromImportId: id,
          files: {
            create: [{
              url, // TODO Import: make the scanner upload to S3 if it's not in our bucket...
              sizeKB: size / 1000,
              name: file,
              type: ModelFileType.Model,
            }],
          },
          images: {
            create: images.map((image, index) => ({ imageId: image.id, index }))
          }
        },
      });
    }

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
  const versionName = filename.replace(modelName, '').replace(/\.ckpt$/, '').replace(/[-_]/g,' ').trim();
  return versionName
}

function isImage(filename: string) {
  return /\.(png|gif|jpg|jpeg)$/.test(filename);
}

function getImageProps(id: string){
  const url = getEdgeUrl(id, { width: 512 });
  // TODO Imports: implement serverside blurhash function
  // Look at `utils/blurhash.ts`
  // return blurHashImage(url);
  return { hash: id, width: 512, height: 512 };
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
