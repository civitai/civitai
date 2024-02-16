import { CsamReport, Image, ReportStatus } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  CsamFileOutput,
  CsamReportUserInput,
  CsamTestingReportInput,
  CsamUserReportInput,
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
import { bulkSetReportStatus } from '~/server/services/report.service';
import { softDeleteUser } from '~/server/services/user.service';
import { isProd } from '~/env/other';

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
  images,
  userId,
  ...props
}: CsamReportUserInput & { reportedById: number }) {
  const isInternalReport = userId === -1;
  const report = !isInternalReport
    ? await dbRead.csamReport.findFirst({
        where: { userId },
        select: { id: true, createdAt: true },
      })
    : null;

  const date = new Date();
  if (!report) {
    await dbWrite.csamReport.create({
      data: {
        userId: !isInternalReport ? userId : undefined,
        reportedById,
        details: props,
        images,
        createdAt: date,
      },
    });
  } else {
    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: {
        reportedById,
        details: props,
        images,
        reportSentAt: null,
        archivedAt: null,
        contentRemovedAt: null,
      },
    });
  }

  // Resolve reports concerning csam images
  await bulkSetReportStatus({
    ids: images.map((x) => x.id),
    status: ReportStatus.Actioned,
    userId: reportedById,
  });

  if (!isInternalReport) {
    await softDeleteUser({ id: userId });
  }
}

type CsamImageProps = { fileId?: string; hash?: string } & CsamFileOutput;
type CsamReportProps = Omit<CsamReport, 'details' | 'images'> & {
  details: Omit<CsamReportUserInput, 'userId' | 'images'>;
  images: CsamImageProps[];
};

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

const reportedByMap = new Map<number, { email: string; name: string }>();
async function getReportingUser(id: number) {
  const reportedBy = reportedByMap.get(id);
  if (reportedBy) return reportedBy;

  return await dbRead.user.findUnique({
    where: { id },
    select: { email: true, name: true },
  });
}

async function getReportedUser(id: number) {
  return await dbRead.user.findUnique({
    where: { id },
    select: { name: true, email: true, username: true },
  });
}

async function getReportedEntities({
  imageIds,
  modelVersionIds,
}: {
  imageIds: number[];
  modelVersionIds?: number[];
}) {
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
  const versionIds = modelVersionIds ?? [
    ...new Set(images.map((x) => x.post?.modelVersionId).filter(isDefined)),
  ];

  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: versionIds } },
    select: { id: true, name: true, model: { select: { id: true, name: true } } },
  });
  const models = modelVersions.map((x) => x.model);

  return { images, modelVersions, models };
}

export async function getUserIpInfo({ userId }: { userId: number }) {
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

export async function processCsamReport(report: CsamReportProps) {
  const imageIds = report.images.map((x) => x.id);
  const reportingUser = await getReportingUser(report.reportedById);
  const reportedUser = report.userId ? await getReportedUser(report.userId) : null;
  const ipAddresses = report.userId ? await getUserIpInfo({ userId: report.userId }) : null;
  const { images, models, modelVersions } = await getReportedEntities({
    imageIds,
    modelVersionIds: report.details.modelVersionIds,
  });

  if (!images.length) {
    await dbWrite.csamReport.delete({ where: { id: report.id } });
    return;
  }

  const getModelsText = () => {
    if (!models.length) return '';
    return `
      <br />
      <p>Models format: [modelId:modelName]:[modelVersionId:modelVersionName]</p>
      <ul>
      ${modelVersions.map(
        ({ id, name, model }) => `<li>[${model.id}:${model.name}]:[${id}:${name}]</li>`
      )}
        </ul>
    `;
  };

  const details = report.details;
  let additionalInfo = '';
  if (reportedUser) {
    const { minorDepiction } = details as CsamUserReportInput;
    if (minorDepiction === 'non-real')
      additionalInfo = `<p>${reportedUser.username} (${report.userId}), appears to have used the following models' image/video generation and/or editing capabilities to produce sexual content depicting non-real minors.</p>`;
    else if (minorDepiction === 'real')
      additionalInfo = `<p>${reportedUser.username} (${report.userId}), appears to have used the following models' image/video editing capabilities to modify images of real minors for the apparent purpose of sexualizing them.</p>`;

    additionalInfo += getModelsText();
  } else {
    additionalInfo = `
      <p>The images/videos in this report were unintentionally and inadvertently generated or manipulated, during testing that is part of Civitai's trust and safety program, by the following models, one or more artificial intelligence-powered image/video generator.</p>
      `;

    additionalInfo += getModelsText();

    const { capabilities } = details as CsamTestingReportInput;
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

  if (details.contents?.length) {
    additionalInfo += `
    <br />
    <p>The images/videos in this report may involve:</p>
    <ul>
    ${details.contents
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

  const reportPayload = {
    report: {
      incidentSummary: {
        incidentType: 'Child Pornography (possession, manufacture, and distribution)',
        incidentDateTime: images[0].createdAt.toISOString(),
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
      personOrUserReported: report.userId
        ? {
            espIdentifier: report.userId,
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

  const { reportId } = await ncmecCaller.initializeReport(reportPayload);

  // concurrency limit
  const limit = plimit(2);
  try {
    const fileUploadResults = await Promise.all(
      images.map((image) => {
        return limit(async () => {
          const imageReportInfo = report.images.find((x) => x.id === image.id);

          const imageUrl = getEdgeUrl(image.url, { type: image.type });
          const { prompt, negativePrompt } = (image.meta ?? {}) as Record<string, unknown>;
          const modelVersion = modelVersions.find((x) => x.id === image.post?.modelVersionId);
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

    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: {
        images: fileUploadResults.filter(isDefined),
        reportId,
        reportSentAt: new Date(),
      },
    });

    await ncmecCaller.finishReport(reportId);
    console.log('finished report:', reportId);
  } catch (e) {
    console.log('ERROR');
    console.log(e);
    await ncmecCaller.retractReport(reportId);
  }
}

function zipDirectory(sourceDir: string, outPath: string) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = fs.createWriteStream(outPath);

  return new Promise<void>((resolve, reject) => {
    archive
      .directory(sourceDir, false)
      .on('error', (err) => reject(err))
      .pipe(stream);

    stream.on('close', () => resolve());
    archive.finalize();
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

async function writeReportedImagesToDisk({ dir, images }: { dir: string; images: Image[] }) {
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
        const path = `${dir}/${filename}`;

        await fsAsync.writeFile(path, buffer);
      });
    })
  );
}

export async function archiveCsamDataForReport(report: CsamReportProps) {
  const { userId, reportId } = report;
  if (!reportId || !userId) return;

  const isInternal = userId === -1;
  const reportDir = `${baseDir}/${reportId}`;
  const imagesDir = `${baseDir}/${reportId}/images`;

  for (const dir of [reportDir, imagesDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const images = await dbRead.image.findMany({
    where: {
      userId,
    },
  });

  try {
    await writeReportedImagesToDisk({ dir: imagesDir, images });

    // create zip file and zip images directory
    const outPath = `${reportDir}/${userId}_csam.zip`;
    await zipDirectory(imagesDir, outPath);

    // upload zip file to s3 bucket
    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'images.zip' });
    // remove zip and images directory/files

    if (!isInternal) {
      const user = await getReportedUser(userId);
      const ipAddresses = await getUserIpInfo({ userId });
      const models = await dbRead.model.findMany({ where: { userId } });
      const modelVersions = await dbRead.modelVersion.findMany({
        where: { modelId: { in: models.map((x) => x.id) } },
      });

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
    for (const dir of [imagesDir, reportDir]) fs.rmSync(dir, { recursive: true });

    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: {
        archivedAt: new Date(),
      },
    });
  } catch (e) {
    for (const dir of [imagesDir, reportDir]) fs.rmSync(dir, { recursive: true });
    throw e;
  }
}
