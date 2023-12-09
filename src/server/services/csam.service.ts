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
import { CreateMultipartUploadCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '~/env/server.mjs';
import { completeMultipartUpload, getMultipartPutUrl } from '~/utils/s3-utils';
import fs from 'fs';

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

const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB
const uploadCsamZipFile = async ({ userId, file }: { userId: number; file: File }) => {
  if (
    !env.CSAM_UPLOAD_KEY ||
    !env.CSAM_UPLOAD_SECRET ||
    !env.CSAM_UPLOAD_REGION ||
    !env.CSAM_UPLOAD_ENDPOINT ||
    !env.CSAM_BUCKET_NAME
  )
    throw new Error('missing CSAM env vars');

  const s3 = new S3Client({
    credentials: {
      accessKeyId: env.CSAM_UPLOAD_KEY,
      secretAccessKey: env.CSAM_UPLOAD_SECRET,
    },
    region: env.CSAM_UPLOAD_REGION,
    endpoint: env.CSAM_UPLOAD_ENDPOINT,
  });

  const bucket = env.CSAM_BUCKET_NAME;
  const key = `${userId}/${file.name}`;

  const { urls, uploadId } = await getMultipartPutUrl(key, file.size, s3, bucket);
  if (!uploadId) throw new Error('missing upload id');

  const partsCount = urls.length;
  const uploadPart = (url: string, i: number) =>
    new Promise<boolean>((resolve) => {
      let eTag: string;
      const start = (i - 1) * FILE_CHUNK_SIZE;
      const end = i * FILE_CHUNK_SIZE;
      const part = i === partsCount ? file.slice(start) : file.slice(start, end);
      const xhr = new XMLHttpRequest();
      xhr.addEventListener('loadend', () => {
        const success = xhr.readyState === 4 && xhr.status === 200;
        if (success) {
          parts.push({ ETag: eTag, PartNumber: i });
          resolve(true);
        }
      });
      xhr.addEventListener('load', () => {
        eTag = xhr.getResponseHeader('ETag') ?? '';
      });
      xhr.addEventListener('error', () => resolve(false));
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(part);
    });

  const parts: { ETag: string; PartNumber: number }[] = [];
  for (const { url, partNumber } of urls as { url: string; partNumber: number }[]) {
    // Retry up to 3 times
    let retryCount = 0;
    while (retryCount < 3) {
      if (await uploadPart(url, partNumber)) break;
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 5000 * retryCount));
    }
  }

  await completeMultipartUpload(bucket, key, uploadId, parts, s3);
};

export const bundleCsamData = async ({ userId }: { userId: number }) => {
  const images = await dbRead.image.findMany({
    where: { userId },
    select: { id: true, url: true, type: true, name: true },
  });
  console.log(`images: ${images.length}`);

  const zip = new JSZip();
  console.log(1);
  await Promise.all(
    images.map(async (image) => {
      // Do I need to use the file system here?
      // console.log('url', getEdgeUrl(image.url, image));
      const blob = await fetchBlob(getEdgeUrl(image.url, image));
      const name = image.name ?? image.url;
      const lastIndex = name.lastIndexOf('.');
      console.log({ name: name.substring(0, lastIndex), type: blob.type });
      zip.file(`${name.substring(0, lastIndex)}.${blob.type.split('/').pop()}`, blob);
    })
  );
  console.log(2);

  zip
    .generateNodeStream({ type: 'nodebuffer', streamFiles: true })
    .pipe(fs.createWriteStream(`${userId}_csam.zip`))
    .on('finish', (stream) => {});
  // zip.generateAsync({ type: 'blob' }).then(async (content) => {
  //   const file = new File([content], `${userId}_csam.zip`, { type: 'application/zip' });
  //   console.log({ file });
  //   // await uploadCsamZipFile({ userId, file });
  // });
  console.log(3);
  // TODO - remove user data
};
