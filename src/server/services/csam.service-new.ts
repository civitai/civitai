import type { CsamReport } from '~/shared/utils/prisma/models';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  CreateCsamReportSchema,
  GetImageResourcesOutput,
  CsamReportFormOutput,
} from '~/server/schema/csam.schema';
import { csamCapabilitiesDictionary, csamContentsDictionary } from '~/server/schema/csam.schema';
import { clickhouse } from '~/server/clickhouse/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { isDefined } from '~/utils/type-guards';
import { blobToFile, fetchBlob, fetchBlobAsFile } from '~/utils/file-utils';
import { S3Client } from '@aws-sdk/client-s3';
import { env } from '~/env/server';
import fsAsync from 'fs/promises';
import fs from 'fs';
import archiver from 'archiver';
import stream from 'stream';
import { Upload } from '@aws-sdk/lib-storage';
import * as z from 'zod';
import plimit from 'p-limit';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import type { PaginationInput } from '~/server/schema/base.schema';
import type { Ncmec } from '~/server/http/ncmec/ncmec.schema';
import { isDev, isProd } from '~/env/other';
import { unzipTrainingData } from '~/utils/training';
import { getFileForModelVersion } from '~/server/services/file.service';
import nodeFetch from 'node-fetch';
import JSZip from 'jszip';
import { MAX_POST_IMAGES_WIDTH } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { Report } from '@civitai/cybertipline-tools';
import {
  Client,
  Environment,
  FileDetailType,
  IncidentType,
  IPEventName,
} from '@civitai/cybertipline-tools';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { getConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';

const cybertipClient = new Client({
  environment: isDev ? Environment.Testing : Environment.Production,
  credentials: {
    username: env.NCMEC_USERNAME,
    password: env.NCMEC_PASSWORD,
  },
});

type CsamReportUploadProps = {
  fileId?: string | undefined;
  hash?: string | undefined;
};

type CsamReportImage = {
  id: number;
  fileAnnotations?: Ncmec.FileAnnotationsSchema;
} & CsamReportUploadProps;

type CsamReportUserActivity = {
  type: 'Login' | 'Registration' | 'Upload' | 'Unknown';
  ip: string;
  time: string;
  details?: {
    type: 'post' | 'model-version';
    id: number;
  };
};

type CsamReportTrainingData = {
  filename: string;
} & CsamReportUploadProps;

type CsamReportGeneratedImageData = {
  url: string;
} & CsamReportUploadProps;

type CsamReportGeneratedImages = {
  blobs: CsamReportGeneratedImageData[];
  jobId: string;
  prompt?: string;
  negativePrompt?: string;
  resources?: string[];
  dateTime?: Date;
};

type CsamReportDetails = CsamReportFormOutput & {
  trainingData?: CsamReportTrainingData[];
  userActivity?: CsamReportUserActivity[];
  generatedImages?: CsamReportGeneratedImages[];
};

export type CsamReportProps = Omit<CsamReport, 'details' | 'images'> & {
  details: CsamReportDetails;
  images: CsamReportImage[];
};

const baseDir = `${isProd && env.DIRNAME ? env.DIRNAME : process.cwd()}/csam`;

export async function getImageResources({ ids }: GetImageResourcesOutput) {
  return await dbRead.imageResourceHelper.findMany({
    where: { imageId: { in: ids }, modelId: { not: null } },
    select: {
      modelId: true,
      modelName: true,
      modelVersionId: true,
      modelVersionName: true,
      imageId: true,
    },
  });
}

export async function createCsamReport({
  reportedById,
  userId,
  imageIds = [],
  details,
  type,
}: CreateCsamReportSchema & { reportedById: number }) {
  const isInternalReport = userId === -1;
  const reportedUserId = !isInternalReport ? userId : undefined;

  return await dbWrite.csamReport.create({
    data: {
      userId: reportedUserId,
      reportedById,
      details,
      type,
      //map imageIds to objects so that we can append additional data to them later
      images: imageIds?.map((id) => ({ id })) ?? [],
    },
  });
}

export async function getCsamReportsPaged({ limit, page }: PaginationInput) {
  const { take, skip } = getPagination(limit, page);

  const reports = await dbRead.csamReport.findMany({ take, skip, orderBy: { createdAt: 'desc' } });
  const usersIds = [
    ...new Set(reports.flatMap((x) => [x.reportedById, x.userId]).filter(isDefined)),
  ];
  const users = await dbRead.user.findMany({
    where: { id: { in: usersIds } },
    select: { id: true, username: true },
  });
  const items = reports.map((report) => ({
    ...report,
    user: users.find((x) => x.id === report.userId),
    reportedBy: users.find((x) => x.id === report.reportedById),
  }));
  const count = await dbRead.csamReport.count();
  return getPagingData({ items, count }, take, page);
}

export async function getCsamReportStats() {
  const [unreported, unarchived, unremoved] = await Promise.all([
    dbRead.csamReport.count({ where: { reportSentAt: null } }),
    dbRead.csamReport.count({ where: { reportSentAt: { not: null }, archivedAt: null } }),
    dbRead.csamReport.count({
      where: {
        reportSentAt: { not: null },
        archivedAt: { not: null },
        userId: { not: null },
        contentRemovedAt: null,
      },
    }),
  ]);

  return { unreported, unarchived, unremoved };
}

export async function getCsamsToReport() {
  const data = await dbRead.csamReport.findMany({ where: { reportSentAt: null } });
  return data as unknown as CsamReportProps[];
}

export async function getCsamsToArchive() {
  const data = await dbRead.csamReport.findMany({
    where: { reportSentAt: { not: null }, archivedAt: null },
  });
  return data as unknown as CsamReportProps[];
}

export async function getCsamsToRemoveContent() {
  const data = await dbRead.csamReport.findMany({
    where: {
      reportSentAt: { not: null },
      archivedAt: { not: null },
      userId: { not: null },
      contentRemovedAt: null,
    },
  });
  return data as unknown as CsamReportProps[];
}

async function getReportingUser(id: number) {
  return await dbRead.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, isModerator: true },
  });
}

async function getReportedUser(id: number) {
  return await dbRead.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, username: true },
  });
}

async function getModelVersions(versionIds?: number[]) {
  if (!versionIds?.length) return [];
  return await dbRead.modelVersion.findMany({
    where: { id: { in: versionIds } },
    select: { id: true, createdAt: true, name: true, model: { select: { id: true, name: true } } },
  });
}

async function deleteCsamReport(reportId: number) {
  await dbWrite.csamReport.delete({ where: { id: reportId } });
}

async function getImages(imageIds?: number[]) {
  if (!imageIds?.length) return [];
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: {
      id: true,
      url: true,
      createdAt: true,
      name: true,
      type: true,
      meta: true,
      post: {
        select: { modelVersionId: true },
      },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });
  return images.map(({ post, ...image }) => ({ ...image, modelVersionId: post?.modelVersionId }));
}

export async function getUserIpInfo(report: Partial<CsamReportProps>) {
  if (!report.userId || !report.type || !clickhouse) return [];

  let captureEvents: CsamReportUserActivity[] = await clickhouse.$query<{
    ip: string;
    type: 'Login' | 'Registration';
    time: string;
  }>(`
    SELECT
      ip,
      type,
      time
    FROM userActivities
    WHERE userId = ${report.userId} AND (type = 'Registration' OR type = 'Login')
  `);

  switch (report.type) {
    case 'Image':
      const imageIds = report.images?.map((x) => x.id);
      if (!imageIds) break;
      const images = await dbRead.image.findMany({
        where: { id: { in: imageIds } },
        select: { postId: true },
      });
      const postIds = [...new Set(images.map((x) => x.postId))].filter(isDefined);
      if (postIds.length) {
        const postCaptureEvents: CsamReportUserActivity[] = (
          await clickhouse.$query<{ ip: string; postId: number; time: string }>(`
          SELECT
            ip,
            postId,
            time
          FROM posts
          WHERE userId = ${report.userId} AND type = 'Create' AND postId IN [${postIds.join(',')}]
        `)
        ).map(({ postId, ...data }) => ({
          ...data,
          type: 'Upload',
          details: { type: 'post', id: postId },
        }));
        captureEvents = captureEvents.concat(postCaptureEvents);
      }
      break;
    case 'TrainingData':
      const modelVersionId = report.details?.modelVersionIds?.[0];
      if (modelVersionId) {
        const modelVersionCaptureEvents: CsamReportUserActivity[] = (
          await clickhouse.$query<{ ip: string; modelVersionId: number; time: string }>(`
          SELECT
            ip,
            modelVersionId,
            time
          FROM modelVersionEvents
          WHERE userId = ${report.userId} AND type = 'Create' AND modelVersionId = ${modelVersionId}
        `)
        ).map(({ modelVersionId, ...data }) => ({
          ...data,
          type: 'Upload',
          details: { type: 'model-version', id: modelVersionId },
        }));
        captureEvents = captureEvents.concat(modelVersionCaptureEvents);
      }
      break;
  }

  return captureEvents
    .map((data) => {
      const res = z.ipv4().or(z.ipv6()).safeParse(data.ip);
      return res.success ? data : null;
    })
    .filter(isDefined);
}

async function constructReportPayload({
  reportedById,
  userId,
  reportDetails,
  modelVersions,
  incidentDateTime,
}: {
  reportedById: number;
  userId: number | null;
  reportDetails: CsamReportDetails;
  modelVersions: AsyncReturnType<typeof getModelVersions>;
  incidentDateTime: Date;
}) {
  const reportingUser = await getReportingUser(reportedById);
  const reportedUser = userId ? await getReportedUser(userId) : null;
  // const ipAddresses = userId ? await getUserIpInfo({ userId }) : null;

  const additionalInfo: string[] = [];

  const { minorDepiction, capabilities, contents, userActivity } = reportDetails;

  const section2 = modelVersions.length
    ? `\nModels format: [modelId:modelName]:[modelVersionId:modelVersionName]\n${modelVersions
        .map(({ id, name, model }) => `  - [${model.id}:${model.name}]:[${id}:${name}]\n`)
        .join('')}
    `
    : '';

  if (reportedUser) {
    if (minorDepiction === 'non-real')
      additionalInfo.push(
        `${reportedUser.username as string} (${
          reportedUser.id
        }), appears to have used the following models' image/video generation and/or editing capabilities to produce sexual content depicting non-real minors.`
      );
    else if (minorDepiction === 'real')
      additionalInfo.push(
        `${reportedUser.username as string} (${
          reportedUser.id
        }), appears to have used the following models' image/video editing capabilities to modify images of real minors for the apparent purpose of sexualizing them.`
      );

    additionalInfo.push(section2);
  } else {
    additionalInfo.push(`
      The images/videos in this report were unintentionally and inadvertently generated or manipulated, during testing that is part of Civitai's trust and safety program, by the following models, one or more artificial intelligence-powered image/video generator.
      `);
    additionalInfo.push(section2);

    if (capabilities?.length) {
      additionalInfo.push(`The aforementioned model(s) can do the following:
        ${capabilities
          .map((key) => {
            const capability = csamCapabilitiesDictionary[key];
            return capability ? `  - ${capability}\n` : undefined;
          })
          .filter(isDefined)
          .join('')}
        `);
    }
  }

  if (contents?.length) {
    additionalInfo.push(`The images/videos in this report may involve:
    ${contents
      .map((key) => {
        const content = csamContentsDictionary[key];
        return content ? `  - ${content}\n` : undefined;
      })
      .filter(isDefined)
      .join('')}
    `);
  }

  additionalInfo.push('All evidence in this report should be independently verified.');

  return {
    report: {
      incidentSummary: {
        incidentType: 'Child Pornography (possession, manufacture, and distribution)',
        incidentDateTime: incidentDateTime.toISOString(),
      },
      reporter: {
        reportingPerson: {
          firstName: reportingUser?.name,
          email: reportingUser?.email,
        },
        contactPerson: {
          email: 'report@civitai.com',
        },
      },
      personOrUserReported: userId
        ? removeEmpty({
            espIdentifier: userId,
            screenName: reportedUser?.username,
            // personOrUserReportedPerson: {
            //   firstName: reportedUser?.name,
            //   email: reportedUser?.email,
            // },
            ipCaptureEvent: userActivity?.map((activity) => {
              const [year, month, day, hour, minute, second] = activity.time
                .split(/[-: ]/)
                .map(Number);
              return {
                ipAddress: activity.ip,
                eventName: activity.type,
                dateTime: new Date(
                  Date.UTC(year, month - 1, day, hour, minute, second)
                ).toISOString(),
              };
            }),
            additionalInfo: `
              Email: ${reportedUser?.email ?? 'NA'}
              Name: ${reportedUser?.name ?? 'NA'}
            `,
          })
        : undefined,
      additionalInfo: `${additionalInfo
        .join('\n\n')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim()}`,
    },
  };
}

export async function processCsamReport(report: CsamReportProps) {
  const status = await cybertipClient.getStatus();
  if (status.data.responseCode !== 0) return;

  switch (report.type) {
    case 'Image':
      return await reportImages(report);
    case 'GeneratedImage':
      return await reportGenerationData(report);
    case 'TrainingData':
      return await reportTrainingData(report);
  }
}

async function getInitialReportData(report: CsamReportProps) {
  const reportingUser = await getReportingUser(report.reportedById);
  const reportedUser = report.userId ? await getReportedUser(report.userId) : undefined;
  if (!reportingUser || !reportedUser) return await deleteCsamReport(report.id);

  const userActivity = await getUserIpInfo(report);

  return {
    incidentSummary: {
      incidentType: IncidentType.ChildPornography,
      incidentDateTime: report.createdAt,
    },
    reporter: {
      reportingPerson: {
        email: reportingUser.email ? [{ email: reportingUser.email }] : [],
        firstName: reportingUser.name ?? undefined,
      },
      contactPerson: {
        email: [{ email: 'report@civitai.com' }],
      },
    },
    personOrUserReported: {
      espIdentifier: reportedUser.id.toString(),
      screenName: reportedUser.username ?? undefined,
      ipCaptureEvent: userActivity?.map((activity) => {
        const [year, month, day, hour, minute, second] = activity.time.split(/[-: ]/).map(Number);
        return {
          ipAddress: activity.ip,
          eventName: IPEventName[activity.type],
          dateTime: new Date(Date.UTC(year, month - 1, day, hour, minute, second)),
        };
      }),
      additionalInfo: reportedUser.email ? `Email: ${reportedUser.email}` : undefined,
    },
  } satisfies Report;
}

async function reportImages(report: CsamReportProps) {
  const initialReport = await getInitialReportData(report);
  if (!initialReport) return;

  const images = await getImages(report.images.map((x) => x.id));
  if (!images.length) return await deleteCsamReport(report.id);

  const modelVersions = await getModelVersions([
    ...new Set([...images.map((x) => x.modelVersionId).filter(isDefined)]),
  ]);

  initialReport.incidentSummary.incidentDateTime = images[0].createdAt;

  const {
    data: { reportId },
  } = await cybertipClient.submitReport({
    ...initialReport,
  });

  const uploadResult = await Limiter({ limit: 2, batchSize: 1 }).process(
    images,
    async ([image]) => {
      const imageReportInfo = report.images.find((x) => x.id === image.id);
      if (!imageReportInfo) return;

      const imageUrl = getEdgeUrl(image.url, { type: image.type });
      const { prompt, negativePrompt } = (image.meta ?? {}) as Record<string, unknown>;
      const modelVersion = modelVersions.find((x) => x.id === image.modelVersionId);
      const modelId = modelVersion?.model.id;
      const modelVersionId = modelVersion?.id;

      const fileAnnotations =
        imageReportInfo?.fileAnnotations ?? ({} as Ncmec.FileAnnotationsSchema);
      const tags = image.tags.map((x) => x.tag.name);
      if (tags.some((tag) => ['anime', 'illustrated explicit nudity'].includes(tag))) {
        fileAnnotations.animeDrawingVirtualHentai = true;
      }
      if (
        tags.some((tag) =>
          [
            'violence',
            'explosions and blasts',
            'physical violence',
            'weapon violence',
            'graphic violence or gore',
            'hanging',
          ].includes(tag)
        )
      ) {
        fileAnnotations.physicalHarm = true;
      }

      const blob = await fetchBlobAsFile(imageUrl);
      if (!blob) return;

      const {
        data: { fileId, hash },
      } = await cybertipClient.uploadFile({ id: reportId, file: blob });

      await cybertipClient.submitFileDetails({
        reportId,
        fileId,
        originalFileName: image.name ?? undefined,
        locationOfFile: imageUrl,
        fileViewedByEsp: true,
        fileAnnotations,
      });

      return {
        ...imageReportInfo,
        fileAnnotations,
        fileId,
        hash,
      };
    }
  );

  await dbWrite.csamReport.update({
    where: { id: report.id },
    data: {
      ...report,
      reportId,
      reportSentAt: new Date(),
      details: { ...report.details, images: uploadResult.filter(isDefined) },
    },
  });

  await cybertipClient.finishReport({ id: reportId });
}

async function reportGenerationData(report: CsamReportProps) {
  const initialReport = await getInitialReportData(report);
  if (!initialReport) return;

  const generatedImages = report.details.generatedImages;
  if (!generatedImages) return await deleteCsamReport(report.id);

  const {
    data: { reportId },
  } = await cybertipClient.submitReport({
    ...initialReport,
  });

  const uploadResult = await Limiter({ batchSize: 1, limit: 2 }).process(
    generatedImages,
    async ([{ blobs, prompt, negativePrompt, resources }]) => {
      const data = await Promise.all(
        blobs.map(async (blob) => ({ ...blob, file: await fetchBlobAsFile(blob.url) }))
      );
      const arr: CsamReportGeneratedImageData[] = [];
      for (const { file, url } of data) {
        if (file) {
          const {
            data: { fileId, hash },
          } = await cybertipClient.uploadFile({ id: reportId, file });

          const valuePair: Array<{ name: string; value: string }> = [];
          if (prompt) valuePair.push({ name: 'prompt', value: prompt });
          if (negativePrompt) valuePair.push({ name: 'negativePrompt', value: negativePrompt });
          if (resources) valuePair.push({ name: 'resources', value: resources.join(',') });

          await cybertipClient.submitFileDetails({
            fileId,
            reportId,
            publiclyAvailable: false,
            details: valuePair ? [{ type: FileDetailType.EXIF, valuePair }] : undefined,
          });
          arr.push({ url, fileId, hash });
        }
      }

      return arr;
    }
  );

  await dbWrite.csamReport.update({
    where: { id: report.id },
    data: {
      ...report,
      reportId,
      reportSentAt: new Date(),
      details: { ...report.details, generatedImages: uploadResult },
    },
  });

  await cybertipClient.finishReport({ id: reportId });
}

async function reportTrainingData(report: CsamReportProps) {
  const initialReport = await getInitialReportData(report);
  if (!initialReport) return;

  const modelVersions = await getModelVersions([
    ...new Set([...(report.details.modelVersionIds ?? [])]),
  ]);

  const version = modelVersions[0];
  if (!version) return await deleteCsamReport(report.id);

  const dir = `${baseDir}/training-data/${report.id}`;
  const outPath = `${dir}/${report.userId ?? 'unknown'}_training-data.zip`;

  createDir(dir);

  const {
    data: { reportId },
  } = await cybertipClient.submitReport({
    ...initialReport,
  });

  try {
    const zipStream = await getTrainingDataZipStream({
      reportedById: report.reportedById,
      versionId: version.id,
    });

    await fsAsync.writeFile(outPath, zipStream);

    const limit = plimit(2);

    const zipReader = new JSZip();
    const zData = await new Promise<Buffer>((resolve, reject) => {
      fs.readFile(outPath, function (err, data) {
        if (err) reject(err);
        else resolve(data);
      });
    }).then((data) => zipReader.loadAsync(new Uint8Array(data)));

    const results = await unzipTrainingData(zData, ({ imgBlob, filename }) =>
      limit(async () => {
        const file = blobToFile(imgBlob, filename);
        const {
          data: { fileId, hash },
        } = await cybertipClient.uploadFile({ id: reportId, file });

        await cybertipClient.submitFileDetails({ reportId, fileId, originalFileName: filename });

        return { filename, fileId, hash };
      })
    );

    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: {
        ...report,
        reportId,
        reportSentAt: new Date(),
        details: { ...report.details, trainingData: results },
      },
    });

    await cybertipClient.finishReport({ id: reportId });

    removeDir(dir);
  } catch (e) {
    removeDir(dir);
    throw e;
  }
}

async function getTrainingDataZipStream({
  reportedById,
  versionId,
}: {
  reportedById: number;
  versionId: number;
}) {
  const reportingUser = await getReportingUser(reportedById);
  const modelFile = await getFileForModelVersion({
    modelVersionId: versionId,
    type: 'Training Data',
    user: reportingUser ?? undefined,
  });
  if (modelFile.status !== 'success') throw new Error('training data not found');

  return await nodeFetch(modelFile.url).then((response) => {
    if (!response.ok) throw new Error(`no training data exists for model version: ${versionId}`);
    return response.body;
  });
}

function uploadStream({
  stream: readStream,
  userId,
  filename,
}: {
  stream: fs.ReadStream;
  userId: number;
  filename: string;
}) {
  if (
    !env.CSAM_UPLOAD_KEY ||
    !env.CSAM_UPLOAD_SECRET ||
    !env.CSAM_UPLOAD_REGION ||
    !env.CSAM_UPLOAD_ENDPOINT ||
    !env.CSAM_BUCKET_NAME
  )
    throw new Error('missing CSAM env vars');

  const client = new S3Client({
    credentials: {
      accessKeyId: env.CSAM_UPLOAD_KEY,
      secretAccessKey: env.CSAM_UPLOAD_SECRET,
    },
    region: env.CSAM_UPLOAD_REGION,
    endpoint: env.CSAM_UPLOAD_ENDPOINT,
  });

  const passThroughStream = new stream.PassThrough();

  const date = new Date();
  const Bucket = env.CSAM_BUCKET_NAME;
  const Key = `${userId}/${date.getTime()}_${filename}`;

  return new Promise<void>(async (resolve, reject) => {
    try {
      const parallelUploads3 = new Upload({
        client,
        params: {
          Bucket,
          Key,
          Body: passThroughStream,
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5, // 5 MB
        leavePartsOnError: false,
      });

      // parallelUploads3.on('httpUploadProgress', (progress) => {
      //   console.log({ progress });
      // });

      readStream.pipe(passThroughStream);
      await parallelUploads3.done();
      // console.dir('upload finished', { depth: null });
      resolve();
    } catch (e) {
      // console.log(e);
      reject();
    }
  });
}

export async function archiveCsamDataForReport(data: CsamReportProps) {
  const { userId } = data;
  if (!userId) return;
  const report = { ...data, userId };

  const reportDirs = {
    base: `${baseDir}/base/${data.id}`,
    images: `${baseDir}/images/${data.id}`,
    generatedImages: `${baseDir}/generated-images/${data.id}`,
    trainingData: `${baseDir}/training-data/${data.id}`,
  };

  for (const dir of Object.values(reportDirs)) {
    createDir(dir);
  }

  const images = await dbRead.image.findMany({ where: { userId } });
  try {
    await archiveBaseReportData();

    switch (report.type) {
      case 'Image':
        await archiveImages();
        break;
      case 'GeneratedImage': {
        await archiveGeneratedImages();
        break;
      }
      case 'TrainingData':
        await archiveTrainingData();
        break;
    }

    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: {
        archivedAt: new Date(),
      },
    });

    for (const dir of Object.values(reportDirs)) removeDir(dir);
  } catch (e) {
    console.log(e);
    if (e instanceof Error) {
      const shouldUpdate = (e.message = 'training data not found');
      if (shouldUpdate) {
        await dbWrite.csamReport.update({
          where: { id: report.id },
          data: {
            archivedAt: new Date(),
          },
        });
      }
    }
    for (const dir of Object.values(reportDirs)) removeDir(dir);
    throw e;
  }

  // writes a json file of user data to disk before uploading
  async function archiveBaseReportData() {
    const { userId, reportId } = report;
    if (userId === -1) return;
    const user = await getReportedUser(userId);
    const models = await dbRead.model.findMany({ where: { userId } });
    const modelVersions = await dbRead.modelVersion.findMany({
      where: { modelId: { in: models.map((x) => x.id) } },
    });

    const outPath = `${reportDirs.base}/${userId}_data.json`;
    await fsAsync.writeFile(
      outPath,
      JSON.stringify(
        {
          user,
          reportId,
          models,
          modelVersions,
          images,
        },
        (key, value) => {
          if (typeof value === 'bigint') {
            return value.toString();
          }
          return value;
        }
      )
    );

    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'data.json' });
  }

  // writes a zip file to disk before adding user images directly to the zip file
  async function archiveImages() {
    const { userId } = report;

    const outPath = `${reportDirs.images}/${userId}_images.zip`;

    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(outPath);

    archive.on('error', function (err) {
      throw err;
    });

    archive.pipe(output);

    // concurrency limiter
    const maxWidth = MAX_POST_IMAGES_WIDTH;
    const limit = plimit(10);
    await Promise.all(
      images.map((image) => {
        return limit(async () => {
          const width = image.width ?? maxWidth;
          const blob = await fetchBlob(
            getEdgeUrl(image.url, { type: image.type, width: width < maxWidth ? width : maxWidth })
          );
          if (!blob) return;
          const arrayBuffer = await blob.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          const imageName = image.name
            ? image.name.substring(0, image.name.lastIndexOf('.'))
            : image.url;
          const name = imageName.length ? imageName : image.url;
          const filename = `${name}.${blob.type.split('/').pop() as string}`;

          archive.append(buffer, { name: filename });
        });
      })
    );
    archive.finalize();

    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'images.zip' });
  }

  async function archiveGeneratedImages() {
    const { userId } = report;

    const flaggedData = await getConsumerStrikes({ consumerId: `civitai-${userId}` });
    const imageUrls = flaggedData
      .flatMap((group) => group.strikes.flatMap(({ job }) => job.blobs))
      .filter(isDefined)
      .map((x) => x.previewUrl);

    const outPath = `${reportDirs.generatedImages}/${userId}_generated-images.zip`;

    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(outPath);

    archive.on('error', function (err) {
      throw err;
    });

    archive.pipe(output);

    // concurrency limiter
    const limit = plimit(10);
    await Promise.all(
      imageUrls.map((url) => {
        return limit(async () => {
          const blob = await fetchBlob(url);
          if (!blob) return;
          try {
            const arrayBuffer = await blob.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const imageName = url.split('/').reverse()[0].split('?')[0];

            archive.append(buffer, { name: imageName });
          } catch (e) {
            //
          }
        });
      })
    );
    archive.finalize();

    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'generated-images.zip' });
  }

  // downloads training data zip file, writes it to disk, and then uploads that zip
  async function archiveTrainingData() {
    const { userId } = report;

    const versionId = report.details.modelVersionIds?.[0];
    if (!versionId) throw new Error('missing model version id');

    const outPath = `${reportDirs.trainingData}/${userId}_training-data.zip`;

    if (!fs.existsSync(outPath)) {
      const zipStream = await getTrainingDataZipStream({
        reportedById: report.reportedById,
        versionId,
      });

      await fsAsync.writeFile(outPath, zipStream);
    }

    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'training-data.zip' });
  }
}

function createDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function removeDir(dir: string) {
  fs.rmSync(dir, { recursive: true });
}
