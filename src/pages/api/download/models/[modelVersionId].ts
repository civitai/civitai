import { ModelModifier, ModelType, Prisma, UserActivityType } from '@prisma/client';
import dayjs from 'dayjs';
import { isEmpty } from 'lodash-es';
import { NextApiRequest, NextApiResponse } from 'next';
import requestIp from 'request-ip';
import { z } from 'zod';

import { env } from '~/env/server.mjs';
import { Tracker } from '~/server/clickhouse/client';
import { ModelFileType, constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { playfab } from '~/server/playfab/client';
import { getEarlyAccessDeadline } from '~/server/utils/early-access-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { RateLimitedEndpoint } from '~/server/utils/rate-limiting';
import { getDownloadUrl } from '~/utils/delivery-worker';
import { getJoinLink } from '~/utils/join-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { filenamize, replaceInsensitive } from '~/utils/string-helpers';

const schema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  type: z.enum(constants.modelFileTypes).optional(),
  format: z.enum(constants.modelFileFormats).optional(),
  size: z.enum(constants.modelFileSizes).optional(),
  fp: z.enum(constants.modelFileFp).optional(),
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

    const { type, modelVersionId, format, size, fp } = queryResults.data;
    if (!modelVersionId) return res.status(400).json({ error: 'Missing modelVersionId' });

    const fileWhere: Prisma.ModelFileWhereInput = {};
    if (type) fileWhere.type = type;

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
            nsfw: true,
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
    const metaJson: FileMetadata = removeEmpty({ format, size, fp }); // Get target file preferences from query params
    const castedFiles = files as Array<
      Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
    >;
    const file =
      type != null || format != null
        ? castedFiles[0]
        : getPrimaryFile(castedFiles, {
            // Prioritize by query params, then by user preferences
            metadata: { ...session?.user?.filePreferences, ...metaJson },
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

      // Increase modelMetric daily download count
      await dbWrite.$executeRaw`
        INSERT INTO "ModelMetricDaily" ("modelId", "modelVersionId", type, date, count)
        VALUES (${modelVersion.model.id}, ${modelVersion.id}, 'donwloads', CURRENT_DATE, 1)
        ON CONFLICT ("modelId", "modelVersionId", type, date) DO UPDATE SET count = "ModelMetricDaily".count + 1;`;

      const tracker = new Tracker(req, res);
      await tracker.modelVersionEvent({
        type: 'Download',
        modelId: modelVersion.model.id,
        modelVersionId: modelVersion.id,
        nsfw: modelVersion.model.nsfw,
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
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`Error downloading file: ${file.url} - ${error.message}`);
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
  // OR if the type is LORA or LoCon
  const shouldKeepFilename =
    modelName.length === 0 || model.type === ModelType.LORA || model.type === ModelType.LoCon;
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
