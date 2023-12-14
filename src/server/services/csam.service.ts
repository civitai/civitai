import { CsamReport } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  CsamFileOutput,
  CsamReportUserInput,
  CsamTestingReportInput,
  CsamUserReportInput,
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
import { invalidateSession } from '~/server/utils/session-helpers';
import { cancelSubscription } from '~/server/services/stripe.service';
import ncmecCaller from '~/server/http/ncmec/ncmec.caller';
import { z } from 'zod';

export const createCsamReport = async ({
  reportedById,
  userId,
  images,
  ...props
}: CsamReportUserInput & { reportedById: number }) => {
  const exists = await dbRead.csamReport.count({ where: { userId } });
  if (exists) return;

  const report = await dbRead.csamReport.findFirst({
    where: { userId },
    select: { id: true, createdAt: true },
  });

  const date = report ? report.createdAt : new Date();
  if (!report) {
    await dbWrite.csamReport.create({
      data: {
        userId,
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
        createdAt: date,
      },
    });
  }

  // TODO - uncomment before prod
  // await dbWrite.user.update({ where: { id: userId }, data: { bannedAt: date } });
  // await invalidateSession(userId);
  // await cancelSubscription({ userId });

  // // hide user content
  // await dbWrite.model.updateMany({
  //   where: { userId },
  //   data: { status: 'UnpublishedViolation' },
  // });
  // await dbWrite.image.updateMany({
  //   where: { userId },
  //   data: { ingestion: 'Blocked', blockedFor: 'CSAM' },
  // });
};

type CsamImageProps = { fileId?: string; hash?: string } & CsamFileOutput;
type CsamReportProps = Omit<CsamReport, 'details' | 'images'> & {
  details: Omit<CsamReportUserInput, 'userId' | 'images'>;
  images: CsamImageProps[];
};

export const getCsamsToReport = async () => {
  const data = await dbRead.csamReport.findMany({ where: { reportSentAt: null } });
  return data as CsamReportProps[];
};

export const getCsamsToArchive = async () => {
  const data = await dbRead.csamReport.findMany({
    where: { reportSentAt: { not: null }, archivedAt: null },
  });
  return data as CsamReportProps[];
};

const reportedByMap = new Map<number, { email: string; name: string }>();
const getReportingUser = async (id: number) => {
  const reportedBy = reportedByMap.get(id);
  if (reportedBy) return reportedBy;

  return await dbRead.user.findUnique({
    where: { id },
    select: { email: true, name: true },
  });
};

const getReportedUser = async (id: number) => {
  return await dbRead.user.findUnique({
    where: { id },
    select: { name: true, email: true, username: true },
  });
};

const getReportedEntities = async ({
  imageIds,
  modelVersionIds,
}: {
  imageIds: number[];
  modelVersionIds?: number[];
}) => {
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
};

export const getUserIpInfo = async ({ userId }: { userId: number }) => {
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
};

export async function processCsamReport(report: CsamReportProps) {
  const imageIds = report.images.map((x) => x.id);
  const reportingUser = await getReportingUser(report.reportedById);
  const reportedUser = await getReportedUser(report.userId);
  const ipAddresses = await getUserIpInfo({ userId: report.userId });
  const { images, models, modelVersions } = await getReportedEntities({
    imageIds,
    modelVersionIds: report.details.modelVersionIds,
  });

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
  let additionalInfo: string | undefined;
  switch (details.origin) {
    case 'user':
      const { minorDepiction } = details as CsamUserReportInput;
      if (minorDepiction === 'non-real')
        additionalInfo = `<p>${reportedUser?.username} (${report.userId}), appears to have used the following models' image/video generation and/or editing capabilities to produce sexual content depicting non-real minors.</p>`;
      else
        additionalInfo = `<p>${reportedUser?.username} (${report.userId}), appears to have used the following models' image/video editing capabilities to modify images of real minors for the apparent purpose of sexualizing them.</p>`;

      additionalInfo += getModelsText();
      break;
    case 'testing':
      const { capabilities } = details as CsamTestingReportInput;
      additionalInfo = `
      <p>The images/videos in this report were unintentionally and inadvertently generated or manipulated, during testing that is part of Civitai's trust and safety program, by the following models, one or more artificial intelligence-powered image/video generator.</p>
      `;

      additionalInfo += getModelsText();

      if (capabilities.length) {
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
      break;
  }

  if (details.contents.length) {
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

  // // TODO - remove this before prod
  // ipAddresses.push('test1');
  // ipAddresses.push('test2');

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
      personOrUserReported: {
        espIdentifier: report.userId,
        screenName: reportedUser?.username,
        // personOrUserReportedPerson: {
        //   firstName: reportedUser?.name,
        //   email: reportedUser?.email,
        //   displayName: reportedUser?.username,
        // },
        ipCaptureEvent: ipAddresses.map((ipAddress) => ({ ipAddress })),
      },
      additionalInfo: `<![CDATA[${additionalInfo}]]>`,
    },
  };

  const { reportId } = await ncmecCaller.initializeReport(reportPayload);

  try {
    const fileUploadResults = await Promise.all(
      images.map(async (image) => {
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

        const blob = await fetchBlob(imageUrl);

        const { fileId, hash } = await ncmecCaller.uploadFile({
          reportId,
          file: blob,
          fileDetails: {
            originalFileName: image.name ?? undefined,
            locationOfFile: imageUrl,
            fileAnnotations: imageReportInfo?.fileAnnotations,
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
          fileId,
          hash,
        };
      })
    );

    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: {
        images: fileUploadResults,
        reportSentAt: new Date(),
      },
    });

    await ncmecCaller.finishReport(reportId);
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

  const Bucket = env.CSAM_BUCKET_NAME;
  const Key = `${userId}/${filename}`;

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

async function zipAndUploadCsamImages({ userId }: { userId: number }) {
  const imagesDir = `${process.cwd()}/csam-images`;
  const zipDir = `${process.cwd()}/csam-zip`;
  const images = await dbRead.image.findMany({ where: { userId } });

  for (const dir of [imagesDir, zipDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  }

  try {
    // write image files to disk
    await Promise.all(
      images.map(async (image) => {
        const blob = await fetchBlob(getEdgeUrl(image.url, { type: image.type }));
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const imageName = image.name
          ? image.name.substring(0, image.name.lastIndexOf('.'))
          : image.url;
        const name = imageName.length ? imageName : image.url;
        const filename = `${name}.${blob.type.split('/').pop()}`;
        const path = `${imagesDir}/${filename}`;

        if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);
        await fsAsync.writeFile(path, buffer);
      })
    );

    // create zip file and zip images directory
    const outPath = `${zipDir}/${userId}_csam.zip`;
    await zipDirectory(imagesDir, outPath);

    // upload zip file to s3 bucket
    const readableStream = fs.createReadStream(outPath);
    await uploadStream({ stream: readableStream, userId, filename: 'images.zip' });
    // remove zip and images directory/files
    for (const dir of [imagesDir, zipDir]) fs.rmSync(dir, { recursive: true });
  } catch (e) {
    for (const dir of [imagesDir, zipDir]) fs.rmSync(dir, { recursive: true });
    throw e;
  }

  return images;
}

async function zipAndUploadCsamUserData(
  userId: number,
  reportId: number | null = null,
  imagesArr?: unknown[]
) {
  const jsonDir = `${process.cwd()}/csam-json`;
  const outPath = `${jsonDir}/user_${userId}.json`;

  const images = imagesArr ?? (await dbRead.image.findMany({ where: { userId } }));
  const user = await getReportedUser(userId);
  const ipAddresses = await getUserIpInfo({ userId });
  const models = await dbRead.model.findMany({ where: { userId } });
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { modelId: { in: models.map((x) => x.id) } },
  });

  try {
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
    fs.rmSync(jsonDir, { recursive: true });
  } catch (e) {
    fs.rmSync(jsonDir, { recursive: true });
    throw e;
  }
}

export async function archiveCsamDataForReport(report: CsamReportProps) {
  const { userId, reportId } = report;

  const images = await zipAndUploadCsamImages({ userId });

  await zipAndUploadCsamUserData(userId, reportId, images);

  await dbWrite.csamReport.update({
    where: { id: report.id },
    data: {
      archivedAt: new Date(),
    },
  });
}
