import { NextApiRequest, NextApiResponse } from 'next';
import { getGetUrl } from '~/utils/s3-utils';
import { UserActivityType } from '@prisma/client';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';

export default async function downloadModel(req: NextApiRequest, res: NextApiResponse) {
  const modelVersionId = req.query.modelVersionId as string;
  if (!modelVersionId) {
    res.status(400).json({ error: 'Missing modelVersionId' });
    return;
  }

  const modelVersion = await prisma?.modelVersion.findFirst({
    where: { id: parseInt(modelVersionId) },
    select: { model: { select: { id: true, name: true } }, name: true, url: true },
  });
  if (!modelVersion) {
    res.status(404).json({ error: 'Model not found' });
    return;
  }

  // Track activity
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  await prisma?.userActivity.create({
    data: {
      userId,
      activity: UserActivityType.ModelDownload,
      details: JSON.stringify({ modelId: modelVersion.model.id, modelVersionId }),
    },
  });

  const { url } = await getGetUrl(modelVersion.url);

  res.redirect(url);
}
