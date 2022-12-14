import { NextApiRequest, NextApiResponse } from 'next';
import { getGetUrl } from '~/utils/s3-utils';
import {
  ModelFile,
  ModelFileFormat,
  ModelFileType,
  ModelType,
  UserActivityType,
} from '@prisma/client';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { prisma } from '~/server/db/client';
import { filenamize } from '~/utils/string-helpers';
import { z } from 'zod';
import { env } from '~/env/server.mjs';

const schema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  type: z.nativeEnum(ModelFileType).optional(),
  format: z.nativeEnum(ModelFileFormat).optional(),
});

// /api/download/train-data/[modelVersionId]  => /api/download/models/[modelVersionId]?type=TrainingData
// /api/download/models/[modelVersionId] (returns primary file)
// /api/download/models/[modelVersionId]?type=TrainingData
// /api/download/models/[modelVersionId]?type=Model&format=SafeTensors

export default async function downloadModel(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res
      .status(400)
      .json({ error: `Invalid id: ${results.error.flatten().fieldErrors.modelVersionId}` });

  const { type, modelVersionId, format } = results.data;
  if (!modelVersionId) return res.status(400).json({ error: 'Missing modelVersionId' });

  // TODO Fix Type: @Manuel
  const fileWhere: any = {};
  if (type) fileWhere.type = type;
  if (format) fileWhere.format = format;
  if (!type && !format) fileWhere.isPrimary = true;

  const modelVersion = await prisma.modelVersion.findFirst({
    where: { id: modelVersionId },
    select: {
      id: true,
      model: { select: { id: true, name: true, type: true } },
      name: true,
      trainedWords: true,
      files: { where: fileWhere, select: { url: true, name: true, type: true } },
    },
  });
  if (!modelVersion) return res.status(404).json({ error: 'Model not found' });
  if (!modelVersion.files.length) return res.status(404).json({ error: 'Model file not found' });

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!env.UNAUTHENTICATED_DOWNLOAD && !userId) {
    if (req.headers['content-type'] === 'application/json')
      return res.status(401).json({ error: 'Unauthorized' });
    else return res.redirect(`/login?returnUrl=/models/${modelVersion.model.id}`);
  }

  // Track download
  try {
    await prisma.userActivity.create({
      data: {
        userId,
        activity: UserActivityType.ModelDownload,
        details: { modelId: modelVersion.model.id, modelVersionId: modelVersion.id },
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Invalid database operation', cause: error });
  }

  const [modelFile] = modelVersion.files;
  let fileName = modelFile.name;
  if (modelVersion.model.type === ModelType.TextualInversion) {
    const trainedWord = modelVersion.trainedWords[0];
    if (trainedWord) fileName = `${trainedWord}.pt`;
  } else if (modelFile.type === ModelFileType.TrainingData) {
    fileName = `${filenamize(modelVersion.model.name)}_${filenamize(
      modelVersion.name
    )}_trainingData.zip`;
  } else {
    let fileSuffix = '';
    if (fileName.includes('-inpainting')) fileSuffix = '-inpainting';

    const ext = modelFile.name.split('.').pop();
    fileName = `${filenamize(modelVersion.model.name)}_${filenamize(
      modelVersion.name
    )}${fileSuffix}.${ext}`;
  }

  const { url } = await getGetUrl(modelFile.url, { fileName });
  res.redirect(url);
}
