import type { Prisma } from '@prisma/client';
import { BlockImageReason, CsamReportType } from '~/shared/utils/prisma/enums';
import type { CsamReport } from '~/shared/utils/prisma/models';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  CreateCsamReportSchema,
  GetImageResourcesOutput,
  CsamReportFormOutput,
} from '~/server/schema/csam.schema';
import type { GeneratorEvidenceDetails } from '~/server/services/generator-evidence/evidence-meta';
import { isGeneratorEvidenceDetails } from '~/server/services/generator-evidence/evidence-meta';
import { clickhouse } from '~/server/clickhouse/client';
import { getImageUploadIpEvents } from '~/server/services/image-upload-action.service';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { isDefined } from '~/utils/type-guards';
import { fetchBlob } from '~/utils/file-utils';
import { env } from '~/env/server';
import { getCsamBucket } from '~/server/services/csam-bucket';
import fsAsync from 'fs/promises';
import fs from 'fs';
import archiver from 'archiver';
import stream, { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { Upload } from '@aws-sdk/lib-storage';
import * as z from 'zod';
import plimit from 'p-limit';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import type { PaginationInput } from '~/server/schema/base.schema';
import type { Ncmec } from '~/server/http/ncmec/ncmec.schema';
import { isProd } from '~/env/other';
import { getFileForModelVersion } from '~/server/services/file.service';
import { MAX_POST_IMAGES_WIDTH } from '~/server/common/constants';
import { bulkAddBlockedImages } from '~/server/services/image.service';
import { csamSendClaimCutoff } from '~/server/services/csam.service-new';
import { logToAxiom } from '~/server/logging/client';
import { getConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';
import type { CsamContextText } from '~/server/services/csam-context-text';
import { foldContextText } from '~/server/services/csam-context-text';

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
    type: 'post' | 'model-version' | 'image-upload-request' | 'feedback-capture-upload';
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function unionLists<T>(stored: unknown, added: T[] | undefined, keyOf: (item: T) => unknown) {
  if (!Array.isArray(stored) && !added) return undefined;
  const kept = Array.isArray(stored) ? (stored as T[]) : [];
  const keys = new Set(kept.map(keyOf));
  return [...kept, ...(added ?? []).filter((item) => !keys.has(keyOf(item)))];
}

/** Keeps every image the report already names, with what was recorded on it, and adds the new ones. */
function foldImages(stored: unknown, added: { id: number }[]) {
  return unionLists(stored, added, (image) => image.id) ?? [];
}

type GeneratedImagesEntry = NonNullable<CsamReportFormOutput['generatedImages']>[number];

type FoldBlob = { url?: string; blobId?: string; status?: string; orchestratorJobId?: string };

/** A preserved file is one blob however many filings name it; a legacy file is its URL. A copy that
 *  was preserved replaces one that could not be, but never a moderator's exclusion. A kept blob
 *  takes the producing job id a later filing knows and it lacks. */
function foldBlobs(stored: unknown, added: unknown) {
  const byKey = new Map<unknown, FoldBlob>();
  for (const blob of [
    ...(Array.isArray(stored) ? stored : []),
    ...(Array.isArray(added) ? added : []),
  ] as FoldBlob[]) {
    const key = blob?.blobId ?? blob?.url;
    const kept = byKey.get(key);
    if (
      !kept ||
      (kept.status !== 'preserved' && kept.status !== 'excluded' && blob?.status === 'preserved')
    )
      byKey.set(
        key,
        kept?.orchestratorJobId && !blob.orchestratorJobId
          ? { ...blob, orchestratorJobId: kept.orchestratorJobId }
          : blob
      );
    else if (!kept.orchestratorJobId && blob?.orchestratorJobId)
      byKey.set(key, { ...kept, orchestratorJobId: blob.orchestratorJobId });
  }
  return [...byKey.values()];
}

/** One entry per job; a job named by both reports keeps the blobs of both. */
function foldGeneratedImages(stored: unknown, added: GeneratedImagesEntry[] | undefined) {
  if (!Array.isArray(stored) && !added) return undefined;
  const byJob = new Map<unknown, Record<string, unknown>>();
  const loose: unknown[] = [];
  for (const entry of [...(Array.isArray(stored) ? stored : []), ...(added ?? [])]) {
    if (!isRecord(entry) || typeof entry.jobId !== 'string') {
      loose.push(entry);
      continue;
    }
    const kept = byJob.get(entry.jobId);
    const blobs = (value: unknown) => (Array.isArray(value) ? value : undefined);
    if (!kept) byJob.set(entry.jobId, entry);
    else kept.blobs = foldBlobs(blobs(kept.blobs), blobs(entry.blobs));
  }
  return [...byJob.values(), ...loose];
}

/** The new form's answers win, except that a real-minor depiction is never downgraded. */
function foldDetails(stored: unknown, added: CsamReportFormOutput | undefined) {
  const prior = isRecord(stored) ? stored : {};
  const next = Object.fromEntries(
    Object.entries(added ?? {}).filter(([, value]) => value !== undefined)
  ) as CsamReportFormOutput;
  const folded: Record<string, unknown> = { ...prior, ...next };
  if (prior.minorDepiction === 'real') folded.minorDepiction = 'real';
  for (const key of ['modelVersionIds', 'capabilities', 'contents'] as const) {
    const list = unionLists<unknown>(prior[key], next[key], (item) => item);
    if (list) folded[key] = list;
  }
  const contextText = foldContextText(
    prior.contextText,
    (next as { contextText?: CsamContextText[] }).contextText
  );
  if (contextText) folded.contextText = contextText;
  const generatedImages = foldGeneratedImages(prior.generatedImages, next.generatedImages);
  if (generatedImages) folded.generatedImages = generatedImages;
  const nextEvidence = (next as Record<string, unknown>).generatorEvidence;
  if (isRecord(prior.generatorEvidence) || isRecord(nextEvidence)) {
    const before = isRecord(prior.generatorEvidence) ? prior.generatorEvidence : {};
    const after = isRecord(nextEvidence) ? nextEvidence : {};
    const priorCTReports = unionLists<unknown>(
      before.priorCTReports,
      after.priorCTReports as unknown[] | undefined,
      (n) => n
    );
    // Evidence added after an approval has not been reviewed, so the report waits again.
    folded.generatorEvidence = {
      ...before,
      ...after,
      ...(priorCTReports && { priorCTReports }),
      approvedAt: null,
      approvedById: null,
    };
  }
  return folded as Prisma.InputJsonObject;
}

// A training-data report sends and archives one version's data, so a filing folds only into a
// report on exactly its versions.
// A supplemental report's text and file set are fixed when it is filed. A filing with preserved
// generator evidence folds only into another such report, and a legacy URL-only filing only into a
// legacy one: the send reads evidence files from the evidence copy and legacy ones by URL.
const canFoldInto = (stored: unknown, filing: unknown) =>
  !(isRecord(stored) && 'supplemental' in stored) &&
  isGeneratorEvidenceDetails(stored) === isGeneratorEvidenceDetails(filing);

const trainingVersionFilter = (type: CsamReportType, details?: CsamReportFormOutput) =>
  type === CsamReportType.TrainingData
    ? { details: { path: ['modelVersionIds'], equals: details?.modelVersionIds ?? [] } }
    : {};

export async function createCsamReport({
  reportedById,
  userId,
  imageIds = [],
  details,
  type,
}: Omit<CreateCsamReportSchema, 'details'> & {
  reportedById: number;
  details?: CreateCsamReportSchema['details'] | GeneratorEvidenceDetails;
}) {
  const isInternalReport = userId === -1;
  const data = {
    userId: isInternalReport ? null : userId,
    reportedById,
    details,
    type,
    //map imageIds to objects so that we can append additional data to them later
    images: imageIds?.map((id) => ({ id })) ?? [],
  };

  // Only fold into a report of the same account AND type: internal reports belong to no account, and
  // a different type is a different report.
  const report = isInternalReport
    ? await dbWrite.csamReport.create({ data })
    : await dbWrite.$transaction(async (tx) => {
        // A report a send run has claimed is being sent from the copy it read: evidence folded into
        // it would never reach NCMEC, so the filing becomes a report of its own. An expired claim
        // is a run that died or stalled; the fold clears it, so that run cannot mark the report sent.
        const cutoff = csamSendClaimCutoff();
        const unsentWhere = {
          userId,
          type,
          reportSentAt: null,
          ...trainingVersionFilter(type, details as CsamReportFormOutput),
        };
        // Filtered here, not in the query: an earlier report this filing cannot fold into must not
        // hide a later one it can.
        const firstFoldable = async (where: Prisma.CsamReportWhereInput) =>
          (
            await tx.csamReport.findMany({
              where,
              select: { id: true, details: true },
              orderBy: { id: 'asc' },
            })
          ).find((row) => canFoldInto(row.details, details));
        const unsent = await firstFoldable({
          ...unsentWhere,
          OR: [{ sendClaimId: null }, { sendClaimedAt: { lt: cutoff } }],
        });
        const fileSeparately = async (claimedId?: number) => {
          const created = await tx.csamReport.create({ data });
          if (claimedId)
            logToAxiom({
              name: 'csam-report',
              type: 'info',
              subType: 'fold-skip-claimed',
              message: `report ${claimedId} is being sent; filed as report ${created.id}`,
              reportId: claimedId,
              newReportId: created.id,
            });
          return created;
        };
        if (!unsent) {
          const claimed = await firstFoldable(unsentWhere);
          return fileSeparately(claimed?.id);
        }

        // Locked and re-read, so two filings on the same report both land, and a claim taken since
        // the lookup is seen. A report sent since the lookup gets a new report instead.
        const [locked] = await tx.$queryRaw<
          Pick<CsamReport, 'images' | 'details' | 'sendClaimId' | 'sendClaimedAt'>[]
        >`
          SELECT images, details, "sendClaimId", "sendClaimedAt" FROM "CsamReport"
          WHERE id = ${unsent.id} AND "reportSentAt" IS NULL
          FOR UPDATE`;
        if (!locked) return fileSeparately();
        if (!canFoldInto(locked.details, details)) return fileSeparately();
        if (locked.sendClaimId && !(locked.sendClaimedAt && locked.sendClaimedAt < cutoff))
          return fileSeparately(unsent.id);

        return tx.csamReport.update({
          where: { id: unsent.id },
          data: {
            ...data,
            images: foldImages(locked.images, data.images),
            details: foldDetails(locked.details, details as CsamReportFormOutput),
            sendClaimId: null,
            sendClaimedAt: null,
          },
        });
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

function omitUserActivity(details: Prisma.JsonValue) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return details;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { userActivity, ...rest } = details;
  return rest;
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
    // The report's stored IP events are evidence for the report, not for this list.
    details: omitUserActivity(report.details),
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
    WHERE targetUserId = ${report.userId} AND (type = 'Registration' OR type = 'Login')
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
      captureEvents = captureEvents.concat(
        await getImageUploadIpEvents({ userId: report.userId, imageIds })
      );
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
    // Fetched server-side to build a report, not on a user's behalf.
    attribution: { caller: 'other', actor: 'internal' },
    redCapable: true,
  });
  if (modelFile.status !== 'success') throw new Error('training data not found');

  const response = await fetch(modelFile.url);
  if (!response.ok) throw new Error(`no training data exists for model version: ${versionId}`);
  if (!response.body) throw new Error(`no response body for model version: ${versionId}`);
  // Convert Web ReadableStream to Node.js Readable stream
  return Readable.fromWeb(response.body as NodeReadableStream);
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
  const { client, Bucket } = getCsamBucket();
  const passThroughStream = new stream.PassThrough();

  const date = new Date();
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
