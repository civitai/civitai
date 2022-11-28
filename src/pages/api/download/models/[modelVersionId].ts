import { NextApiRequest, NextApiResponse } from 'next';
import { getGetUrl } from '~/utils/s3-utils';
import { ModelFileType, ModelType, UserActivityType } from '@prisma/client';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { prisma } from '~/server/db/client';
import { filenamize } from '~/utils/string-helpers';
import { z } from 'zod';
import { env } from '~/env/server.mjs';

const schema = z.object({ modelVersionId: z.preprocess((val) => Number(val), z.number()) });

export default async function downloadModel(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res
      .status(400)
      .json({ error: `Invalid id: ${results.error.flatten().fieldErrors.modelVersionId}` });

  if (!results.data.modelVersionId)
    return res.status(400).json({ error: 'Missing modelVersionId' });

  const modelVersion = await prisma.modelVersion.findFirst({
    where: { id: results.data.modelVersionId },
    select: {
      id: true,
      model: { select: { id: true, name: true, type: true } },
      name: true,
      trainedWords: true,
      files: { where: { type: ModelFileType.Model }, select: { url: true, name: true } },
    },
  });
  if (!modelVersion) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  // Let people download without an acct
  // TODO make this an ENV option
  /* if (!userId) {
    if (req.headers['content-type'] === 'application/json')
      return res.status(401).json({ error: 'Unauthorized' });
    else return res.redirect(`/login?returnUrl=/models/${modelVersion.model.id}`);
  }*/

  // Track activity
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
  // Handle files that are still on other services
  if (!modelFile.url.includes(env.S3_UPLOAD_BUCKET)) {
    res.redirect(modelFile.url);
  } else {
    const ext = modelFile.name.split('.').pop();
    let fileName = modelFile.name;
    if (modelVersion.model.type === ModelType.TextualInversion) {
      const trainedWord = modelVersion.trainedWords[0] ?? modelVersion.model.name;
      fileName = `${trainedWord}.pt`;
    } else
      fileName = `${filenamize(modelVersion.model.name)}_${filenamize(modelVersion.name)}.${ext}`;
    const { url } = await getGetUrl(modelFile.url, { fileName });
    res.redirect(url);
  }
}
