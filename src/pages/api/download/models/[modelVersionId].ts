import type { NextApiRequest, NextApiResponse } from 'next';
import requestIp from 'request-ip';
import * as z from 'zod';
import { clickhouse, Tracker } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import { colorDomains, getRequestDomainColor } from '~/shared/constants/domain.constants';
import { dbRead } from '~/server/db/client';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { getFileForModelVersion } from '~/server/services/file.service';
import { bustUserDownloadsCache } from '~/server/services/user.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { createLimiter } from '~/server/utils/rate-limiting';
import { isRequestFromBrowser } from '~/server/utils/request-helpers';
import { getLoginLink } from '~/utils/login-helpers';

const schema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  type: z.enum(constants.modelFileTypes).optional(),
  format: z.enum(constants.modelFileFormats).optional(),
  size: z.enum(constants.modelFileSizes).optional(),
  fp: z.enum(constants.modelFileFp).optional(),
  quantType: z.enum(constants.modelFileQuantTypes).optional(),
});

const downloadLimiter = createLimiter({
  counterKey: REDIS_SYS_KEYS.DOWNLOAD.COUNT,
  limitKey: REDIS_SYS_KEYS.DOWNLOAD.LIMITS,
  fetchCount: async (userKey) => {
    const isIP = userKey.includes(':') || userKey.includes('.');
    if (!clickhouse) return 0;

    const data = await clickhouse.$query<{ count: number }>`
      SELECT
        COUNT(*) as count
      FROM modelVersionEvents
      WHERE type = 'Download' AND time > subtractHours(now(), 24)
      ${isIP ? `AND ip = '${userKey}'` : `AND userId = ${userKey}`}
    `;
    const count = data[0]?.count ?? 0;
    return count;
  },
});

export default PublicEndpoint(
  async function downloadModel(req: NextApiRequest, res: NextApiResponse) {
    const colorDomain = getRequestDomainColor(req);
    if (colorDomain !== 'blue') return res.redirect(`https://${colorDomains.blue}${req.url}`);

    const isBrowser = isRequestFromBrowser(req);
    function errorResponse(status: number, message: string) {
      res.status(status);
      if (isBrowser) return res.send(message);
      return res.json({ error: message });
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
    const fallbackKey = isAuthed ? 'authed' : 'anon';
    if (await downloadLimiter.hasExceededLimit(userKey, fallbackKey)) {
      return errorResponse(
        429,
        `We've noticed an unusual amount of downloading from your account. Contact support@civitai.com or come back later.`
      );
    }

    // Validate query params
    const queryResults = schema.safeParse(req.query);
    if (!queryResults.success)
      return res
        .status(400)
        .json({ error: z.prettifyError(queryResults.error) ?? 'Invalid modelVersionId' });
    const input = queryResults.data;
    const modelVersionId = input.modelVersionId;
    if (!modelVersionId) return errorResponse(400, 'Missing modelVersionId');

    // Get file
    const fileResult = await getFileForModelVersion({
      ...input,
      user: session?.user,
    });

    if (fileResult.status === 'not-found') return errorResponse(404, 'File not found');
    if (fileResult.status === 'archived')
      return errorResponse(410, 'Model archived, not available for download');
    if (fileResult.status === 'early-access') {
      if (!isBrowser)
        return res.status(403).json({
          error: 'Early Access',
          deadline: fileResult.details.deadline,
          message: 'This asset is in Early Access. You can use Buzz access it now!',
        });
      else return res.redirect(`/model-versions/${modelVersionId}`);
    }
    if (fileResult.status === 'unauthorized') {
      if (!isBrowser)
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'The creator of this asset requires you to be logged in to download it',
        });
      else
        return res.redirect(
          getLoginLink({ reason: 'download-auth', returnUrl: `/model-versions/${modelVersionId}` })
        );
    }

    if (fileResult.status === 'downloads-disabled')
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'The creator of this asset has disabled downloads on this file',
      });

    if (fileResult.status !== 'success') return errorResponse(500, 'Error getting file');

    // Check for misalignment
    for (const key of Object.keys(input)) {
      if (
        input[key as keyof typeof input] &&
        fileResult.metadata[key as keyof typeof fileResult.metadata] &&
        fileResult.metadata[key as keyof typeof fileResult.metadata] !==
          input[key as keyof typeof input]
      )
        return errorResponse(404, 'File not found');
    }

    // Track download
    try {
      if (!fileResult.isDownloadable) {
        throw new Error(
          'File not downloadable. Either a moderator or the resource owner disabled downloads for this version'
        );
      }

      const now = new Date();

      const tracker = new Tracker(req, res);
      await tracker.modelVersionEvent({
        type: 'Download',
        modelId: fileResult.modelId,
        modelVersionId,
        fileId: fileResult.fileId,
        nsfw: fileResult.nsfw,
        earlyAccess: fileResult.inEarlyAccess,
        time: now,
      });

      // Bust the downloads cache so the user sees their download immediately
      if (session?.user?.id) {
        bustUserDownloadsCache(session.user.id).catch(() => {
          // ignore
        });
      }

      // Increment download count for user
      await downloadLimiter.increment(userKey);
    } catch (error) {
      // Don't return error to user
      console.error(error);
    }

    // Redirect to download url
    res.redirect(fileResult.url);
  },
  ['GET']
);
