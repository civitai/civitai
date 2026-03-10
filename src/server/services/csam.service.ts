import { BlockImageReason, CsamReportType } from '~/shared/utils/prisma/enums';
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
import { fetchBlob } from '~/utils/file-utils';
import { S3Client } from '@aws-sdk/client-s3';
import { env } from '~/env/server';
import fsAsync from 'fs/promises';
import fs from 'fs';
import archiver from 'archiver';
import stream, { Readable } from 'stream';
import { Upload } from '@aws-sdk/lib-storage';
import ncmecCaller from '~/server/http/ncmec/ncmec.caller';
import * as z from 'zod';
import plimit from 'p-limit';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import type { PaginationInput } from '~/server/schema/base.schema';
import type { Ncmec } from '~/server/http/ncmec/ncmec.schema';
import { isProd } from '~/env/other';
import { unzipTrainingData } from '~/utils/training';
import { getFileForModelVersion } from '~/server/services/file.service';
import JSZip from 'jszip';
import { MAX_POST_IMAGES_WIDTH } from '~/server/common/constants';
import { bulkAddBlockedImages } from '~/server/services/image.service';
import { removeEmpty } from '~/utils/object-helpers';
import { getConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';

type CsamReportImage = {
  id: number;
  fileId?: string;
  hash?: string;
  fileAnnotations?: Ncmec.FileAnnotationsSchema;
};

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
  fileId?: string | undefined;
  hash?: string | undefined;
};

type CsamReportDetails = CsamReportFormOutput & {
  trainingData?: CsamReportTrainingData[];
  userActivity?: CsamReportUserActivity[];
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

  const exists = await dbWrite.csamReport.findFirst({
    where: { userId: reportedUserId },
    select: { id: true, reportSentAt: true },
  });

  const report =
    exists && !exists.reportSentAt
      ? await dbWrite.csamReport.update({
          where: { id: exists.id },
          data: {
            userId: reportedUserId,
            reportedById,
            details,
            type,
            //map imageIds to objects so that we can append additional data to them later
            images: imageIds?.map((id) => ({ id })) ?? [],
          },
        })
      : await dbWrite.csamReport.create({
          data: {
            userId: reportedUserId,
            reportedById,
            details,
            type,
            //map imageIds to objects so that we can append additional data to them later
            images: imageIds?.map((id) => ({ id })) ?? [],
          },
        });

  if (imageIds.length) {
    const affectedImages = await dbWrite.image.findMany({
      where: { id: { in: imageIds } },
      select: { pHash: true },
    });

    await bulkAddBlockedImages({
      data: affectedImages
        .filter((img) => !!img.pHash)
        .map((x) => ({
          hash: x.pHash as bigint,
          reason: BlockImageReason.CSAM,
        })),
    });
  }

  return report;
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
  const images = await getImages(report.images.map((x) => x.id));
  const modelVersions = await getModelVersions([
    ...new Set([
      ...(report.details.modelVersionIds ?? []),
      ...images.map((x) => x.modelVersionId).filter(isDefined),
    ]),
  ]);

  let shouldDelete = false;
  if (report.type === 'Image' && !images.length) shouldDelete = true;
  if (report.type === 'TrainingData' && !modelVersions.length) shouldDelete = true;
  if (shouldDelete) {
    await dbWrite.csamReport.delete({ where: { id: report.id } });
    return;
  }

  let incidentDateTime = new Date();
  if (report.type === 'Image') {
    incidentDateTime = images[0].createdAt;
  } else if (report.type === 'TrainingData') {
    incidentDateTime = modelVersions[0].createdAt;
  }

  const userActivity = await getUserIpInfo(report);

  const reportPayload = await constructReportPayload({
    reportedById: report.reportedById,
    userId: report.userId,
    reportDetails: { ...report.details, userActivity },
    modelVersions,
    incidentDateTime,
  });

  const { reportId } = await ncmecCaller().initializeReport(reportPayload);

  const fns = {
    [CsamReportType.Image]: uploadImages,
    [CsamReportType.TrainingData]: uploadTrainingData,
    [CsamReportType.GeneratedImage]: () => {
      throw new Error('unsupported report type: "generated-image"');
    },
  };

  try {
    const data = await fns[report.type]();
    await ncmecCaller().finishReport(reportId);
    console.log('finished report:', reportId);

    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: { ...data, details: { ...data.details, userActivity } },
    });
  } catch (e) {
    console.log('ERROR');
    console.log(e);
    await ncmecCaller().retractReport(reportId);
    throw e;
  }

  async function uploadImages(): Promise<Partial<CsamReportProps>> {
    const limit = plimit(2);
    const result = await Promise.all(
      images.map((image) => {
        return limit(async () => {
          const imageReportInfo = report.images.find((x) => x.id === image.id);
          if (!imageReportInfo) return;

          const imageUrl = getEdgeUrl(image.url, { type: image.type });
          const { prompt, negativePrompt } = (image.meta ?? {}) as Record<string, unknown>;
          const modelVersion = modelVersions.find((x) => x.id === image.modelVersionId);
          const modelId = modelVersion?.model.id;
          const modelVersionId = modelVersion?.id;
          const additionalInfo: string[] = [];
          if (modelId) additionalInfo.push(`model id: ${modelId}`);
          if (modelVersionId) additionalInfo.push(`model version id: ${modelVersionId}`);
          if (prompt && typeof prompt === 'string') additionalInfo.push(`prompt: ${prompt}`);
          if (negativePrompt && typeof negativePrompt === 'string')
            additionalInfo.push(`negativePrompt: ${negativePrompt}`);

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

          const blob = await fetchBlob(imageUrl);
          if (!blob) return;

          const { fileId, hash } = await ncmecCaller().uploadFile({
            reportId,
            file: blob,
            fileDetails: {
              originalFileName: image.name ?? undefined,
              locationOfFile: imageUrl,
              fileViewedByEsp: true,
              fileAnnotations,
              additionalInfo: additionalInfo.length
                ? `${additionalInfo.map((info) => `  - ${info}`).join('\n')}`
                : undefined,
            },
          });

          return {
            ...imageReportInfo,
            fileAnnotations,
            fileId,
            hash,
          };
        });
      })
    );

    return {
      images: result.filter(isDefined),
      reportId,
      reportSentAt: new Date(),
    };
  }

  async function uploadTrainingData() {
    const version = modelVersions[0];
    const dir = `${baseDir}/training-data/${report.id}`;
    const outPath = `${dir}/${report.userId ?? 'unknown'}_training-data.zip`;

    // persist output to be used in upcoming job
    createDir(dir);

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
          const { fileId, hash } = await ncmecCaller().uploadFile({
            reportId,
            file: imgBlob,
            fileDetails: {
              originalFileName: filename,
            },
          });
          return { filename, fileId, hash };
        })
      );

      const details = report.details as CsamReportDetails;
      details.trainingData = results;

      removeDir(dir);
      return {
        reportId,
        reportSentAt: new Date(),
        details,
      };
    } catch (e) {
      removeDir(dir);
      throw e;
    }
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

  const response = await fetch(modelFile.url);
  if (!response.ok) throw new Error(`no training data exists for model version: ${versionId}`);
  if (!response.body) throw new Error(`no response body for model version: ${versionId}`);
  // Convert Web ReadableStream to Node.js Readable stream
  return Readable.fromWeb(response.body as import('stream/web').ReadableStream);
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
