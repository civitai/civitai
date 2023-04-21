import { ModelModifier, ModelType, Prisma, UserActivityType } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { env } from '~/env/server.mjs';
import { dbWrite, dbRead } from '~/server/db/client';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { filenamize, replaceInsensitive } from '~/utils/string-helpers';
import requestIp from 'request-ip';
import { constants, ModelFileType } from '~/server/common/constants';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getEarlyAccessDeadline } from '~/server/utils/early-access-helpers';
import { getJoinLink } from '~/utils/join-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { RateLimitedEndpoint } from '~/server/utils/rate-limiting';
import { getDownloadUrl } from '~/utils/delivery-worker';
import { playfab } from '~/server/playfab/client';
import { clickhouse } from '~/server/clickhouse/client';
import { formatDate } from '~/utils/date-helpers';

const schema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  type: z.enum(constants.modelFileTypes).optional(),
  format: z.enum(constants.modelFileFormats).optional(),
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

export default RateLimitedEndpoint(
  async function downloadModel(req: NextApiRequest, res: NextApiResponse) {
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
        .json({ error: `Invalid id: ${queryResults.error.flatten().fieldErrors.modelVersionId}` });

    const { type, modelVersionId, format } = queryResults.data;
    if (!modelVersionId) return res.status(400).json({ error: 'Missing modelVersionId' });

    const fileWhere: Prisma.ModelFileWhereInput = {};
    if (type) fileWhere.type = type;
    if (format) fileWhere.metadata = { path: ['format'], equals: format };

    const modelVersion = await dbRead.modelVersion.findFirst({
      where: { id: modelVersionId },
      select: {
        id: true,
        model: {
          select: {
            id: true,
            name: true,
            type: true,
            publishedAt: true,
            status: true,
            userId: true,
            mode: true,
          },
        },
        name: true,
        trainedWords: true,
        earlyAccessTimeFrame: true,
        createdAt: true,
        files: {
          where: fileWhere,
          select: {
            id: true,
            url: true,
            name: true,
            type: true,
            metadata: true,
            hashes: { select: { hash: true }, where: { type: 'SHA256' } },
          },
        },
      },
    });
    if (!modelVersion) return notFound(req, res, 'Model not found');

    const { files } = modelVersion;
    const castedFiles = files as Array<
      Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
    >;
    const file =
      type != null || format != null
        ? castedFiles[0]
        : getPrimaryFile(castedFiles, {
            metadata: session?.user?.filePreferences,
          });
    if (!file) return notFound(req, res, 'Model file not found');

    // Handle non-published models
    const isMod = session?.user?.isModerator;
    const userId = session?.user?.id;
    const archived = modelVersion.model.mode === ModelModifier.Archived;
    if (archived)
      return res.status(410).json({ error: 'Model archived, not available for download' });

    const canDownload =
      isMod ||
      modelVersion?.model?.status === 'Published' ||
      (userId && modelVersion?.model?.userId === userId);
    if (!canDownload) return notFound(req, res, 'Model not found');

    // Handle unauthenticated downloads
    if (!env.UNAUTHENTICATED_DOWNLOAD && !userId) {
      if (req.headers['content-type'] === 'application/json')
        return res.status(401).json({ error: 'Unauthorized' });
      else
        return res.redirect(
          getLoginLink({ reason: 'download-auth', returnUrl: `/models/${modelVersion.model.id}` })
        );
    }

    // Handle early access
    if (!session?.user?.tier && !session?.user?.isModerator) {
      const earlyAccessDeadline = getEarlyAccessDeadline({
        versionCreatedAt: modelVersion.createdAt,
        publishedAt: modelVersion.model.publishedAt,
        earlyAccessTimeframe: modelVersion.earlyAccessTimeFrame,
      });
      const inEarlyAccess = new Date() < earlyAccessDeadline;
      if (inEarlyAccess) {
        if (req.headers['content-type'] === 'application/json')
          return res.status(403).json({ error: 'Early Access', deadline: earlyAccessDeadline });
        else
          return res.redirect(
            getJoinLink({ reason: 'early-access', returnUrl: `/models/${modelVersion.model.id}` })
          );
      }
    }

    // Track download
    try {
      // Insert into clickhouse
      // Do not await as we do not guarantee uptime of clickhouse
      clickhouse.insert({
        table: 'downloads',
        values: [
          {
            userId,
            date: formatDate(new Date(), 'YYYY-MM-DD HH:mm:ss'),
            modelId: modelVersion.model.id,
            modelVersionId: modelVersion.id,
          },
        ],
        format: 'JSONEachRow',
      });

      await dbWrite.userActivity.create({
        data: {
          userId,
          activity: UserActivityType.ModelDownload,
          details: {
            modelId: modelVersion.model.id,
            modelVersionId: modelVersion.id,
            fileId: file.id,
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

      if (userId)
        await playfab.trackEvent(userId, {
          eventName: 'user_download_model',
          modelId: modelVersion.model.id,
          modelVersionId: modelVersion.id,
        });
    } catch (error) {
      return res.status(500).json({ error: 'Invalid database operation', cause: error });
    }

    const fileName = getDownloadFilename({ model: modelVersion.model, modelVersion, file });
    try {
      const { url } = await getDownloadUrl(file.url, fileName);
      res.redirect(url);
    } catch (err: any) {
      console.error(`Error downloading file: ${file.url} - ${err.message}`);
      return res.status(500).json({ error: 'Error downloading file' });
    }
  },
  ['GET'],
  'download'
);

export function getDownloadFilename({
  model,
  modelVersion,
  file,
}: {
  model: { name: string; type: ModelType };
  modelVersion: { name: string; trainedWords: string[] };
  file: { name: string; type: ModelFileType | string };
}) {
  let fileName = file.name;
  const modelName = filenamize(model.name);
  let versionName = filenamize(replaceInsensitive(modelVersion.name, modelName, ''));

  // If the model name is empty (due to unsupported characters), we should keep the filename as is
  const shouldKeepFilename = modelName.length === 0;
  if (shouldKeepFilename) return fileName;

  const ext = file.name.split('.').pop();
  if (!constants.modelFileTypes.includes(file.type as ModelFileType)) return file.name;
  const fileType = file.type as ModelFileType;

  if (fileType === 'Training Data') {
    fileName = `${modelName}_${versionName}_trainingData.zip`;
  } else if (model.type === ModelType.TextualInversion) {
    const trainedWord = modelVersion.trainedWords[0];
    let fileSuffix = '';
    if (fileType === 'Negative') fileSuffix = '-neg';

    if (trainedWord) fileName = `${trainedWord}${fileSuffix}.${ext}`;
  } else if (fileType !== 'VAE') {
    let fileSuffix = '';
    if (fileName.toLowerCase().includes('-inpainting')) {
      versionName = versionName.replace(/_?inpainting/i, '');
      fileSuffix = '-inpainting';
    } else if (fileName.toLowerCase().includes('.instruct-pix2pix')) {
      versionName = versionName.replace(/_?instruct|-?pix2pix/gi, '');
      fileSuffix = '.instruct-pix2pix';
    } else if (fileType === 'Text Encoder') fileSuffix = '_txt';

    fileName = `${modelName}_${versionName}${fileSuffix}.${ext}`;
  }
  return fileName;
}
