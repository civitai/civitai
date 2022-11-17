import { NextApiRequest, NextApiResponse } from 'next';
import { getGetUrl } from '~/utils/s3-utils';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default async function downloadTrainingData(req: NextApiRequest, res: NextApiResponse) {
  const keyParts = req.query.key as string[];
  const key = keyParts.join('/');
  console.log({ key });
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId) {
    if (req.headers['content-type'] === 'application/json')
      return res.status(401).json({ error: 'Unauthorized' });
    else return res.redirect(`/login?returnUrl=/api/download/${key}`);
  }

  // Track activity
  // TODO Tracking: Add a new activity type for downloading other keys... @JustMaier

  const { url } = await getGetUrl(key);

  res.redirect(url);
}
