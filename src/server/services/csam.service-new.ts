import type { CsamReport } from '~/shared/utils/prisma/models';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  CreateCsamReportSchema,
  CreateExternalCsamReportSchema,
  GetImageResourcesOutput,
  CsamReportFormOutput,
} from '~/server/schema/csam.schema';
import { csamCapabilitiesDictionary, csamContentsDictionary } from '~/server/schema/csam.schema';
import { clickhouse } from '~/server/clickhouse/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { isDefined } from '~/utils/type-guards';
import { blobToFile, fetchBlob, fetchBlobAsFile } from '~/utils/file-utils';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '~/env/server';
import fsAsync from 'fs/promises';
import fs from 'fs';
import archiver from 'archiver';
import type { Archiver } from 'archiver';
import stream, { Readable } from 'stream';
import { Upload } from '@aws-sdk/lib-storage';
import * as z from 'zod';
import plimit from 'p-limit';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import type { PaginationInput } from '~/server/schema/base.schema';
import type { Ncmec } from '~/server/http/ncmec/ncmec.schema';
import { isDev, isProd } from '~/env/other';
import { unzipTrainingData } from '~/utils/training';
import { getFileForModelVersion } from '~/server/services/file.service';
import JSZip from 'jszip';
import { MAX_POST_IMAGES_WIDTH } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { Report } from '@civitai/cybertipline-tools';
import {
  Client,
  Environment,
  FileDetailType,
  FileRelevance,
  IncidentType,
  IPEventName,
} from '@civitai/cybertipline-tools';
import { Limiter } from '~/server/utils/concurrency-helpers';
import type { BoundedArchive } from '~/server/utils/archive-helpers';
import {
  createBoundedArchive,
  deriveUploadPartGeometry,
  ESTIMATED_BYTES_PER_ARCHIVED_IMAGE,
  MEDIA_ARCHIVE_COMPRESSION_LEVEL,
  zipEntryNameForUrl,
} from '~/server/utils/archive-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import type { JsonReplacer } from '~/server/utils/json-stream-helpers';
import { writeJsonObject } from '~/server/utils/json-stream-helpers';
import { getConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';
import { logToAxiom } from '~/server/logging/client';
import { trimNonAlphanumeric } from '~/utils/string-helpers';

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

type ExternalCsamReportDetails = Omit<CreateExternalCsamReportSchema, 'userId'>;

export async function createExternalCsamReport({
  reportedById,
  userId,
  ...details
}: CreateExternalCsamReportSchema & { reportedById: number }) {
  return await dbWrite.csamReport.create({
    data: {
      userId,
      reportedById,
      type: 'ExternalLink',
      details: removeEmpty(details),
      images: [],
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
    // Deterministic batch order, for auditability: without an ORDER BY, Postgres may return
    // these in any order, and it may return a DIFFERENT order run to run, so the sequence in
    // which evidence bundles were built is unreproducible from the data alone.
    //
    // 🔴 This does NOT fix head-of-line blocking, and reads as if it does if you skim it. A
    // report that fails on every attempt is by construction among the OLDEST rows still
    // matching this filter, so `createdAt asc` pins it to the head of every run — the ordering
    // makes the blocking deterministic rather than curing it. Per-report failure isolation is
    // deliberately out of scope here: `process-csam` already wraps each report in its own
    // try/catch, which is enough for a report that merely throws, and nothing short of a
    // circuit breaker (skip a report after N consecutive failures) helps for one that kills
    // the process. That has not been built.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
  if (isDev) console.log({ status });
  if (status.data.responseCode !== 0) return;

  switch (report.type) {
    case 'Image':
      return await reportImages(report);
    case 'GeneratedImage':
      return await reportGenerationData(report);
    case 'TrainingData':
      return await reportTrainingData(report);
    case 'ExternalLink':
      return await reportExternalLink(report);
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

  try {
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
          originalFileName: image.name?.split('?')[0] ?? undefined,
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

    if (isProd) {
      await dbWrite.csamReport.update({
        where: { id: report.id },
        data: {
          ...report,
          reportId,
          reportSentAt: new Date(),
          details: { ...report.details, images: uploadResult.filter(isDefined) },
        },
      });
    }

    await cybertipClient.finishReport({ id: reportId });
  } catch (e: any) {
    await cybertipClient.cancelReport({ id: reportId });
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      subType: 'archive-data',
      message: e.message,
    });
  }
}

async function reportGenerationData(report: CsamReportProps) {
  const initialReport = await getInitialReportData(report);
  if (!initialReport) return;

  const generatedImages = report.details.generatedImages?.filter((x) => x.blobs.length > 0);
  if (!generatedImages) return await deleteCsamReport(report.id);

  const {
    data: { reportId },
  } = await cybertipClient.submitReport({
    ...initialReport,
  });
  try {
    const uploadResult = await Limiter({ batchSize: 1, limit: 2 }).process(
      generatedImages,
      async ([{ blobs, prompt, negativePrompt, resources }]) => {
        const data = (
          await Promise.all(
            blobs.map(async (blob) => {
              const file = await fetchBlobAsFile(blob.url);
              if (!file) return null;
              return { ...blob, file };
            })
          )
        ).filter(isDefined);

        if (!data.length) throw new Error('missing images for report');

        const arr: CsamReportGeneratedImageData[] = [];
        for (const { file, url } of data) {
          if (file) {
            const {
              data: { fileId, hash },
            } = await cybertipClient.uploadFile({ id: reportId, file });

            const valuePair: Array<{ name: string; value: string }> = [];
            if (prompt)
              valuePair.push({ name: 'prompt', value: trimNonAlphanumeric(prompt) ?? '' });
            if (negativePrompt)
              valuePair.push({
                name: 'negativePrompt',
                value: trimNonAlphanumeric(negativePrompt) ?? '',
              });
            if (resources) valuePair.push({ name: 'resources', value: resources.join(',') });

            await cybertipClient.submitFileDetails({
              fileId,
              reportId,
              publiclyAvailable: false,
              // details: valuePair ? [{ type: FileDetailType.EXIF, valuePair }] : undefined,
            });
            arr.push({ url, fileId, hash });
          }
        }

        return arr;
      }
    );

    if (isProd) {
      await dbWrite.csamReport.update({
        where: { id: report.id },
        data: {
          ...report,
          reportId,
          reportSentAt: new Date(),
          details: { ...report.details, generatedImages: uploadResult },
        },
      });
    }

    await cybertipClient.finishReport({ id: reportId });
  } catch (e: any) {
    await cybertipClient.cancelReport({ id: reportId });
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      subType: 'archive-data',
      message: e.message,
    });
  }
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

    if (isProd) {
      await dbWrite.csamReport.update({
        where: { id: report.id },
        data: {
          ...report,
          reportId,
          reportSentAt: new Date(),
          details: { ...report.details, trainingData: results },
        },
      });
    }

    await cybertipClient.finishReport({ id: reportId });

    removeDir(dir);
  } catch (e: any) {
    await cybertipClient.cancelReport({ id: reportId });
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      subType: 'archive-data',
      message: e.message,
    });
  }
}

async function reportExternalLink(report: CsamReportProps) {
  const reportingUser = await getReportingUser(report.reportedById);
  if (!reportingUser?.email || !report.userId) return await deleteCsamReport(report.id);

  const details = report.details as unknown as ExternalCsamReportDetails;
  const userActivity = await getUserIpInfo(report);

  const ipCaptureEvent = userActivity?.map((activity) => {
    const [year, month, day, hour, minute, second] = activity.time.split(/[-: ]/).map(Number);
    return {
      ipAddress: activity.ip,
      eventName: IPEventName[activity.type],
      dateTime: new Date(Date.UTC(year, month - 1, day, hour, minute, second)),
    };
  });

  // Details displayed under the reported suspect.
  const reportedInfo: string[] = [`Email: ${details.email}`];
  if (details.reportedName) reportedInfo.push(`Name: ${details.reportedName}`);
  if (details.secondaryUserId)
    reportedInfo.push(
      `Ban-evasion account: userId ${details.secondaryUserId}${
        details.secondaryEmail ? ` (${details.secondaryEmail})` : ''
      }`
    );

  // Report-level notes: classification + free-form context.
  const reportInfo: string[] = [];
  if (details.minorDepiction) reportInfo.push(`Minor depiction: ${details.minorDepiction}`);
  if (details.contents?.length) {
    reportInfo.push(
      `The images/videos in this report may involve:\n${details.contents
        .map((key) => {
          const content = csamContentsDictionary[key];
          return content ? `  - ${content}` : undefined;
        })
        .filter(isDefined)
        .join('\n')}`
    );
  }
  if (details.additionalInfo) reportInfo.push(details.additionalInfo);
  reportInfo.push('All evidence in this report should be independently verified.');

  // incidentDateTime round-trips through the JSON `details` column, so it
  // arrives here as a string. The cybertip client calls .toISOString() on it
  // unconditionally, so coerce back to a Date (falling back to createdAt).
  const incidentDateTime = details.incidentDateTime
    ? new Date(details.incidentDateTime)
    : report.createdAt;

  // The external link goes in webPageIncidents; the chat transcript goes in its
  // own chatImIncidents entry (its proper NCMEC home), tagged with the platform.
  const incidentDetails: NonNullable<Report['incidentDetails']> = {};
  if (details.externalUrls?.length) {
    incidentDetails.webPageIncidents = [
      { url: details.externalUrls, thirdPartyHostedContent: true },
    ];
  }
  if (details.chatLogs || details.chatPlatform) {
    incidentDetails.chatImIncidents = [
      { chatClient: details.chatPlatform, content: details.chatLogs },
    ];
  }

  const initialReport = {
    incidentSummary: {
      incidentType: IncidentType.ChildPornography,
      incidentDateTime,
    },
    incidentDetails: Object.keys(incidentDetails).length ? incidentDetails : undefined,
    reporter: {
      reportingPerson: {
        email: [{ email: reportingUser.email }],
        firstName: reportingUser.name ?? undefined,
      },
      contactPerson: {
        email: [{ email: 'report@civitai.com' }],
      },
    },
    personOrUserReported: {
      espIdentifier: report.userId.toString(),
      screenName: details.screenName,
      personOrUserReportedPerson: {
        firstName: details.reportedName,
        email: [{ email: details.email }],
      },
      profileUrl: details.profileUrls,
      ipCaptureEvent,
      additionalInfo: reportedInfo.join('\n'),
    },
    additionalInfo: reportInfo.join('\n\n'),
  } satisfies Report;

  const {
    data: { reportId },
  } = await cybertipClient.submitReport({ ...initialReport });

  try {
    if (details.evidence?.bucketKey) {
      const zData = await getCsamBucketZip(details.evidence.bucketKey);
      const limit = plimit(2);

      // External CSAM is usually real (non-AI) imagery, so generativeAi is
      // opt-in here rather than defaulted to true like the in-app flows.
      const fileAnnotations: Record<string, boolean> = {
        generativeAi: details.fileAnnotations?.generativeAi ?? false,
      };
      if (details.fileAnnotations?.infant) fileAnnotations.infant = true;
      if (details.fileAnnotations?.bestiality) fileAnnotations.bestiality = true;
      if (details.fileAnnotations?.violenceGore) fileAnnotations.violenceGore = true;
      if (details.fileAnnotations?.physicalHarm) fileAnnotations.physicalHarm = true;

      const locationOfFile = details.externalUrls?.[0];

      await unzipTrainingData(zData, ({ imgBlob, filename }) =>
        limit(async () => {
          const file = blobToFile(imgBlob, filename);
          const {
            data: { fileId },
          } = await cybertipClient.uploadFile({ id: reportId, file });

          await cybertipClient.submitFileDetails({
            reportId,
            fileId,
            originalFileName: filename,
            locationOfFile,
            fileViewedByEsp: true,
            publiclyAvailable: false,
            fileAnnotations,
          });
        })
      );
    }

    // Chat-log screenshots are contextual evidence, not the reported abuse
    // material: upload them as SupplementalReported with no CSAM annotations.
    if (details.supplementalEvidence?.bucketKey) {
      const zData = await getCsamBucketZip(details.supplementalEvidence.bucketKey);
      const limit = plimit(2);

      await unzipTrainingData(zData, ({ imgBlob, filename }) =>
        limit(async () => {
          const file = blobToFile(imgBlob, filename);
          const {
            data: { fileId },
          } = await cybertipClient.uploadFile({ id: reportId, file });

          await cybertipClient.submitFileDetails({
            reportId,
            fileId,
            originalFileName: filename,
            fileViewedByEsp: true,
            publiclyAvailable: false,
            fileRelevance: FileRelevance.SupplementalReported,
            additionalInfo: ['Chat log screenshot / supplemental evidence'],
          });
        })
      );
    }

    if (isProd) {
      await dbWrite.csamReport.update({
        where: { id: report.id },
        data: { reportId, reportSentAt: new Date() },
      });
    }

    await cybertipClient.finishReport({ id: reportId });
  } catch (e: any) {
    await cybertipClient.cancelReport({ id: reportId });
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      subType: 'send-report',
      message: e.message,
    });
  }
}

function getCsamS3Client() {
  if (
    !env.CSAM_UPLOAD_KEY ||
    !env.CSAM_UPLOAD_SECRET ||
    !env.CSAM_UPLOAD_REGION ||
    !env.CSAM_UPLOAD_ENDPOINT ||
    !env.CSAM_BUCKET_NAME
  )
    throw new Error('missing CSAM env vars');

  return new S3Client({
    credentials: {
      accessKeyId: env.CSAM_UPLOAD_KEY,
      secretAccessKey: env.CSAM_UPLOAD_SECRET,
    },
    region: env.CSAM_UPLOAD_REGION,
    endpoint: env.CSAM_UPLOAD_ENDPOINT,
  });
}

// Streams a moderator-supplied evidence zip into the locked-down CSAM bucket.
export async function uploadExternalCsamEvidence({
  stream: readStream,
  moderatorId,
  filename,
}: {
  stream: Readable;
  moderatorId: number;
  filename: string;
}) {
  const client = getCsamS3Client();
  const Bucket = env.CSAM_BUCKET_NAME;
  const bucketKey = `external-reports/${moderatorId}/${new Date().getTime()}_${filename}`;

  const upload = new Upload({
    client,
    params: { Bucket, Key: bucketKey, Body: readStream },
    queueSize: 4,
    partSize: 1024 * 1024 * 5, // 5 MB
    leavePartsOnError: false,
  });
  await upload.done();

  return { bucketKey, filename };
}

async function getCsamBucketZip(key: string) {
  const client = getCsamS3Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: env.CSAM_BUCKET_NAME, Key: key })
  );
  const byteArray = await response.Body?.transformToByteArray();
  if (!byteArray) throw new Error('failed to download evidence from CSAM bucket');
  return await new JSZip().loadAsync(byteArray);
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
  expectedBytes,
}: {
  /**
   * Widened from `fs.ReadStream`. The streaming archive path pipes a `PassThrough` in here, which
   * is a `Readable` but not an `fs.ReadStream`; nothing in this function ever used a file-specific
   * member of the narrower type.
   */
  stream: Readable;
  userId: number;
  filename: string;
  /**
   * Rough expected size of the object, used only to size multipart parts. Omit it for small
   * objects — see `deriveUploadPartGeometry`, which then reproduces the geometry this function
   * used before part sizing existed.
   */
  expectedBytes?: number;
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

  // 🔴 MEMORY: `Upload` holds up to `queueSize` parts of `partSize` bytes in flight. The pair is
  // derived together from a single budget rather than chosen independently, so that PRODUCT is
  // held AT OR BELOW `UPLOAD_BUFFER_BUDGET_BYTES` (256 MiB) however large the archive turns out
  // to be. (At or below, not at: the realistic geometry here is 5 MiB x 4 = 20 MiB, well under
  // it.) The actual peak is somewhat above the product — see `UPLOAD_BUFFER_BUDGET_BYTES`
  // for what is and is not established about it. The previous fixed `partSize: 5 MiB` /
  // `queueSize: 4` capped any object at 10,000 x 5 MiB = 48.8 GiB, which is the ceiling this
  // replaces. With no estimate the derivation returns exactly that old pair.
  const { partSize, queueSize } = deriveUploadPartGeometry({ expectedBytes });

  return new Promise<void>(async (resolve, reject) => {
    try {
      const parallelUploads3 = new Upload({
        client,
        params: {
          Bucket,
          Key,
          Body: passThroughStream,
        },
        queueSize,
        partSize,
        leavePartsOnError: false,
      });

      // parallelUploads3.on('httpUploadProgress', (progress) => {
      //   console.log({ progress });
      // });

      // 🔴 `pipeline`, NOT `readStream.pipe(passThroughStream)` — `.pipe()` DOES NOT FORWARD
      // ERRORS. When the source failed, `.pipe()` merely unpiped: the destination was never
      // ended and never errored, so `done()` below waited on a stream nothing would ever write
      // to again and the upload hung FOREVER rather than rejecting. `pipeline` destroys the
      // destination with the error, which is what makes `done()` reject.
      //
      // This is not only the streaming path's concern. The disk path's `fs.createReadStream` can
      // fail mid-read too (the scratch directory is removed by the caller's error handler), and
      // it had exactly the same latent hang.
      //
      // The callback is required — `pipeline` throws `ERR_MISSING_ARGS` without one, and an
      // error it reports is already surfaced by `done()` rejecting, so there is nothing to do
      // with it here beyond not crashing the process on an unhandled 'error' event.
      stream.pipeline(readStream, passThroughStream, () => undefined);
      await parallelUploads3.done();
      // console.dir('upload finished', { depth: null });
      resolve();
    } catch (e) {
      // Rejecting with a real Error, not the bare `reject()` this used to do. An `undefined`
      // rejection value reaches the caller's `catch (e)` and then blows up on `e.message` with
      // a TypeError raised INSIDE the catch block — which escapes the per-report try/catch in
      // `process-csam` and abandons every remaining report in that batch. The original is kept
      // as `cause` so nothing about the S3 failure is lost.
      reject(
        new Error(`failed to upload ${filename} for user ${userId}`, {
          cause: e,
        })
      );
    }
  });
}

/**
 * Rows fetched per round-trip by the cursor-paged scans that feed an evidence bundle.
 *
 * The number is a round-trip/latency trade, not a correctness one: any positive value produces
 * the same rows in the same order. It only has to be small enough that one page of full `Image`
 * rows is comfortably resident, which is the whole reason the scans are paged.
 *
 * Exported so the tests can size their fixtures to cross a real page boundary. A test that
 * hardcodes 500 goes green-and-vacuous the day this number is raised — it would be measuring a
 * single-page scan while claiming to measure a multi-page one.
 */
export const ARCHIVE_SCAN_PAGE_SIZE = 500;

/**
 * Keyset-pages a `findMany` over an ascending integer primary key, yielding one page at a time.
 *
 * Keyset rather than `skip`/`offset` because offset paging over a large table both degrades
 * quadratically and can skip or duplicate rows if the underlying set shifts between pages. With
 * `id > cursor ORDER BY id ASC` every row appears exactly once, and the pages concatenate to
 * exactly the row set a single unpaged `findMany` with the same `where` would have returned.
 *
 * ⚠️ PRECONDITION, and it does not hold uniformly across the three tables this is used on:
 * keyset paging is only *cheap* where an index can serve `WHERE <filter> AND id > $cursor
 * ORDER BY id ASC`. Read off `packages/civitai-db-schema/prisma/schema.full.prisma`, `Image`
 * carries `@@index([userId, id])`, so the one genuinely large scan here — every image the
 * reported user owns — is served directly. `Model` has no `userId` index at all, and
 * `ModelVersion`'s only `modelId` index is a HASH index, which can answer equality but cannot
 * serve a range or an ordering. So the two are not in the same position: `Model` has nothing
 * indexed for its filter at all, while `ModelVersion`'s hash index CAN serve its `modelId IN
 * (…)` equality filter — what it cannot serve is the ordering. Both have the primary key
 * available for the cursor and the ordering. That is accepted rather than fixed here,
 * because a user's model and model-version counts are small next to their image count and the
 * point of this change is the memory ceiling, not latency. It is NOT a claim about the plan the
 * planner actually chooses — no `EXPLAIN` was run.
 *
 * Lazy: the first query is not issued until the generator is first pulled from. Callers below
 * depend on that.
 */
async function* scanPagesById<T extends { id: number }>(
  fetchPage: (args: { afterId: number | undefined; take: number }) => Promise<T[]>,
  pageSize: number = ARCHIVE_SCAN_PAGE_SIZE
): AsyncGenerator<T[], void, undefined> {
  let afterId: number | undefined;
  for (;;) {
    const rows = await fetchPage({ afterId, take: pageSize });
    if (!rows.length) return;
    yield rows;
    // A short page is the last page: there is no id greater than the one we just read.
    if (rows.length < pageSize) return;
    afterId = rows[rows.length - 1].id;
  }
}

/** Flattens paged rows into a per-row async iterable. Also lazy. */
async function* flattenPages<T>(pages: AsyncIterable<T[]>): AsyncGenerator<T, void, undefined> {
  for await (const page of pages) for (const row of page) yield row;
}

/**
 * Releases an archive and its sink after a failure that skipped `finalize()`.
 *
 * On the happy path `finalize()` ends the archive and waits for the sink to close, so nothing is
 * left open. On a throw neither happens: the archiver keeps its queued source buffers and the
 * write stream keeps its file descriptor, while the caller's error handler removes the directory
 * that file lives in. Both calls are no-ops once the object has reached a terminal state
 * (`Archiver#abort` returns early if already aborted or finalized, and `destroy()` on a destroyed
 * stream does nothing), so this is safe from any failure point.
 *
 * ⚠️ The two calls have different evidence behind them, and the difference is worth keeping:
 *
 * - `output.destroy()` is the file descriptor, and it is what the tests observe. Both
 *   "closes the archive and its file descriptor …" cases fail with `expected false to be true`
 *   when it is removed.
 * - `archive.abort()` is the queued source buffers, and NO test distinguishes it — removing it
 *   leaves every test in `archive-helpers.test.ts`, `csam-archive-stream-upload.test.ts`,
 *   `csam-archive-backpressure.test.ts` and `process-csam.test.ts` green, and that is expected
 *   rather than a gap: the bounded appender caps the backlog at `MAX_PENDING_ARCHIVE_ENTRIES`,
 *   which drains far too fast to observe without a timing-dependent assertion. Its effect was
 *   measured separately on an UNBOUNDED queue, where it is unmissable: with the sink destroyed
 *   and no `abort()`, the archiver went on to deflate all 60 of 60 queued entries; with `abort()`
 *   it stopped dead — 0 further entries on node 26, 1 on node 24 (whichever was already in
 *   flight). So it does real work; it is just bounded work here, recorded as untested rather
 *   than as covered.
 *
 *   No test TOTAL is quoted here, deliberately. A hand-maintained count sitting next to the code
 *   it counts has nothing asserting on it, and this one drifted twice before it was removed. Run
 *   those four files if you need the number.
 *
 * ⚠️ `output.destroy()` takes no error argument, and it does not need one. Destroying the sink is
 * NOT what settles an in-flight upload reading from it — `stream.pipeline` in `uploadStream` is,
 * and it is the only thing that is. Passing the error in here as well was tried, and measured
 * REDUNDANT: with `pipeline` in place the failure path settles either way, and with `.pipe()` in
 * place it hangs either way. Recorded so nobody re-adds it believing it does work.
 */
function closeArchiveOnFailure(archive: Archiver, output: stream.Writable) {
  archive.abort();
  output.destroy();
}

/**
 * Builds one media archive and uploads it, either by staging it on local disk first or by
 * streaming it straight to object storage.
 *
 * WHY THIS EXISTS AS ONE FUNCTION: the two call sites (`images.zip`, `generated-images.zip`)
 * previously duplicated the archiver/sink/bounded-appender/finalize/upload sequence verbatim, and
 * this change would have duplicated a second variant of it on top. Both sites now run the SAME
 * code, so the two paths cannot drift from each other and the equivalence proof covers both.
 * Only the `append` callback differs between them.
 *
 * THE TWO PATHS, and what is identical across them:
 *
 * - `stream: false` (default, and what runs with the flag off) — the archive is written to
 *   `diskPath` with `fs.createWriteStream`, then read back with `fs.createReadStream` and
 *   uploaded. Unchanged from what shipped before, down to the ordering.
 * - `stream: true` — the archiver is piped into a `PassThrough` that is handed directly to
 *   `Upload`, so the bytes never touch the container's scratch volume. The archive is produced by
 *   the same archiver, at the same compression level, through the same bounded appender, in the
 *   same append order, so the two paths differ only in where the bytes land.
 *
 * 🔴 MEMORY: the streaming path does NOT buffer the archive. `PassThrough` applies normal stream
 * backpressure, so the archiver stalls when the uploader is behind rather than accumulating. What
 * IS held is the uploader's in-flight parts, sized by `deriveUploadPartGeometry` (plus the SDK
 * chunker's own accumulating buffer on top — see `UPLOAD_BUFFER_BUDGET_BYTES`). The
 * bounded appender's own guarantee is untouched — it is the same `createBoundedArchive` wrapper
 * with the same ceiling, just handed a different sink.
 */
async function archiveAndUpload({
  userId,
  filename,
  diskPath,
  stream: streamToStorage,
  expectedBytes,
  append,
}: {
  userId: number;
  filename: string;
  /** Where the archive is staged when `stream` is false. Unused on the streaming path. */
  diskPath: string;
  stream: boolean;
  /**
   * Size estimate for multipart part sizing. STREAMING PATH ONLY — the disk branch drops it so
   * that the flag-off path keeps the fixed geometry it had before this change.
   */
  expectedBytes?: number;
  append: (archive: BoundedArchive) => Promise<void>;
}) {
  const archive = archiver('zip', { zlib: { level: MEDIA_ARCHIVE_COMPRESSION_LEVEL } });

  if (!streamToStorage) {
    const output = fs.createWriteStream(diskPath);
    // 🔴 `pipeline`, NOT `archive.pipe(output)`. `.pipe()` forwards errors in NEITHER direction,
    // and the direction that matters here is SINK → SOURCE: when the sink is destroyed, `.pipe()`
    // merely UNPIPES the source. The archiver is left alive and un-errored, so
    // `createBoundedArchive` never latches a `failure`, never releases the `append()` callers
    // parked on the pending-entry ceiling, and never rejects. The archiver's readable side then
    // fills its high-water mark, `'entry'` stops firing, and every subsequent `append()` parks
    // forever. The report HANGS instead of failing — the outcome this whole change exists to end.
    //
    // Measured against this archiver, destroying the sink under each: with `.pipe()` the archive
    // emits no `'error'` at all and `archive.destroyed` stays `false`; with `pipeline` it emits
    // `'error'` carrying the sink's own error and is destroyed. That `'error'` is the ONLY thing
    // `createBoundedArchive` latches on, which is why the difference is hang-vs-fail rather than
    // a detail of cleanup.
    //
    // This branch is not exempt just because it is the pre-change path. Its sink is a
    // `fs.createWriteStream` on the container's scratch volume, so it fails mid-archive exactly
    // when that volume is full — this incident's own condition, and the state the flag rolls
    // back to. A rollback target that hangs is not a rollback.
    //
    // The callback is required (`pipeline` throws `ERR_MISSING_ARGS` without one) and is
    // deliberately a no-op: every error it can report is ALREADY surfaced on a path the caller
    // observes — a sink error reaches `finalize()`'s `output.once('error', reject)`, and an
    // archiver error reaches `append()`/`finalize()` through the latched `failure`. Rethrowing
    // here would add nothing but an uncaught exception raised from inside stream internals.
    stream.pipeline(archive, output, () => undefined);
    const boundedArchive = createBoundedArchive({ archive, output });

    try {
      await append(boundedArchive);
      // Awaited: the read stream below opens a truncated (or absent) file otherwise.
      await boundedArchive.finalize();
    } catch (e) {
      // Nothing past this point runs, and the caller's `catch` then `rmSync`s the report's scratch
      // directory out from under a write stream that is still open on a file inside it. Release
      // the archiver's queued sources and the sink's fd before letting the error out.
      closeArchiveOnFailure(archive, output);
      throw e;
    }

    const readableStream = fs.createReadStream(diskPath);
    // 🔴 NO `expectedBytes` ON THIS BRANCH, DELIBERATELY — and this is the ONE place the
    // geometry is gated, so no caller has to remember to.
    //
    // Derived part geometry arrived with the streaming change, so it belongs behind the same
    // flag; otherwise "the rollback is a flag flip" is false. Passing an estimate here would
    // give the supposedly-unchanged path a part size derived from a row count instead of the
    // fixed 5 MiB it has always used — up to `256 MiB x 1` of in-flight parts against the previous
    // `5 MiB x 4` = 20 MiB. Memory is the exact dimension that caused the eviction this change
    // exists to fix, so the rollback target must not move on it.
    //
    // The cost is that this path keeps the old `10,000 x 5 MiB` = 48.8 GiB object ceiling. That
    // is what rolling back MEANS; removing that ceiling is the streaming path's job.
    await uploadStream({ stream: readableStream, userId, filename });
    return;
  }

  const passThrough = new stream.PassThrough();
  // 🔴 `pipeline`, NOT `archive.pipe(passThrough)` — the full mechanism is on the disk branch
  // above. This is the branch where a destroyed sink is the ROUTINE case rather than an edge
  // one: the upload's rejection handler below destroys `passThrough` on any upload failure, and
  // under `.pipe()` that destroy reaches the archiver as nothing whatsoever.
  //
  // Size-dependent, which is why it can ship green. `Upload` absorbs roughly
  // `queueSize * partSize` (~20 MiB at the default geometry) out of the `PassThrough` before it
  // stops reading, so an archive smaller than that is already finished appending by the time the
  // upload fails and the report fails correctly. Every archive this change exists for is far
  // above that line — and so is the anti-hang fixture in
  // `src/server/services/__tests__/csam-archive-stream-upload.test.ts`, deliberately.
  stream.pipeline(archive, passThrough, () => undefined);
  const boundedArchive = createBoundedArchive({ archive, output: passThrough });

  // 🔴 START THE UPLOAD BEFORE APPENDING ANYTHING. `PassThrough` has a small high-water mark, so
  // with nothing draining it the first appends fill it and the archiver stalls forever. The
  // consumer has to be attached first.
  //
  // 🔴 AND ATTACH A REJECTION HANDLER IMMEDIATELY. Between here and the `await` at the bottom,
  // this promise is live and unobserved; an upload that fails mid-archive (credentials, network,
  // the part limit) would otherwise be an unhandled rejection, which takes the whole job process
  // down rather than failing this one report. Latch the error instead and re-surface it below.
  let uploadError: unknown;
  const uploadPromise = uploadStream({
    stream: passThrough,
    userId,
    filename,
    expectedBytes,
  }).then(
    () => undefined,
    (e: unknown) => {
      uploadError = e;
      // Fail the sink. The `stream.pipeline` above is what turns that into a stop signal for the
      // producer: it destroys the archiver WITH THIS ERROR, the archiver emits `'error'`, and
      // `createBoundedArchive` latches it and releases every parked `append()`. `finalize()`'s
      // wait for the sink to close then settles too, so the report fails instead of hanging.
      //
      // ⚠️ TWO CORRECTIONS TO EARLIER REVISIONS OF THIS COMMENT LIVE HERE, and the second one
      // undoes an overreach in the first.
      //
      // (1) THE DESTROY ALONE DOES NOT STOP THE PRODUCER. Under `archive.pipe(passThrough)` a
      // destroyed sink only UNPIPES the archiver: it is never destroyed, never emits `'error'`,
      // the pending-entry ceiling is never released, and the report hangs forever. The
      // `stream.pipeline` above is what makes a destroyed sink reach the archiver at all.
      //
      // (2) BUT THE DESTROY DOES NOT CARRY THE COMMON CASE EITHER — the revision that fixed (1)
      // called these two lines one mechanism that needed both halves, and that half is false. For
      // any failure raised inside `upload.done()` — every runtime S3 failure — the pipelines
      // already do the whole job: `Upload.__doConcurrentUpload`'s `for await` calls
      // `dataFeeder.return()` on an in-loop throw, destroying the `PassThrough` `uploadStream`
      // handed to `Upload`; `uploadStream`'s own `stream.pipeline` propagates that back onto THIS
      // `passThrough`, and the `pipeline` above propagates it on to the archiver. Measured on
      // this file: delete this line and all 8 tests stay green, the mid-archive probe included —
      // and that probe is not vacuous, it goes HUNG when the `pipeline` above is removed.
      //
      // So what IS this line for, and it is the only thing established here: a rejection raised
      // BEFORE `uploadStream` attaches that inner `pipeline` — `new Upload()` throwing from
      // `__validateInput` (bad `partSize`/`queueSize`/params). Nothing has linked this
      // `passThrough` to anything that can fail it yet, so without this line the archiver fills
      // the `PassThrough`, stalls, and every parked `append()` waits forever.
      //
      // ⚠️ THAT CASE IS NOT REACHABLE AT HEAD — this is a future-geometry guard, not a live path.
      // `deriveUploadPartGeometry` floors `partSize` at exactly `Upload.MIN_PART_SIZE` (5 MiB), so
      // `__validateInput`'s `partSize < MIN_PART_SIZE` is false; it floors `queueSize` at 1; and
      // `params`/`client` are always supplied at the sole call site above. It becomes reachable
      // only if the part-size floor is dropped below the SDK's minimum or the queue floor below 1
      // — which is what not to break here. Measured by INJECTING a throw at the `new Upload()`
      // call site, since no input produces one today: with this line the report rejects in ~0.1 s;
      // with it removed the same run reports `HUNG` at the 30 s deadline.
      passThrough.destroy(e instanceof Error ? e : new Error(String(e)));
    }
  );

  try {
    await append(boundedArchive);
    // Same contract as the disk path: resolves once the archive has ended AND the sink has
    // closed. Here "the sink has closed" means the uploader has drained every byte.
    await boundedArchive.finalize();
  } catch (e) {
    // 🔴 READ THIS BEFORE `closeArchiveOnFailure`, because that call CREATES the other error.
    // Two different things reach this catch and they need opposite attribution:
    //
    //  - the upload failed first → it destroyed the sink → `finalize()` rejected with the
    //    destroy error, so `e` is the downstream symptom and `uploadError` is the cause;
    //  - the append/finalize failed first → we are about to destroy the sink ourselves, which
    //    will make the upload fail as a consequence, so `e` is the cause.
    //
    // Latching which came first is the only way to tell them apart afterwards. Reporting the
    // upload error unconditionally would bury a fetch or DB failure behind "failed to upload".
    const uploadFailedFirst = uploadError !== undefined;
    closeArchiveOnFailure(archive, passThrough);
    // Settle the upload before rethrowing so nothing is left in flight.
    await uploadPromise;
    if (uploadFailedFirst) throw uploadError;
    throw e;
  }

  // The upload is what decides the object is complete — `finalize()` only tells us the archive
  // ended and the sink drained. Awaiting it here is what makes this function's resolution mean
  // "the object is in storage", matching what the disk path's `await uploadStream(...)` means.
  await uploadPromise;
  if (uploadError) throw uploadError;
}

/** Serialises `bigint` columns (e.g. `Image.pHash`) as strings — `JSON.stringify` throws on them. */
const bigintReplacer: JsonReplacer = (_key, value) =>
  typeof value === 'bigint' ? value.toString() : value;

export async function archiveCsamDataForReport(data: CsamReportProps) {
  const { userId } = data;
  if (!userId) {
    // An internal report (userId === -1 is stored as NULL) has no user-scoped content to
    // archive, and archiveBaseReportData bails on it too. Returning silently left such a
    // report re-selected by getCsamsToArchive every hour since 2024. Stamp a terminal state, but
    // record that nothing was stored — archivedAt alone would read as evidence-complete.
    await dbWrite.csamReport.update({
      where: { id: data.id },
      data: {
        archivedAt: new Date(),
        details: { ...data.details, archiveSkipped: 'no reported user' },
      },
    });
    return;
  }
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

  /**
   * Whether the two large media archives are streamed straight to object storage instead of being
   * staged on the container's scratch volume first.
   *
   * 🔴 EVALUATED ONCE PER REPORT, DELIBERATELY. Reading the flag inside each archive function
   * would let a mid-report flip produce a bundle whose parts were assembled two different ways,
   * for no benefit — a report is short-lived and the two archive types are mutually exclusive
   * anyway. One read also means one Flipt failure mode rather than two.
   *
   * DEFAULT-OFF: `isFlipt` returns false for an unknown flag, an unreachable Flipt, or a flag
   * pinned disabled — all of which leave the disk-staging path, which is unchanged and stays
   * reachable, in charge. That is the rollback: flip the flag off, no deploy.
   *
   * `data.json` and `training-data.zip` are NOT affected by this flag. The first is small; the
   * second is a file this code downloads rather than builds, and the NCMEC submission path reads
   * it back off disk, so neither has the disk ceiling this removes.
   */
  const streamArchivesToStorage = await isFlipt(FLIPT_FEATURE_FLAGS.CSAM_ARCHIVE_STREAM_UPLOAD);

  /**
   * A fresh keyset-paged scan of every image the reported user owns.
   *
   * This replaces a single `dbRead.image.findMany({ where: { userId } })` whose result array was
   * shared by `archiveBaseReportData` and `archiveImages`. Two callers therefore now run two
   * scans instead of sharing one snapshot. That is a deliberate trade and it does not weaken the
   * bundle: the archive step already tolerates listing an image in `data.json` that is absent
   * from `images.zip`, because `fetchBlob` returning null makes it skip the entry silently
   * (`if (!blob) return;` below). What it buys is that neither caller ever holds more than one
   * page of full `Image` rows.
   *
   * The `where`/column selection is unchanged — same filter, no `select`, so every column still
   * lands in the bundle. Only the ORDER is new, and it was previously unspecified (i.e. whatever
   * the query plan produced, not stable run to run), so nothing that was deterministic became
   * less so.
   */
  const scanUserImages = () =>
    scanPagesById(({ afterId, take }) =>
      dbRead.image.findMany({
        where: { userId, ...(afterId !== undefined ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' },
        take,
      })
    );

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
      case 'ExternalLink':
        // Evidence already lives in the CSAM bucket; only base user data is archived.
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
      const shouldUpdate = e.message === 'training data not found';
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

  /**
   * Writes the base evidence bundle to disk, then uploads it.
   *
   * 🔴 WHAT EVIDENCE IS IN THE BUNDLE IS UNCHANGED: the same five properties in the same order,
   * the same `where` clauses with no `select` so every column still lands in it, and the same
   * bigint replacer. `json-stream-helpers.test.ts` pins the serialiser's byte-identity against
   * `JSON.stringify` — note that is a claim about the SERIALISER, over one fixed row order.
   *
   * Two things ARE different, and neither adds or removes a row. The queries now also carry
   * `orderBy: { id: 'asc' }`, `take` and an `id > cursor` predicate, because they are paged. And
   * as a consequence of that ordering, array element order is now `id ASC` where it was
   * previously whatever the query plan happened to produce — so against real data this writes a
   * document that is set-identical to the old one but NOT byte-identical to it. Making the order
   * deterministic is an improvement for an evidence artefact, but it is a change, and anything
   * that diffs two bundles across this commit will see it.
   *
   * Why it had to change: the previous shape loaded every `Image`, `Model` and `ModelVersion`
   * row the reported user owns into three arrays and rendered them with one `JSON.stringify`.
   * That has two ceilings. The soft one is memory — rows and rendered string resident together.
   * The hard one is that `JSON.stringify` returns a single JavaScript string, and a JS string
   * cannot exceed V8's maximum length — 536,870,888 characters on 64-bit
   * (`require('buffer').constants.MAX_STRING_LENGTH`). Past that it throws
   * `RangeError: Invalid string length`, which no amount of memory or retrying fixes. A report
   * whose bundle crosses that line can never be archived.
   */
  async function archiveBaseReportData() {
    const { userId, reportId } = report;
    if (userId === -1) return;
    const user = await getReportedUser(userId);

    // Model IDs are accumulated because `modelVersions` is filtered by them, exactly as before.
    // Only the 4-byte ids are kept; the model ROWS stream through without being retained.
    const modelIds: number[] = [];
    let modelScanComplete = false;

    async function* streamModels() {
      const pages = scanPagesById(({ afterId, take }) =>
        dbRead.model.findMany({
          where: { userId, ...(afterId !== undefined ? { id: { gt: afterId } } : {}) },
          orderBy: { id: 'asc' },
          take,
        })
      );
      for await (const model of flattenPages(pages)) {
        modelIds.push(model.id);
        yield model;
      }
      modelScanComplete = true;
    }

    async function* streamModelVersions() {
      // 🔴 ORDERING INVARIANT. `modelIds` is filled by `streamModels` above, so this generator
      // must not issue its first query until that one has been drained. It does not, because
      // `writeJsonObject` serialises entries strictly in order and fully drains each iterable
      // before starting the next, and because an async generator body does not run until it is
      // first pulled from. Both of those are load-bearing and neither is locally visible, so
      // the invariant is asserted rather than assumed: silently reading a half-filled `modelIds`
      // would drop model versions from a CSAM evidence bundle with nothing to indicate it.
      if (!modelScanComplete)
        throw new Error(
          'archiveBaseReportData: model versions were streamed before the model scan finished — ' +
            'modelIds is incomplete and the bundle would be missing evidence'
        );
      const pages = scanPagesById(({ afterId, take }) =>
        dbRead.modelVersion.findMany({
          where: {
            // A COPY of `modelIds`, not the live array.
            //
            // NOT because of a production race. The ordering invariant asserted at the top of
            // `streamModelVersions` means this closure is only ever built after `streamModels`
            // has been drained,
            // so `modelIds` is already complete and nothing appends to it while these pages are
            // fetched. An earlier revision of this comment claimed the array was "still being
            // appended to" here; that was wrong, and the invariant directly above it says so.
            //
            // What the copy does buy, measured rather than reasoned: it is what lets the
            // "filters model versions by the COMPLETE set of model ids" test observe the hazard
            // the invariant names. Against a live reference the recorded call argument keeps
            // mutating after the call, so it reads back as complete even for a scan that ran on
            // an empty id set. Removing the invariant and reversing the entry order — i.e. the
            // hazard, made reachable — fails that test with `expected [] to have a length of
            // 501` against this copy, and passes vacuously against a reference.
            modelId: { in: [...modelIds] },
            ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
          },
          orderBy: { id: 'asc' },
          take,
        })
      );
      yield* flattenPages(pages);
    }

    const outPath = `${reportDirs.base}/${userId}_data.json`;
    await writeJsonObject({
      sink: fs.createWriteStream(outPath),
      replacer: bigintReplacer,
      entries: [
        ['user', { value: user }],
        ['reportId', { value: reportId }],
        ['models', { items: streamModels() }],
        ['modelVersions', { items: streamModelVersions() }],
        ['images', { items: flattenPages(scanUserImages()) }],
      ],
    });

    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'data.json' });
  }

  /**
   * Archives every image the reported user owns.
   *
   * The archive is either staged on disk and then uploaded, or streamed straight to storage —
   * see `archiveAndUpload`. The append loop below is identical either way; that is the point.
   */
  async function archiveImages() {
    const { userId } = report;

    // Feeds multipart part sizing ONLY. A `count` is a separate round trip from the paged scan
    // because `partSize` has to be fixed before the first byte is uploaded, and the scan does not
    // know its own total until it has finished. An inaccurate — or absent — answer degrades to
    // the default geometry rather than breaking anything; see `deriveUploadPartGeometry`.
    //
    // 🔴 GATED ON THE FLAG, like the geometry it feeds. This query did not exist before this
    // change, and `archiveAndUpload`'s disk branch discards the estimate anyway, so issuing it
    // with the flag off would be a new round trip against the main database bought for nothing —
    // on the path whose whole claim is that it is unchanged.
    const imageCount = streamArchivesToStorage
      ? await dbRead.image.count({ where: { userId } })
      : undefined;

    await archiveAndUpload({
      userId,
      filename: 'images.zip',
      diskPath: `${reportDirs.images}/${userId}_images.zip`,
      stream: streamArchivesToStorage,
      expectedBytes:
        imageCount !== undefined ? imageCount * ESTIMATED_BYTES_PER_ARCHIVED_IMAGE : undefined,
      append: async (boundedArchive) => {
        // concurrency limiter
        const maxWidth = MAX_POST_IMAGES_WIDTH;
        const limit = plimit(10);
        // Paged rather than `images.map(...)` over one array of every row the user owns: the row
        // set is unbounded, and materialising it was half of the memory problem this file exists
        // to fix. Concurrency within a page is unchanged (10); pages are processed in order.
        for await (const page of scanUserImages()) {
          await Promise.all(
            page.map((image) => {
              return limit(async () => {
                const width = image.width ?? maxWidth;
                const blob = await fetchBlob(
                  getEdgeUrl(image.url, {
                    type: image.type,
                    width: width < maxWidth ? width : maxWidth,
                  })
                );
                if (!blob) return;
                const arrayBuffer = await blob.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                const imageName = image.name
                  ? image.name.substring(0, image.name.lastIndexOf('.'))
                  : image.url;
                const name = imageName.length ? imageName : image.url;
                const filename = `${name}.${blob.type.split('/').pop() as string}`;

                await boundedArchive.append(buffer, { name: filename });
              });
            })
          );
        }
      },
    });
  }

  async function archiveGeneratedImages() {
    const { userId } = report;

    const flaggedData = await getConsumerStrikes({ consumerId: `civitai-${userId}` });
    const imageUrls = flaggedData
      .flatMap((group) => group.strikes.flatMap(({ job }) => job.blobs))
      .filter(isDefined)
      .map((x) => x.previewUrl);

    await archiveAndUpload({
      userId,
      filename: 'generated-images.zip',
      diskPath: `${reportDirs.generatedImages}/${userId}_generated-images.zip`,
      stream: streamArchivesToStorage,
      // Known upfront here, unlike `archiveImages` — no extra round trip needed. This is an upper
      // bound: a URL whose fetch returns nothing is skipped, so the real archive can be smaller.
      expectedBytes: imageUrls.length * ESTIMATED_BYTES_PER_ARCHIVED_IMAGE,
      append: async (boundedArchive) => {
        // concurrency limiter
        const limit = plimit(10);
        await Promise.all(
          imageUrls.map((url, index) => {
            return limit(async () => {
              const blob = await fetchBlob(url);
              if (!blob) return;
              try {
                const arrayBuffer = await blob.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                const imageName = zipEntryNameForUrl(url, index);

                await boundedArchive.append(buffer, { name: imageName });
              } catch (e) {
                //
              }
            });
          })
        );
      },
    });
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
