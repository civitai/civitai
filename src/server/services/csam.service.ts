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
import JSZip from 'jszip';
import { fetchBlob } from '~/utils/file-utils';
import {
  AbortMultipartUploadCommandOutput,
  CompleteMultipartUploadCommandOutput,
  CreateMultipartUploadCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '~/env/server.mjs';
import { completeMultipartUpload, getMultipartPutUrl } from '~/utils/s3-utils';
import fsAsync from 'fs/promises';
import fs from 'fs';
import archiver from 'archiver';
import stream from 'stream';
import { Upload } from '@aws-sdk/lib-storage';

export const createCsamReport = async ({
  reportedById,
  userId,
  images,
  ...props
}: CsamReportUserInput & { reportedById: number }) => {
  const exists = await dbRead.csamReport.count({ where: { userId } });
  if (exists) return;

  await dbWrite.csamReport.create({
    data: {
      userId,
      reportedById,
      details: props,
      images,
    },
  });

  /*
    TODO
    - ban user
    - cancel subscription
    - hide/unpublish content
  */
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

const getReportedImages = async (imageIds: number[]) => {
  return await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: {
      id: true,
      url: true,
      createdAt: true,
      name: true,
      type: true,
      meta: true,
      post: {
        select: { modelVersionId: true, modelVersion: { select: { modelId: true, name: true } } },
      },
    },
  });
};

export const getImageIpInfo = async ({
  userId,
  imageIds,
}: {
  userId: number;
  imageIds: number[];
}) => {
  if (!clickhouse) return [];

  const results = await clickhouse
    .query({
      query: `
        SELECT ip, imageId, time from default.images
        WHERE userId = ${userId} and type = 'Create'
      `,
      format: 'JSONEachRow',
    })
    .then((x) => x.json<{ ip: string; imageId: number; time: string }[]>());

  return results.filter((result) => imageIds.includes(result.imageId));
};

// TODO
const submitReport = async (
  data: any
): Promise<{ responseCode: number; responseDescription: string; reportId: number }> => {
  return {} as any;
};

// TODO
const finishReport = async (reportId: number) => {
  return {} as any;
};

// TODO
const uploadFile = async ({
  reportId,
  url,
}: {
  reportId: number;
  url: string;
}): Promise<{
  responseCode: number;
  responseDescription: string;
  reportId: number;
  fileId: string;
  hash: string;
}> => {
  return {} as any;
};

// TODO
const submitFileDetails = async (
  data: any
): Promise<{ responseCode: number; responseDescription: string; reportId: number }> => {
  return {} as any;
};

export const processCsamReport = async (report: CsamReportProps) => {
  const imageIds = report.images.map((x) => x.id);
  const reportingUser = await getReportingUser(report.reportedById);
  const reportedUser = await getReportedUser(report.userId);
  const reportedImages = await getReportedImages(imageIds);
  const imageIpInfo = await getImageIpInfo({ userId: report.userId, imageIds });
  const modelIds = [
    ...new Set(
      reportedImages
        .filter((x) =>
          report.modelVersionIds && x.post?.modelVersionId
            ? report.modelVersionIds.includes(x.post.modelVersionId)
            : true
        )
        .map((x) => x.post?.modelVersion?.modelId)
        .filter(isDefined)
    ),
  ];
  const models = await dbRead.model.findMany({
    where: { id: { in: modelIds } },
    select: { id: true, name: true },
  });

  const getModelsText = () => {
    if (!models.length) return '';
    return `
      \r\n
      \r\n
      Models used: [modelId:modelName], [modelVersionId:modelVersionName]
      \r\n
      ${[
        ...new Set(
          reportedImages
            .map((image) => {
              const model = models.find((x) => x.id === image.post?.modelVersion?.modelId);
              return `[${model?.id}:${model?.name}], [${image.post?.modelVersionId}:${image.post?.modelVersion?.name}]`;
            })
            .filter(isDefined)
        ),
      ].join('\r\n')}
    `;
  };

  const details = report.details;
  let additionalInfo: string | undefined;
  switch (details.origin) {
    case 'user':
      const { minorDepiction } = details as CsamUserReportInput;
      if (minorDepiction === 'non-real')
        additionalInfo = `${reportedUser?.username} (${report.userId}), appears to have used the following models' image/video generation and/or editing capabilities to produce sexual content depicting non-real minors.`;
      else
        additionalInfo = `${reportedUser?.username} (${report.userId}), appears to have used the following models' image/video editing capabilities to modify images of real minors for the apparent purpose of sexualizing them.`;

      additionalInfo += getModelsText();
      break;
    case 'testing':
      const { capabilities } = details as CsamTestingReportInput;
      additionalInfo = `
      The images/videos in this report were unintentionally and inadvertently generated or manipulated, during testing that is part of Civitai's trust and safety program, by the following models, one or more artificial intelligence-powered image/video generator.
      `;

      additionalInfo += getModelsText();

      if (capabilities.length) {
        additionalInfo += `
        \r\n
        \r\n
        The aforementioned model(s) can do the following:
        \r\n
        ${capabilities
          .map((key) => {
            const capability = csamCapabilitiesDictionary[key];
            return capability ? `- ${capability}` : undefined;
          })
          .filter(isDefined)
          .join('\r\n')}
        `;
      }
      break;
  }

  if (details.contents.length) {
    additionalInfo += `
    \r\n
    \r\n
    The images/videos in this report may involve:
    \r\n
    ${details.contents
      .map((key) => {
        const content = csamContentsDictionary[key];
        return content ? `- ${content}` : undefined;
      })
      .filter(isDefined)
      .join('\r\n')}
    `;
  }

  additionalInfo += `
    \r\n
    \r\n
    All evidence in this report should be independently verified.
  `;

  const reportPayload = {
    report: {
      incidentSummary: {
        incidentType: 'Child Pornography (possession, manufacture, and distribution)',
        incidentDateTime: new Date().toISOString(),
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
        personOrUserReportedPerson: {
          firstName: reportedUser?.name,
          email: reportedUser?.email,
        },
      },
      additionalInfo,
    },
  };

  const { reportId } = await submitReport(reportPayload);

  // TODO - post report payload
  const fileUploadResults = await Promise.all(
    reportedImages.map(async (image) => {
      const ipInfo = imageIpInfo.find((x) => x.imageId === image.id);
      const imageReportInfo = report.images.find((x) => x.id === image.id);

      const imageUrl = getEdgeUrl(image.url, image);
      const { prompt, negativePrompt } = image.meta as Record<string, unknown>;
      const modelId = image.post?.modelVersion?.modelId;
      const modelVersionId = image.post?.modelVersion?.modelId;
      const additionalInfo: string[] = [];
      if (modelId) additionalInfo.push(`model id: ${modelId}`);
      if (modelVersionId) additionalInfo.push(`model version id: ${modelVersionId}`);
      if (prompt) additionalInfo.push(`prompt: ${prompt}`);
      if (negativePrompt) additionalInfo.push(`negativePrompt: ${negativePrompt}`);

      const { fileId, hash } = await uploadFile({ reportId, url: imageUrl });

      const filePayload = {
        fileDetails: {
          reportId,
          fileId,
          originalFileName: image.name,
          locationOfFile: imageUrl,
          fileAnnotation: imageReportInfo?.fileAnnotations,
          ipCaptureEvent: {
            ipAddress: ipInfo?.ip,
            dateTime: ipInfo?.time,
          },
          additionalInfo: additionalInfo.length ? additionalInfo.join('\r\n') : undefined,
        },
      };

      await submitFileDetails(filePayload);

      return {
        ...imageReportInfo,
        fileId,
        hash,
      };
    })
  );

  // TODO - wrap everything in try catch
  // on catch, cancel the report

  await finishReport(reportId);

  await dbWrite.csamReport.update({
    where: { id: report.id },
    data: {
      images: fileUploadResults,
      reportSentAt: new Date(),
    },
  });
};

const imagesDir = `${process.cwd()}/csam-images`;
const zipDir = `${process.cwd()}/csam-zip`;
const getPath = (filename: string) => {
  return `${imagesDir}/${filename}`;
};

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

      parallelUploads3.on('httpUploadProgress', (progress) => {
        console.log({ progress });
      });

      readStream.pipe(passThroughStream);
      await parallelUploads3.done();
      console.dir('upload finished', { depth: null });
      resolve();
    } catch (e) {
      console.log(e);
      reject();
    }
  });
}

export const bundleCsamData = async ({ userId }: { userId: number }) => {
  const images = await dbRead.image.findMany({
    where: { userId },
    select: { id: true, url: true, type: true, name: true },
  });

  await Promise.all(
    images.map(async (image) => {
      const blob = await fetchBlob(getEdgeUrl(image.url, image));
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const imageName = image.name
        ? image.name.substring(0, image.name.lastIndexOf('.'))
        : image.url;
      const name = imageName.length ? imageName : image.url;
      const filename = `${name}.${blob.type.split('/').pop()}`;
      const path = getPath(filename);

      if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);
      await fsAsync.writeFile(path, buffer);
    })
  );

  if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir);
  const outPath = `${zipDir}/${userId}_csam.zip`;
  await zipDirectory(imagesDir, outPath);

  const readableStream = fs.createReadStream(outPath);
  await uploadStream({ stream: readableStream, userId, filename: 'images.zip' });
  readableStream.close();

  fs.rmSync(zipDir, { recursive: true });
  fs.rmSync(imagesDir, { recursive: true });
};

// TODO - remove user data
