import type { NextApiRequest, NextApiResponse } from 'next';
import requestIp from 'request-ip';
import * as z from 'zod';

import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { resolveDownloadUrl } from '~/utils/delivery-worker';
import { getLoginLink } from '~/utils/login-helpers';
import { getFileWithPermission } from '~/server/services/file.service';
import { Tracker } from '~/server/clickhouse/client';
import { handleLogError } from '~/server/utils/errorHandling';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  fileId: z.preprocess((val) => Number(val), z.number()),
});

const forbidden = (req: NextApiRequest, res: NextApiResponse) => {
  res.status(403);
  if (req.headers['content-type'] === 'application/json') return res.json({ error: 'Forbidden' });
  else return res.send('Forbidden');
};

const notFound = (req: NextApiRequest, res: NextApiResponse, message = 'Not Found') => {
  res.status(404);
  if (req.headers['content-type'] === 'application/json') return res.json({ error: message });
  else return res.send(message);
};

export default PublicEndpoint(
  async function downloadAttachment(req: NextApiRequest, res: NextApiResponse) {
    // Get ip so that we can block exploits we catch
    const ip = requestIp.getClientIp(req);
    const ipBlacklist = (
      ((await dbRead.keyValue.findUnique({ where: { key: 'ip-blacklist' } }))?.value as string) ??
      ''
    ).split(',');
    if (ip && ipBlacklist.includes(ip)) return forbidden(req, res);

    const session = await getServerAuthSession({ req, res });
    if (!!session?.user) {
      const userBlacklist = (
        ((await dbRead.keyValue.findUnique({ where: { key: 'user-blacklist' } }))
          ?.value as string) ?? ''
      ).split(',');
      if (userBlacklist.includes(session.user.id.toString())) return forbidden(req, res);
    }

    const queryResults = schema.safeParse(req.query);
    if (!queryResults.success)
      return res
        .status(400)
        .json({ error: z.prettifyError(queryResults.error) ?? 'Invalid fileId' });

    const { fileId } = queryResults.data;

    const file = await getFileWithPermission({
      fileId,
      userId: session?.user?.id,
      isModerator: session?.user?.isModerator,
    });

    if (!file) return notFound(req, res, 'File not found');

    // Handle unauthenticated downloads
    const userId = session?.user?.id;
    if (!env.UNAUTHENTICATED_DOWNLOAD && !userId) {
      if (req.headers['content-type'] === 'application/json')
        return res.status(401).json({ error: 'Unauthorized' });
      else return res.redirect(getLoginLink({ reason: 'download-auth', returnUrl: req.url }));
    }

    // TODO.articles: Track download
    // try {
    //   const now = new Date();
    //   await dbWrite.userActivity.create({
    //     data: {
    //       userId,
    //       activity: UserActivityType.OtherDownload,
    //       createdAt: now,
    //       details: {
    //         fileId: fileId,
    //         // Just so we can catch exploits
    //         ...(!userId
    //           ? {
    //               ip,
    //               userAgent: req.headers['user-agent'],
    //             }
    //           : {}), // You'll notice we don't include this for authed users...
    //       },
    //     },
    //   });

    //   const tracker = new Tracker(req, res);
    //   await tracker.userActivity({
    //     type: 'Download',
    //     modelId: file.model.id,
    //     modelVersionId: file.id,
    //     nsfw: file.model.nsfw,
    //     time: now,
    //   });

    // } catch (error) {
    //   return res.status(500).json({ error: 'Invalid database operation', cause: error });
    // }

    try {
      const { url } = await resolveDownloadUrl(fileId, file.url, file.name);

      const tracker = new Tracker(req, res);
      tracker
        .file({ type: 'Download', entityId: file.entityId, entityType: file.entityType })
        .catch(handleLogError);

      res.redirect(url);
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`Error downloading file: ${file.url} - ${error.message}`);
      return res.status(500).json({ error: 'Error downloading file' });
    }
  },
  ['GET']
);
