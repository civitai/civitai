import { NextApiRequest, NextApiResponse } from 'next';
import { getGetUrl } from '~/utils/s3-utils';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { dbWrite, dbRead } from '~/server/db/client';
import { UserActivityType } from '@prisma/client';
import requestIp from 'request-ip';

export default async function downloadTrainingData(req: NextApiRequest, res: NextApiResponse) {
  // Get ip so that we can block exploits we catch
  const ip = requestIp.getClientIp(req);
  const blacklist = (
    ((await dbRead.keyValue.findUnique({ where: { key: 'ip-blacklist' } }))?.value as string) ?? ''
  ).split(',');
  if (ip && blacklist.includes(ip)) return res.status(403).json({ error: 'Forbidden' });

  const keyParts = req.query.key as string[];
  const key = keyParts.join('/');
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId) {
    if (req.headers['content-type'] === 'application/json')
      return res.status(401).json({ error: 'Unauthorized' });
    else return res.redirect(`/login?returnUrl=/api/download/${key}`);
  }

  // Track download
  try {
    await dbWrite.userActivity.create({
      data: {
        userId,
        activity: UserActivityType.OtherDownload,
        details: {
          key,
          // Just so we can catch exploits
          ...(!userId
            ? {
                ip,
                userAgent: req.headers['user-agent'],
              }
            : {}), // You'll notice we don't include this for authed users...
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Invalid database operation', cause: error });
  }

  const { url } = await getGetUrl(key);

  res.redirect(url);
}
