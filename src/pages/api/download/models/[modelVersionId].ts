import { NextApiRequest, NextApiResponse } from 'next';
import requestIp from 'request-ip';
import { z } from 'zod';

import { clickhouse, Tracker } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { playfab } from '~/server/playfab/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { getFileForModelVersion } from '~/server/services/file.service';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { RateLimitedEndpoint } from '~/server/utils/rate-limiting';
import { getJoinLink } from '~/utils/join-helpers';
import { getLoginLink } from '~/utils/login-helpers';

const schema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  type: z.enum(constants.modelFileTypes).optional(),
  format: z.enum(constants.modelFileFormats).optional(),
  size: z.enum(constants.modelFileSizes).optional(),
  fp: z.enum(constants.modelFileFp).optional(),
});

export default RateLimitedEndpoint(
  async function downloadModel(req: NextApiRequest, res: NextApiResponse) {
    function errorResponse(status: number, message: string) {
      res.status(status);
      if (req.headers['content-type'] === 'application/json') return res.json({ error: message });
      else return res.send(message);
    }

    // Get ip so that we can block exploits we catch
    const ip = requestIp.getClientIp(req);
    const ipBlacklist = (
      ((await dbRead.keyValue.findUnique({ where: { key: 'ip-blacklist' } }))?.value as string) ??
      ''
    ).split(',');
    if (ip && ipBlacklist.includes(ip)) return errorResponse(403, 'Forbidden');

    // Check if user is blacklisted
    const session = await getServerAuthSession({ req, res });
    if (!!session?.user) {
      const userBlacklist = (
        ((await dbRead.keyValue.findUnique({ where: { key: 'user-blacklist' } }))
          ?.value as string) ?? ''
      ).split(',');
      if (userBlacklist.includes(session.user.id.toString()))
        return errorResponse(403, 'Forbidden');
    }

    // Check if user has a concerning number of downloads
    const isAuthed = !!session?.user;
    const userKey = session?.user?.id?.toString() ?? ip;
    if (!userKey) return errorResponse(403, 'Forbidden');
    const downloadCountStr = await redis.hGet(REDIS_KEYS.DOWNLOAD.COUNT, userKey);
    if (downloadCountStr) {
      const downloadCount = Number(downloadCountStr);
      const fallbackKey = isAuthed ? 'authed' : 'anon';
      const downloadLimit = await redis.hmGet(REDIS_KEYS.DOWNLOAD.LIMITS, [userKey, fallbackKey]);
      const limit = Number(downloadLimit?.[0] ?? downloadLimit?.[1] ?? 0);
      if (limit !== 0 && downloadCount > limit) {
        return errorResponse(
          429,
          `We've noticed an unusual amount of downloading from your account. Contact support@civitai.com or come back later.`
        );
      }
    }

    // Validate query params
    const queryResults = schema.safeParse(req.query);
    if (!queryResults.success)
      return res
        .status(400)
        .json({ error: `Invalid id: ${queryResults.error.flatten().fieldErrors.modelVersionId}` });
    const input = queryResults.data;
    const modelVersionId = input.modelVersionId;
    if (!modelVersionId) return errorResponse(400, 'Missing modelVersionId');
    const isJsonRequest = req.headers['content-type'] === 'application/json';

    // Get file
    const fileResult = await getFileForModelVersion({
      ...input,
      user: session?.user,
    });

    if (fileResult.status === 'not-found') return errorResponse(404, 'File not found');
    if (fileResult.status === 'archived')
      return errorResponse(410, 'Model archived, not available for download');
    if (fileResult.status === 'early-access') {
      if (isJsonRequest)
        return res
          .status(403)
          .json({ error: 'Early Access', deadline: fileResult.details.deadline });
      else
        return res.redirect(
          getJoinLink({ reason: 'early-access', returnUrl: `/model-versions/${modelVersionId}` })
        );
    }
    if (fileResult.status === 'unauthorized') {
      if (isJsonRequest) return res.status(401).json({ error: 'Unauthorized' });
      else
        return res.redirect(
          getLoginLink({ reason: 'download-auth', returnUrl: `/model-versions/${modelVersionId}` })
        );
    }
    if (fileResult.status !== 'success') return errorResponse(500, 'Error getting file');

    // Track download
    try {
      const now = new Date();

      const tracker = new Tracker(req, res);
      await tracker.modelVersionEvent({
        type: 'Download',
        modelId: fileResult.modelId,
        modelVersionId,
        nsfw: fileResult.nsfw,
        time: now,
      });

      const userId = session?.user?.id;
      if (userId) {
        await dbWrite.$executeRaw`
          -- Update user history
          INSERT INTO "DownloadHistory" ("userId", "modelVersionId", "downloadAt", hidden)
          VALUES (${userId}, ${modelVersionId}, ${now}, false)
          ON CONFLICT ("userId", "modelVersionId") DO UPDATE SET "downloadAt" = excluded."downloadAt"
        `;

        await playfab.trackEvent(userId, {
          eventName: 'user_download_model',
          modelId: fileResult.modelId,
          modelVersionId,
        });
      }

      // Increment download count for user
      if (downloadCountStr) {
        await redis.hIncrBy(REDIS_KEYS.DOWNLOAD.COUNT, userKey, 1);
      } else {
        await fetchDownloadCount(userKey);
      }
    } catch (error) {
      // Don't return error to user
      console.error(error);
    }

    // Redirect to download url
    res.redirect(fileResult.url);
  },
  ['GET'],
  'download'
);

async function fetchDownloadCount(userKey: string) {
  const res = await clickhouse?.query({
    query: `
      SELECT SUM(count) as count
      FROM daily_user_downloads
      WHERE userKey = '${userKey}' AND createdDate > toStartOfDay((subtractDays(now(), 7)));
    `,
    format: 'JSONEachRow',
  });

  const data = (await res?.json<{ count: number }[]>()) ?? [];
  const count = data[0]?.count ?? 0;
  await redis.hSet(REDIS_KEYS.DOWNLOAD.COUNT, userKey, count);
}
