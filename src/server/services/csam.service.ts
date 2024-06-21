import { CsamReport, CsamReportType } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  CsamImage,
  CsamReportDetails,
  CsamReportSchema,
  GetImageResourcesOutput,
  csamCapabilitiesDictionary,
  csamContentsDictionary,
} from '~/server/schema/csam.schema';
import { clickhouse } from '~/server/clickhouse/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { isDefined } from '~/utils/type-guards';
import { fetchBlob } from '~/utils/file-utils';
import { S3Client } from '@aws-sdk/client-s3';
import { env } from '~/env/server.mjs';
import fsAsync from 'fs/promises';
import fs from 'fs';
import archiver from 'archiver';
import stream from 'stream';
import { Upload } from '@aws-sdk/lib-storage';
import ncmecCaller from '~/server/http/ncmec/ncmec.caller';
import { z } from 'zod';
import plimit from 'p-limit';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { PaginationInput } from '~/server/schema/base.schema';
import { Ncmec } from '~/server/http/ncmec/ncmec.schema';
import { isProd } from '~/env/other';
import { unzipTrainingData } from '~/utils/training';
import { getFileForModelVersion } from '~/server/services/file.service';
import nodeFetch from 'node-fetch';
import JSZip from 'jszip';

type CsamReportProps = Omit<CsamReport, 'details' | 'images'> & {
  details: CsamReportDetails;
  images: CsamImage[];
};

const baseDir = `${isProd ? env.DIRNAME : process.cwd()}/csam`;

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
}: CsamReportSchema & { reportedById: number }) {
  const isInternalReport = userId === -1;
  const report = !isInternalReport
    ? await dbRead.csamReport.findFirst({
        where: { userId },
        select: { id: true, createdAt: true },
      })
    : null;

  const date = new Date();
  const images = imageIds?.map((id) => ({ id })) ?? [];
  if (!report) {
    await dbWrite.csamReport.create({
      data: {
        userId: !isInternalReport ? userId : undefined,
        reportedById,
        details,
        images,
        createdAt: date,
        type,
      },
    });
  } else {
    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: {
        reportedById,
        details,
        images,
        reportSentAt: null,
        archivedAt: null,
        contentRemovedAt: null,
      },
    });
  }
}

export async function getCsamReportsPaged({ limit, page }: PaginationInput) {
  const { take, skip } = getPagination(limit, page);

  const reports = await dbRead.csamReport.findMany({ take, skip });
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
  return data as CsamReportProps[];
}

export async function getCsamsToArchive() {
  const data = await dbRead.csamReport.findMany({
    where: { reportSentAt: { not: null }, archivedAt: null },
  });
  return data as CsamReportProps[];
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
  return data as CsamReportProps[];
}

const reportedByMap = new Map<
  number,
  { id: number; email: string | null; name: string | null; isModerator: boolean | null }
>();
async function getReportingUser(id: number) {
  const reportedBy = reportedByMap.get(id);
  if (reportedBy) return reportedBy;

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
async function getUserIpInfo({ userId }: { userId: number }) {
  if (!clickhouse) return [];

  const ips = await clickhouse
    .query({
      query: `
      SELECT DISTINCT ip from posts
      WHERE userId = ${userId} and type = 'Create' AND ip != '::1'
      `,
      format: 'JSONEachRow',
    })
    .then((x) => x.json<{ ip: string }[]>());

  return ips
    .map(({ ip }) => {
      const res = z.string().ip().safeParse(ip);
      return res.success ? res.data : undefined;
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
  const ipAddresses = userId ? await getUserIpInfo({ userId }) : null;

  let additionalInfo = '';
  const { minorDepiction, capabilities, contents } = reportDetails;

  const modelsText = modelVersions.length
    ? `
      <br />
      <p>Models format: [modelId:modelName]:[modelVersionId:modelVersionName]</p>
      <ul>
      ${modelVersions.map(
        ({ id, name, model }) => `<li>[${model.id}:${model.name}]:[${id}:${name}]</li>`
      )}
        </ul>
    `
    : '';

  if (reportedUser) {
    if (minorDepiction === 'non-real')
      additionalInfo = `<p>${reportedUser.username} (${reportedUser.id}), appears to have used the following models' image/video generation and/or editing capabilities to produce sexual content depicting non-real minors.</p>`;
    else if (minorDepiction === 'real')
      additionalInfo = `<p>${reportedUser.username} (${reportedUser.id}), appears to have used the following models' image/video editing capabilities to modify images of real minors for the apparent purpose of sexualizing them.</p>`;

    additionalInfo += modelsText;
  } else {
    additionalInfo = `
      <p>The images/videos in this report were unintentionally and inadvertently generated or manipulated, during testing that is part of Civitai's trust and safety program, by the following models, one or more artificial intelligence-powered image/video generator.</p>
      `;

    additionalInfo += modelsText;

    if (capabilities?.length) {
      additionalInfo += `
        <br />
        <p>The aforementioned model(s) can do the following:</p>
        <ul>
        ${capabilities
          .map((key) => {
            const capability = csamCapabilitiesDictionary[key];
            return capability ? `<li>${capability}</li>` : undefined;
          })
          .filter(isDefined)}
        </ul>
        `;
    }
  }

  if (contents?.length) {
    additionalInfo += `
    <br />
    <p>The images/videos in this report may involve:</p>
    <ul>
    ${contents
      .map((key) => {
        const content = csamContentsDictionary[key];
        return content ? `<li>${content}</li>` : undefined;
      })
      .filter(isDefined)}
    </ul>
    `;
  }

  additionalInfo += `
    <br />
    <p>All evidence in this report should be independently verified.</p>
  `;

  additionalInfo = additionalInfo.replace(/\n/g, '').replace(/\s+/g, ' ').trim();

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
        ? {
            espIdentifier: userId,
            screenName: reportedUser?.username,
            // personOrUserReportedPerson: {
            //   firstName: reportedUser?.name,
            //   email: reportedUser?.email,
            //   displayName: reportedUser?.username,
            // },
            ipCaptureEvent: ipAddresses?.map((ipAddress) => ({ ipAddress })),
          }
        : undefined,
      additionalInfo,
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

  const reportPayload = await constructReportPayload({
    reportedById: report.reportedById,
    userId: report.userId,
    reportDetails: report.details,
    modelVersions,
    incidentDateTime,
  });

  const { reportId } = await ncmecCaller.initializeReport(reportPayload);

  const fns = {
    [CsamReportType.Image]: uploadImages,
    [CsamReportType.TrainingData]: uploadTrainingData,
  };

  try {
    const data = await fns[report.type]();
    await ncmecCaller.finishReport(reportId);
    console.log('finished report:', reportId);

    await dbWrite.csamReport.update({
      where: { id: report.id },
      data,
    });
  } catch (e) {
    console.log('ERROR');
    console.log(e);
    await ncmecCaller.retractReport(reportId);
    throw e;
  }

  async function uploadImages() {
    const limit = plimit(2);
    const result = await Promise.all(
      images.map((image) => {
        return limit(async () => {
          const imageReportInfo = report.images.find((x) => x.id === image.id);

          const imageUrl = getEdgeUrl(image.url, { type: image.type });
          const { prompt, negativePrompt } = (image.meta ?? {}) as Record<string, unknown>;
          const modelVersion = modelVersions.find((x) => x.id === image.modelVersionId);
          const modelId = modelVersion?.model.id;
          const modelVersionId = modelVersion?.id;
          const additionalInfo: string[] = [];
          if (modelId) additionalInfo.push(`model id: ${modelId}`);
          if (modelVersionId) additionalInfo.push(`model version id: ${modelVersionId}`);
          if (prompt) additionalInfo.push(`prompt: ${prompt}`);
          if (negativePrompt) additionalInfo.push(`negativePrompt: ${negativePrompt}`);

          const fileAnnotations =
            imageReportInfo?.fileAnnotations ?? ({} as Ncmec.FileAnnotationsInput);
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

          const { fileId, hash } = await ncmecCaller.uploadFile({
            reportId,
            file: blob,
            fileDetails: {
              originalFileName: image.name ?? undefined,
              locationOfFile: imageUrl,
              fileAnnotations,
              additionalInfo: additionalInfo.length
                ? `
                  <![CDATA[
                    <ul>
                    ${additionalInfo.map((info) => `<li>${info}</li>`)}
                    </ul>
                  ]]>
                  `
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
      }).then((data) => zipReader.loadAsync(data));

      const results = await unzipTrainingData(zData, ({ imgBlob, filename }) =>
        limit(async () => {
          const { fileId, hash } = await ncmecCaller.uploadFile({
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

      return {
        reportId,
        reportSentAt: new Date(),
        details,
      };

      // removeDir(dir);
    } catch (e) {
      // try {
      //   removeDir(dir);
      // } catch (e) {}
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
    trainingData: `${baseDir}/training-data/${data.id}`,
  };

  for (const dir of Object.values(reportDirs)) {
    createDir(dir);
  }

  const user = await getReportedUser(userId);
  const ipAddresses = await getUserIpInfo({ userId });
  const images = await dbRead.image.findMany({ where: { userId } });
  const models = await dbRead.model.findMany({ where: { userId } });
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { modelId: { in: models.map((x) => x.id) } },
  });

  try {
    await archiveBaseReportData();

    switch (report.type) {
      case 'Image':
        await archiveImages();
        break;
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
    for (const dir of Object.values(reportDirs)) removeDir(dir);
    throw e;
  }

  async function archiveBaseReportData() {
    const { userId, reportId } = report;
    if (userId === -1) return;

    const outPath = `${reportDirs.base}/${userId}_csam.zip`;
    await fsAsync.writeFile(
      outPath,
      JSON.stringify({
        user: { userId, ...user },
        reportId,
        ipAddresses,
        models,
        modelVersions,
        images,
      })
    );

    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'data.json' });
  }

  async function archiveImages() {
    const { userId } = report;

    const outPath = `${reportDirs.images}/${userId}_images.zip`;

    // concurrency limiter
    const limit = plimit(10);
    await Promise.all(
      images.map((image) => {
        return limit(async () => {
          const blob = await fetchBlob(getEdgeUrl(image.url, { type: image.type }));
          if (!blob) return;
          const arrayBuffer = await blob.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          const imageName = image.name
            ? image.name.substring(0, image.name.lastIndexOf('.'))
            : image.url;
          const name = imageName.length ? imageName : image.url;
          const filename = `${name}.${blob.type.split('/').pop()}`;
          const path = `${reportDirs.images}/${filename}`;

          await fsAsync.writeFile(path, buffer);
        });
      })
    );

    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(outPath);

    await new Promise<void>((resolve, reject) => {
      archive
        .directory(reportDirs.images, false)
        .on('error', (err) => reject(err))
        .pipe(stream);

      stream.on('close', () => resolve());
      archive.finalize();
    });

    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'images.zip' });
  }

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
