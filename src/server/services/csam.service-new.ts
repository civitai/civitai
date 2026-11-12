import type { ReadableStream as WebReadableStream } from 'stream/web';
import type { CsamReport } from '~/shared/utils/prisma/models';
import { dbRead, dbWrite } from '~/server/db/client';
import { kyselyV3Read } from '~/server/db/kyselyDb';
import type {
  CreateCsamReportSchema,
  CreateExternalCsamReportSchema,
  GetImageResourcesOutput,
  CsamReportFormOutput,
} from '~/server/schema/csam.schema';
import { csamContentsDictionary } from '~/server/schema/csam.schema';
import { clickhouse } from '~/server/clickhouse/client';
import {
  getImageUploadIpEvents,
  UPLOAD_REQUEST_IP_NOTE,
  FEEDBACK_CAPTURE_UPLOAD_IP_NOTE,
} from '~/server/services/image-upload-action.service';
import { isFeedbackCaptureOwner } from '@civitai/shared/feedback-capture';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { isDefined } from '~/utils/type-guards';
import { blobToFile, fetchBlob } from '~/utils/file-utils';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { env } from '~/env/server';
import { getCsamBucket } from '~/server/services/csam-bucket';
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
import { getFileForModelVersion } from '~/server/services/file.service';
import { CYBERTIP_CONTACT_EMAIL } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { Report } from '@civitai/cybertipline-tools';
import {
  Client,
  Environment,
  FileRelevance,
  IncidentType,
  IPEventName,
  ResponseCode,
} from '@civitai/cybertipline-tools';
import { Limiter } from '~/server/utils/concurrency-helpers';
import type { BoundedArchive } from '~/server/utils/archive-helpers';
import {
  createBoundedArchive,
  createByteBudget,
  FAILED_ARCHIVE_SETTLE_MS,
  deriveUploadPartGeometry,
  ESTIMATED_BYTES_PER_ARCHIVED_IMAGE,
  MEDIA_ARCHIVE_COMPRESSION_LEVEL,
  zipEntryNameForUrl,
} from '~/server/utils/archive-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import type { JsonReplacer } from '~/server/utils/json-stream-helpers';
import { writeJsonObject } from '~/server/utils/json-stream-helpers';
import {
  FlaggedConsumerFetchError,
  getConsumerStrikes,
} from '~/server/http/orchestrator/flagged-consumers';
import type { ShownRendition } from '@civitai/shared/held-media';
import { SHOWN_ACTIONS, shownActivity } from '@civitai/shared/held-media';
import { logToAxiom } from '~/server/logging/client';
import type { CsamSupplementalDetails } from '~/server/services/csam-supplemental-text';
import { supplementalReportText } from '~/server/services/csam-supplemental-text';
import type { CsamContextText } from '~/server/services/csam-context-text';
import { contextWebPageIncidents } from '~/server/services/csam-context-text';
import { csamArchivePathFor, recordCsamArchive } from '~/server/metrics/csam-archive.metrics';
import type { GeneratorEvidenceDetails } from '~/server/services/generator-evidence/evidence-meta';
import type { StoredEvidenceBlob } from '~/server/services/generator-evidence/preserve-blob';
import { MAX_EVIDENCE_BYTES } from '~/server/services/generator-evidence/preserve-blob';
import {
  isAwaitingEvidenceApproval,
  isGeneratorEvidenceDetails,
  unsentGeneratorEvidenceWhere,
} from '~/server/services/generator-evidence/evidence-meta';
import {
  evidenceFileDetails,
  evidenceFilesToSend,
  evidenceReportInfo,
  evidenceSizeProblem,
  promptFileDetails,
  readVerifiedEvidence,
  verifyStoredEvidence,
} from '~/server/services/generator-evidence/evidence-payload';
import {
  hashEvidenceObject,
  streamEvidenceObject,
} from '~/server/services/generator-evidence/evidence-store';
import { getViewedEvidence } from '~/server/services/generator-evidence/evidence-views';
import type {
  ClearedUnconfirmedOpen,
  UnconfirmedOpen,
} from '~/server/services/csam-unconfirmed-open';
import { isUnreadableAnswer } from '~/server/services/csam-unconfirmed-open';
import {
  CSAM_SEND_CLAIM_EXPIRY_SECONDS,
  csamSendClaimCutoff,
} from '~/server/services/csam-send-claim';
import type { SpoolBudget, SpooledFile } from '~/server/services/csam-evidence-spool';
import {
  MAX_ARCHIVE_BYTES,
  SpoolLimitError,
  skippedEntries,
  spoolBudget,
  spooledFile,
  spoolStream,
  spoolUrl,
  spoolZip,
} from '~/server/services/csam-evidence-spool';
import type { FileDetailsXml } from '~/server/services/ncmec-xml';
import { cyberTipXmlProblem, xmlText } from '~/server/services/ncmec-xml';
import { isEdgeUrlPassthrough } from '~/shared/utils/edge-url-passthrough';
import type {
  OriginalImageRead,
  OriginalImageSource,
  SpooledImage,
} from '~/server/services/csam-original-image';
import {
  extensionForContentType,
  probeOriginalImage,
  readOriginalImage,
  spoolOriginalImage,
} from '~/server/services/csam-original-image';

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

type EvidenceFileRecord = {
  source: OriginalImageSource;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  reason?: string;
};

type CsamReportImage = {
  id: number;
  fileAnnotations?: Ncmec.FileAnnotationsSchema;
  /** The `fileViewedByEsp` sent for this file. */
  viewedByEsp?: boolean;
  /** Which copy the record behind a true `viewedByEsp` says was on screen. */
  viewRendition?: ShownRendition;
} & CsamReportUploadProps &
  Partial<EvidenceFileRecord>;

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
  /** What NCMEC returned for each generated image sent; `generatedImages` stays as filed. */
  generatedImageUploads?: CsamReportGeneratedImageData[];
  /** Why the archive stored less than the report's evidence. */
  archiveSkipped?: string;
  /** Failed reads of each file across send runs, by image id or generated-image URL. */
  readFailures?: Record<string, number>;
  /** CyberTips opened for this report and cancelled before it was sent. */
  cancelledReportIds?: number[];
  supplemental?: CsamSupplementalDetails;
  contextText?: CsamContextText[];
  /** CyberTips opened for this report that could not be cancelled, so may have reached NCMEC. */
  possibleDuplicateReportIds?: number[];
  /** Opens whose answer could not be read: nothing more is sent until a moderator clears them. */
  unconfirmedOpens?: UnconfirmedOpen[];
  clearedUnconfirmedOpens?: ClearedUnconfirmedOpen[];
  /**
   * The case and reason a send run last held this report unsent for a moderator, written when the
   * case changes and removed when the report is sent.
   */
  sendHold?: SendHold;
};

/** `no-files`: nothing the report names can be sent. `missing-user`: no reporting or reported user. */
type SendHoldCase = 'no-files' | 'missing-user';
type SendHold = { case: SendHoldCase; reason: string; at: string };

type StoredObject = { key: string; etag: string | null };

/** Only image or video bytes count as an archived copy of a named item. */
const isArchivedMedia = (blob: Blob) => /^(image|video)\//.test(blob.type);

export type CsamArchiveObjectKind = 'base' | 'images' | 'generatedImages' | 'trainingData';

type ArchivedObject = StoredObject & {
  kind: CsamArchiveObjectKind;
  entries?: number;
  namedExpected?: number;
  namedMissing?: number;
};

export type CsamReportProps = Omit<CsamReport, 'details' | 'images'> & {
  details: CsamReportDetails;
  images: CsamReportImage[];
};

const baseDir = `${isProd && env.DIRNAME ? env.DIRNAME : process.cwd()}/csam`;

const IMAGES_ARCHIVE_MANIFEST_NAME = 'manifest.json';

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
  return data.filter(
    (report) => !isAwaitingEvidenceApproval(report.details)
  ) as unknown as CsamReportProps[];
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
  // A skipped archive is not retried. One skipped for missing training data keeps `archivedAt` null:
  // the image retention holds release a user's images once all their reports are archived.
  const reports = (data as unknown as CsamReportProps[]).filter(
    (report) => !report.details?.archiveSkipped
  );
  // A stamp over an archive holding none of the report's files would be false, so these are left
  // unstamped, and held. A generator-evidence report's files are preserved copies keyed in the CSAM
  // bucket, which this archive cannot read; a generated-image report naming no URL has nothing it
  // can read, since the strikes list is gone.
  const unsupported = (report: CsamReportProps) =>
    isGeneratorEvidenceDetails(report.details)
      ? 'generator evidence archive not supported'
      : report.type === 'GeneratedImage' && !namedGeneratedImageUrls(report).size
      ? 'no generated image URL to archive'
      : undefined;
  const skipped = new Map<string, number>();
  for (const report of reports) {
    const reason = unsupported(report);
    if (reason) skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of skipped)
    logToAxiom({
      name: 'csam-report',
      type: 'info',
      subType: 'archive-skipped-unsupported',
      message: `${count} report(s) not archived: ${reason}`,
      reason,
      count,
    });
  return reports.filter((report) => !unsupported(report));
}

const namedGeneratedImageUrls = (report: Pick<CsamReportProps, 'details'>) =>
  new Set(
    (report.details?.generatedImages ?? []).flatMap(({ blobs }) =>
      (blobs ?? []).flatMap(({ url }) => (url ? [url] : []))
    )
  );

// Excludes reports whose archive was skipped for missing training data: they never get archivedAt.
// Decide how to treat them before scheduling content removal.
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
      userId: true,
      url: true,
      createdAt: true,
      name: true,
      type: true,
      mimeType: true,
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

/** The scratch roots of the legacy sends, each holding one `<reportId>-<claimId>` directory per run. */
const SEND_SCRATCH_ROOTS = ['generated-send', 'training-data', 'external-send'];
const SEND_SCRATCH_NAME = /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Removes the send scratch directories no live claim owns: a run that died never reached its own
 * cleanup. Archive directories in the same roots, named by report id alone, are left.
 */
export async function sweepStaleSendDirs(root = baseDir) {
  const found: { path: string; reportId: number; claimId: string }[] = [];
  for (const scratch of SEND_SCRATCH_ROOTS) {
    const rootDir = `${root}/${scratch}`;
    const names = await fsAsync.readdir(rootDir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    for (const name of names) {
      const match = SEND_SCRATCH_NAME.exec(name);
      if (match)
        found.push({ path: `${rootDir}/${name}`, reportId: Number(match[1]), claimId: match[2] });
    }
  }
  if (!found.length) return [];

  const live = await dbWrite.csamReport.findMany({
    where: {
      id: { in: [...new Set(found.map(({ reportId }) => reportId))] },
      sendClaimId: { not: null },
      sendClaimedAt: { gte: csamSendClaimCutoff() },
    },
    select: { id: true, sendClaimId: true },
  });
  const liveDirs = new Set(live.map(({ id, sendClaimId }) => `${id}-${sendClaimId}`));
  const stale = found.filter(({ reportId, claimId }) => !liveDirs.has(`${reportId}-${claimId}`));
  for (const { path } of stale) await fsAsync.rm(path, { recursive: true, force: true });
  return stale.map(({ path }) => path);
}

const ARCHIVE_SCRATCH_ROOTS = ['base', 'images', 'generated-images', 'training-data'];

/**
 * Removes the archive scratch directories, named by report id alone, that a pass which died left
 * behind. Run only at the start of the archive job, whose run lock keeps other archive passes out
 * while it holds; a pass that outlives the lock can lose its directory here and fail. Send directories in the same roots are named `<id>-<claim>` and are left.
 */
export async function sweepArchiveScratchDirs(root = baseDir) {
  const removed: string[] = [];
  for (const scratch of ARCHIVE_SCRATCH_ROOTS) {
    const rootDir = `${root}/${scratch}`;
    const names = await fsAsync.readdir(rootDir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    for (const name of names.filter((name) => /^\d+$/.test(name))) {
      await fsAsync.rm(`${rootDir}/${name}`, { recursive: true, force: true });
      removed.push(`${rootDir}/${name}`);
    }
  }
  return removed;
}

/** `runStart` is the job's copy of the report; the send works from the row re-read under its claim. */
export async function processCsamReport(runStart: CsamReportProps) {
  const status = await cybertipClient.getStatus();
  if (isDev) console.log({ status });
  if (status.data.responseCode !== 0) return;

  const claim = await claimForSend(runStart.id);
  if (!claim) return;
  try {
    switch (claim.report.type) {
      case 'Image':
        return await reportImages(claim);
      case 'GeneratedImage':
        return await reportGenerationData(claim);
      case 'TrainingData':
        return await reportTrainingData(claim);
      case 'ExternalLink':
        return await reportExternalLink(claim);
    }
  } finally {
    await releaseClaim(claim);
  }
}

/** Filed with each feedback page capture in an image report, whoever the report's subject is. */
export const FEEDBACK_CAPTURE_FILE_NOTE =
  'Page capture submitted by a reporter: this file is a screenshot of a Civitai page that a user attached to a feedback report sent to Civitai. It may show content posted by an account other than the one who submitted it.';

export function getReportedUserAdditionalInfo(
  email: string | null,
  userActivity: CsamReportUserActivity[]
) {
  return (
    [
      email ? `Email: ${email}` : null,
      userActivity.some((a) => a.details?.type === 'image-upload-request')
        ? UPLOAD_REQUEST_IP_NOTE
        : null,
      userActivity.some((a) => a.details?.type === 'feedback-capture-upload')
        ? FEEDBACK_CAPTURE_UPLOAD_IP_NOTE
        : null,
    ]
      .filter(Boolean)
      .join('\n') || undefined
  );
}

const activityKey = (a: CsamReportUserActivity) =>
  [a.type, a.ip, a.time, a.details?.type, a.details?.id].join('|');

function mergeUserActivity(stored: CsamReportUserActivity[], live: CsamReportUserActivity[]) {
  const seen = new Set(stored.map(activityKey));
  return stored.concat(live.filter((a) => !seen.has(activityKey(a))));
}

/**
 * The report's IP events: those stored on it plus any ClickHouse still holds, written back to the
 * report before it is sent. Every unsent report passes here on each send run, so its IPs are kept
 * on the report from its first run on, though the ClickHouse rows expire (upload requests after 12
 * months). Undefined when the claim was lost.
 */
async function snapshotUserActivity(claim: SendClaim) {
  const stored = claim.report.details?.userActivity ?? [];
  const merged = mergeUserActivity(stored, await getUserIpInfo(claim.report));
  if (isProd && merged.length > stored.length) {
    const written = await updateUnderClaim(claim, 'ip-snapshot', {}, (current) => ({
      ...current,
      userActivity: mergeUserActivity(current.userActivity ?? [], merged),
    }));
    if (!written) return;
  }
  return merged;
}

async function getInitialReportData(claim: SendClaim) {
  const { report } = claim;
  const reportingUser = await getReportingUser(report.reportedById);
  const reportedUser = report.userId ? await getReportedUser(report.userId) : undefined;
  if (!reportingUser || !reportedUser)
    return await holdForDecision(claim, 'missing-user', 'no reporting or reported user');

  const userActivity = await snapshotUserActivity(claim);
  if (!userActivity) return;
  const reportedUserInfo = getReportedUserAdditionalInfo(reportedUser.email, userActivity);

  return {
    incidentSummary: {
      incidentType: IncidentType.ChildPornography,
      incidentDateTime: report.createdAt,
    },
    reporter: {
      reportingPerson: {
        email: reportingUser.email ? [{ email: xmlText(reportingUser.email) }] : [],
        firstName: reportingUser.name ? xmlText(reportingUser.name) : undefined,
      },
      contactPerson: {
        email: [{ email: CYBERTIP_CONTACT_EMAIL }],
      },
    },
    personOrUserReported: {
      espIdentifier: reportedUser.id.toString(),
      screenName: reportedUser.username ? xmlText(reportedUser.username) : undefined,
      ipCaptureEvent: userActivity?.map((activity) => {
        const [year, month, day, hour, minute, second] = activity.time.split(/[-: ]/).map(Number);
        return {
          ipAddress: activity.ip,
          eventName: IPEventName[activity.type],
          dateTime: new Date(Date.UTC(year, month - 1, day, hour, minute, second)),
        };
      }),
      additionalInfo: reportedUserInfo && xmlText(reportedUserInfo),
    },
  } satisfies Report;
}

export const CSAM_SEND_BLOCKED_AFTER_HOURS = 6;

export const CSAM_SEND_SHORT_AFTER_HOURS = 24;
export const CSAM_SEND_SHORT_MIN_READ_FAILURES = 2;

/** Hours after filing at which a report none of whose files can be read needs a human decision. */
export const CSAM_SEND_DECISION_AFTER_HOURS = 48;

export const SEND_SHORT_REASON = 'storage read failed after retries';

/** Hours after sending for which the archive retries a full-URL file before recording it missing. */
export const CSAM_ARCHIVE_GIVE_UP_AFTER_HOURS = 24;

const hoursSinceFiled = (report: { createdAt: Date }) =>
  Math.floor((Date.now() - report.createdAt.getTime()) / 3_600_000);

function logSendFailure(
  report: CsamReportProps,
  e: unknown,
  subType: string,
  ncmecReportId?: number
) {
  logToAxiom({
    name: 'csam-report',
    type: 'error',
    subType,
    message: (e as Error | undefined)?.message,
    reportId: report.id,
    ncmecReportId,
    hoursPending: hoursSinceFiled(report),
  });
}

export async function logBlockedCsamReports(reportIds: number[]) {
  if (!reportIds.length) return;
  // The primary: a replica may not have this run's sends yet.
  const unsent = await dbWrite.csamReport.findMany({
    where: { id: { in: reportIds }, reportSentAt: null },
    select: { id: true, createdAt: true },
  });
  for (const report of unsent) {
    const hoursPending = hoursSinceFiled(report);
    if (hoursPending < CSAM_SEND_BLOCKED_AFTER_HOURS) continue;
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      subType: 'send-blocked',
      message: `report ${report.id} unsent after ${hoursPending} hours`,
      reportId: report.id,
      hoursPending,
    });
  }
}

export const CSAM_EVIDENCE_APPROVAL_OVERDUE_HOURS = 24;

/** A preserved-evidence report the send job skips until a moderator approves it, left waiting too long. */
export async function logOverdueEvidenceApprovals() {
  const waiting = await dbWrite.csamReport.findMany({
    where: {
      ...unsentGeneratorEvidenceWhere,
      createdAt: { lt: new Date(Date.now() - CSAM_EVIDENCE_APPROVAL_OVERDUE_HOURS * 3_600_000) },
    },
    select: { id: true, createdAt: true, details: true },
  });
  for (const report of waiting) {
    if (!isAwaitingEvidenceApproval(report.details)) continue;
    const hoursPending = hoursSinceFiled(report);
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      subType: 'send-blocked',
      message: `report ${report.id} has waited ${hoursPending} hours for a moderator to approve its evidence`,
      reportId: report.id,
      hoursPending,
      awaiting: 'evidence-approval',
    });
  }
}

export { CSAM_SEND_CLAIM_EXPIRY_SECONDS, csamSendClaimCutoff };

type SendClaim = {
  claimId: string;
  /** The report as stored when the claim was taken. No filing folds into it while the claim holds. */
  report: CsamReportProps;
  /** The CyberTip this run opened. */
  ncmecReportId?: number;
  /** The claim is no longer this run's: released, lost, or the report sent or deleted under it. */
  settled?: boolean;
};

const underClaim = (claim: SendClaim) => ({
  id: claim.report.id,
  sendClaimId: claim.claimId,
  reportSentAt: null,
});

function logSendLine(
  claim: SendClaim,
  subType: string,
  fields: Record<string, unknown> = {},
  type: 'info' | 'error' = 'info'
) {
  logToAxiom({
    name: 'csam-report',
    type,
    subType,
    reportId: claim.report.id,
    ncmecReportId: claim.ncmecReportId,
    ...fields,
  });
}

async function claimForSend(reportId: number): Promise<SendClaim | undefined> {
  const claimId = randomUUID();
  const { count } = await dbWrite.csamReport.updateMany({
    where: {
      id: reportId,
      reportSentAt: null,
      OR: [{ sendClaimId: null }, { sendClaimedAt: { lt: csamSendClaimCutoff() } }],
    },
    data: { sendClaimId: claimId, sendClaimedAt: new Date() },
  });
  if (count === 0) {
    logToAxiom({
      name: 'csam-report',
      type: 'info',
      subType: 'send-claim-held',
      message: `report ${reportId} is sent or held by another run`,
      reportId,
    });
    return;
  }
  const report = await dbWrite.csamReport.findFirst({
    where: { id: reportId, sendClaimId: claimId },
  });
  const claim: SendClaim = { claimId, report: report as unknown as CsamReportProps };
  if (!report) {
    claim.report = { id: reportId } as CsamReportProps;
    claim.settled = true;
    logSendLine(
      claim,
      'send-claim-lost',
      { message: `report ${reportId} claim lost at claim` },
      'error'
    );
    return;
  }
  return claim;
}

/**
 * Writes to the report only while this run's claim holds. A details change is applied to the row
 * re-read under the claim, not to this run's copy.
 */
async function updateUnderClaim(
  claim: SendClaim,
  step: string,
  data: Prisma.CsamReportUpdateManyMutationInput,
  patchDetails?: (details: CsamReportDetails) => CsamReportDetails,
  lostSubType = 'send-claim-lost'
) {
  let count = 0;
  if (!claim.settled) {
    const current = patchDetails
      ? await dbWrite.csamReport.findFirst({ where: underClaim(claim), select: { details: true } })
      : undefined;
    if (!patchDetails || current) {
      const details = current
        ? (patchDetails?.({ ...(current.details as CsamReportDetails) }) as Prisma.InputJsonObject)
        : undefined;
      ({ count } = await dbWrite.csamReport.updateMany({
        where: underClaim(claim),
        data: { ...data, ...(details && { details }) },
      }));
    }
  }
  if (count === 0) {
    claim.settled = true;
    logSendLine(
      claim,
      lostSubType,
      { message: `report ${claim.report.id} claim lost at ${step}` },
      'error'
    );
  }
  return count > 0;
}

/** Merged into the stored details rather than written from this run's copy, which may be stale. */
async function recordReadFailures(claim: SendClaim, readFailures: Record<string, number>) {
  if (!isProd) return;
  await dbWrite.$executeRaw`
    UPDATE "CsamReport"
    SET details = COALESCE(NULLIF(details, 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('readFailures', ${JSON.stringify(
      readFailures
    )}::jsonb)
    WHERE id = ${claim.report.id} AND "sendClaimId" = ${
    claim.claimId
  }::uuid AND "reportSentAt" IS NULL
  `;
}

/** Archive entries skipped as empty or unreadable: the report is sent without them, and says so. */
async function recordSkippedEntries(claim: SendClaim, budget: SpoolBudget) {
  const skipped = skippedEntries(budget);
  if (!skipped) return;
  logSendLine(
    claim,
    'send-entries-skipped',
    {
      message: `report ${claim.report.id} skips ${skipped.count} archive entries`,
      empty: skipped.empty,
      unreadable: skipped.unreadable,
    },
    'error'
  );
  if (!isProd) return;
  await dbWrite.$executeRaw`
    UPDATE "CsamReport"
    SET details = COALESCE(NULLIF(details, 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('skippedArchiveEntries', ${JSON.stringify(
      skipped
    )}::jsonb)
    WHERE id = ${claim.report.id} AND "sendClaimId" = ${
    claim.claimId
  }::uuid AND "reportSentAt" IS NULL
  `;
}

const appendId =
  (key: 'cancelledReportIds' | 'possibleDuplicateReportIds', id: number) =>
  (details: CsamReportDetails) => ({ ...details, [key]: [...(details[key] ?? []), id] });

/**
 * Keeps a report the send cannot file unsent, marked with why, for a moderator to decide. Any
 * CyberTip an earlier run left for it stays as it is and is named on the line.
 */
async function holdForDecision(claim: SendClaim, holdCase: SendHoldCase, reason: string) {
  const { report } = claim;
  const possibleDuplicates = report.details?.possibleDuplicateReportIds ?? [];
  const unconfirmed = report.details?.unconfirmedOpens ?? [];
  const fields = {
    message: `report ${report.id} held (${holdCase}): ${reason}`,
    case: holdCase,
    hoursPending: hoursSinceFiled(report),
    ncmecReportId: report.reportId ?? undefined,
    possibleDuplicateReportIds: possibleDuplicates,
    unconfirmedOpens: unconfirmed.length,
  };
  logSendLine(claim, 'send-held', fields, 'error');
  logSendLine(claim, 'send-decision-needed', fields, 'error');
  await recordSendHold(claim, holdCase, reason);
}

async function recordSendHold(claim: SendClaim, holdCase: SendHoldCase, reason: string) {
  if (!isProd || claim.report.details?.sendHold?.case === holdCase) return;
  const sendHold: SendHold = { case: holdCase, reason, at: new Date().toISOString() };
  await updateUnderClaim(claim, 'send-hold', {}, (details) => ({ ...details, sendHold }));
}

async function releaseClaim(claim: SendClaim) {
  if (claim.settled) return;
  claim.settled = true;
  const { count } = await dbWrite.csamReport.updateMany({
    where: { id: claim.report.id, sendClaimId: claim.claimId },
    data: { sendClaimId: null, sendClaimedAt: null },
  });
  if (count === 0)
    logSendLine(
      claim,
      'send-claim-lost',
      { message: `report ${claim.report.id} claim lost at release` },
      'error'
    );
}

const ANSWERED_ALREADY_FINISHED = ` - ${ResponseCode[ResponseCode.ReportAlreadyFinished]} `;
const ANSWERED_ALREADY_RETRACTED = ` - ${ResponseCode[ResponseCode.ReportAlreadyRetracted]} `;

/**
 * NCMEC answers the cancel of a CyberTip already finished or already retracted with a response code
 * the client either resolves with or names in the error it throws, depending on the HTTP status.
 */
async function cancelCyberTip(id: number) {
  try {
    const { data } = await cybertipClient.cancelReport({ id });
    if (data.responseCode === ResponseCode.ReportAlreadyFinished)
      return { outcome: 'finished' as const };
    if (data.responseCode === ResponseCode.ReportAlreadyRetracted)
      return { outcome: 'retracted' as const };
    return { outcome: 'cancelled' as const };
  } catch (e) {
    const message = (e as Error | undefined)?.message;
    if (message?.includes(ANSWERED_ALREADY_FINISHED))
      return { outcome: 'finished' as const, message };
    if (message?.includes(ANSWERED_ALREADY_RETRACTED))
      return { outcome: 'retracted' as const, message };
    return { outcome: 'failed' as const, message };
  }
}

/**
 * A stored NCMEC id on an unsent report is a CyberTip an earlier run opened and never confirmed sent.
 * It is cancelled before another is opened; one that is finished, or cannot be cancelled, may be with
 * NCMEC, and a duplicate beats a missed report, so the report is sent again and the row notes which.
 */
async function cancelStoredCyberTip(
  claim: SendClaim
): Promise<'none' | 'cancelled' | 'held' | 'lost'> {
  const stored = claim.report.reportId;
  if (stored == null) return 'none';
  // Outside production the stored ids are not this environment's CyberTips.
  if (!isProd) return 'held';
  const { outcome, message } = await cancelCyberTip(stored);
  const delivered = outcome === 'finished' || outcome === 'failed';
  if (delivered)
    logSendLine(
      claim,
      'send-possible-duplicate',
      { ncmecReportId: stored, cancelOutcome: outcome, message },
      'error'
    );
  else
    logSendLine(claim, outcome === 'retracted' ? 'send-cancel-already-retracted' : 'send-cancel', {
      ncmecReportId: stored,
    });
  const recorded = await updateUnderClaim(
    claim,
    'cancel-stored',
    { reportId: null },
    appendId(delivered ? 'possibleDuplicateReportIds' : 'cancelledReportIds', stored)
  );
  if (!recorded) return 'lost';
  return delivered ? 'held' : 'cancelled';
}

/** A report naming no file that can be sent opens no CyberTip: it waits, alerted and held, for a decision. */
async function logNoFiles(claim: SendClaim, message: string) {
  const hoursPending = hoursSinceFiled(claim.report);
  // A CyberTip an earlier run left open is named, so whoever decides sees it.
  const stored = {
    case: 'no-files' satisfies SendHoldCase,
    ncmecReportId: claim.report.reportId ?? undefined,
  };
  logSendLine(claim, 'send-no-files', { message, hoursPending, ...stored }, 'error');
  if (hoursPending >= CSAM_SEND_DECISION_AFTER_HOURS)
    logSendLine(
      claim,
      'send-decision-needed',
      {
        message: `report ${claim.report.id} has had no file to send for ${hoursPending} hours`,
        hoursPending,
        ...stored,
      },
      'error'
    );
  await recordSendHold(claim, 'no-files', message);
}

/**
 * XML NCMEC refuses would open and cancel a CyberTip on every run, and no retry changes it: the report
 * waits for a decision from the first run on.
 */
function logXmlProblem(claim: SendClaim, problem: string) {
  const hoursPending = hoursSinceFiled(claim.report);
  const stored = { ncmecReportId: claim.report.reportId ?? undefined };
  const message = `report ${claim.report.id} would not be well-formed XML: ${problem}`;
  logSendLine(claim, 'send-xml', { message, hoursPending, ...stored }, 'error');
  logSendLine(claim, 'send-decision-needed', { message, hoursPending, ...stored }, 'error');
}

/**
 * NCMEC answered the open in a shape the client could not read, so a CyberTip may be open there with
 * no id here. Another open could leave another on every run, so the report waits for a moderator.
 */
async function holdUnconfirmedOpen(claim: SendClaim, e: Error) {
  const message = `report ${claim.report.id}: the answer to its CyberTip open could not be read, so one may be open at NCMEC with no id here (${e.message})`;
  logSendLine(claim, 'send-open-unconfirmed', { message }, 'error');
  logSendLine(claim, 'send-decision-needed', { message }, 'error');
  if (!isProd) return;
  const open: UnconfirmedOpen = { at: new Date().toISOString(), message: e.message };
  // Appended in one statement and not under the claim: a run that lost its claim mid-open must still
  // hold the report, or the next run opens again.
  await dbWrite.$executeRaw`
    UPDATE "CsamReport"
    SET details = COALESCE(NULLIF(details, 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(
      'unconfirmedOpens',
      COALESCE(details->'unconfirmedOpens', '[]'::jsonb) || ${JSON.stringify([open])}::jsonb
    )
    WHERE id = ${claim.report.id} AND "reportSentAt" IS NULL
  `;
}

function logHeldOnUnconfirmedOpen(claim: SendClaim) {
  const opens = claim.report.details?.unconfirmedOpens ?? [];
  logSendLine(
    claim,
    'send-decision-needed',
    {
      message: `report ${claim.report.id} is held: ${opens.length} earlier open(s) may have left a CyberTip at NCMEC with no id here. Check with NCMEC, then clear it to send.`,
      hoursPending: hoursSinceFiled(claim.report),
      unconfirmedOpens: opens.length,
    },
    'error'
  );
}

/** Sends files two at a time; once one fails, none still queued goes to the CyberTip being cancelled. */
function sendEach<T, R>(items: T[], send: (item: T) => Promise<R>, concurrency = 2) {
  const limit = plimit(concurrency);
  const started: Promise<unknown>[] = [];
  const sent = Promise.all(
    items.map((item) =>
      limit(() => {
        const sending = send(item);
        started.push(sending);
        return sending.catch((e) => {
          limit.clearQueue();
          throw e;
        });
      })
    )
  );
  return { sent, settled: async () => void (await Promise.allSettled(started)) };
}

async function uploadToCyberTip(claim: SendClaim, file: File) {
  const result = await cybertipClient.uploadFile({ id: claim.ncmecReportId as number, file });
  logSendLine(claim, 'send-upload', { fileId: result.data.fileId });
  return result;
}

/**
 * The one way a report is sent: open the CyberTip, store its id, send the files, finish it, then mark
 * the report sent and release the claim in one write. The report is marked sent only once NCMEC has
 * the finished CyberTip, so a failure anywhere before leaves it unsent for the next run.
 *
 * A run that dies between opening the CyberTip and storing its id leaves an open CyberTip no run
 * knows of; the next run opens another. An open NCMEC answered unreadably holds the report instead.
 *
 * The report and every file's details are checked as the XML NCMEC is sent before anything is opened.
 *
 * Resolves to whether NCMEC has the finished CyberTip.
 */
async function sendCyberTip(
  claim: SendClaim,
  cyberTip: Report,
  {
    fileDetails,
    sendFiles,
    beforeCancel,
    failureSubType = 'archive-data',
  }: {
    /** The details each file will be sent with, but for its fileId. */
    fileDetails: FileDetailsXml[];
    /** Resolves to the details keys the report is marked sent with. */
    sendFiles: (ncmecReportId: number) => Promise<Record<string, unknown> | void>;
    beforeCancel?: () => Promise<void>;
    failureSubType?: string;
  }
) {
  if (claim.report.details?.unconfirmedOpens?.length) {
    logHeldOnUnconfirmedOpen(claim);
    return false;
  }
  const xmlProblem = cyberTipXmlProblem(cyberTip, fileDetails);
  if (xmlProblem) {
    logXmlProblem(claim, xmlProblem);
    return false;
  }
  if ((await cancelStoredCyberTip(claim)) === 'lost') return false;

  let ncmecReportId: number;
  try {
    ({
      data: { reportId: ncmecReportId },
    } = await cybertipClient.submitReport(cyberTip));
  } catch (e) {
    if (!isUnreadableAnswer(e)) throw e;
    await holdUnconfirmedOpen(claim, e as Error);
    return false;
  }
  claim.ncmecReportId = ncmecReportId;
  logSendLine(claim, 'send-open');

  let details: Record<string, unknown> | void;
  try {
    if (isProd && !(await updateUnderClaim(claim, 'open', { reportId: ncmecReportId })))
      throw new Error('send claim lost');
    details = await sendFiles(ncmecReportId);
    const finish = await cybertipClient.finishReport({ id: ncmecReportId });
    // The client resolves a finish of a retracted CyberTip as it does a finished one.
    if (finish?.data?.responseCode === ResponseCode.ReportAlreadyRetracted)
      throw new Error('the CyberTip was retracted before it was finished');
    logSendLine(claim, 'send-finish');
  } catch (e) {
    logSendFailure(claim.report, e, failureSubType, ncmecReportId);
    await beforeCancel?.();
    const { outcome, message } = await cancelCyberTip(ncmecReportId);
    if (outcome === 'failed') {
      // Left stored: the next run cancels it before opening another.
      logSendLine(claim, 'send-cancel-failed', { message }, 'error');
      return false;
    }
    if (outcome === 'finished') {
      // The finish reached NCMEC after every file had gone, so the report is sent, not sent again.
      logSendLine(
        claim,
        'send-cancel-already-finished',
        {
          message: `report ${claim.report.id} was finished at NCMEC though the finish failed here`,
        },
        'error'
      );
    } else {
      logSendLine(claim, outcome === 'retracted' ? 'send-cancel-already-retracted' : 'send-cancel');
      if (isProd && !claim.settled)
        await updateUnderClaim(
          claim,
          'cancel',
          { reportId: null },
          appendId('cancelledReportIds', ncmecReportId)
        );
      return false;
    }
  }

  // Finished at NCMEC from here on: a lost stamp is alerted, and the next run sends a duplicate.
  if (!isProd) return true;
  try {
    if (
      await updateUnderClaim(
        claim,
        'stamp',
        {
          reportId: ncmecReportId,
          reportSentAt: new Date(),
          sendClaimId: null,
          sendClaimedAt: null,
        },
        // A hold no longer applies to a report that is sent.
        ({ sendHold: _cleared, ...stored }) => ({ ...stored, ...details }),
        'send-stamp-lost'
      )
    )
      claim.settled = true;
  } catch (e) {
    logSendLine(claim, 'send-stamp-lost', { message: (e as Error | undefined)?.message }, 'error');
    throw e;
  }
  return true;
}

type FileCheck = { readable: true } | { absent: string } | { failed: true };

async function reportImages(claim: SendClaim) {
  const { report } = claim;
  const initialReport = await getInitialReportData(claim);
  if (!initialReport) return;

  const images = await getImages(report.images.map((x) => x.id));
  if (!images.length)
    return await logNoFiles(claim, `report ${report.id} names no image that still exists`);

  initialReport.incidentSummary.incidentDateTime = images[0].createdAt;

  // Checked before the CyberTip is opened, so a report that cannot be sent opens none.
  const readFailures = { ...report.details?.readFailures };
  const checks = new Map<number, FileCheck>();
  await Limiter({ limit: 2, batchSize: 1 }).process(images, async ([image]) => {
    try {
      let check: OriginalImageRead | Awaited<ReturnType<typeof probeOriginalImage>> =
        await probeOriginalImage(image);
      // A HEAD can pass where the read fails (it cannot tell a wrong bucket), so a file that has failed
      // CSAM_SEND_SHORT_MIN_READ_FAILURES reads is read in full here, not opened for and cancelled again.
      if (
        check.source !== 'missing' &&
        (readFailures[image.id] ?? 0) >= CSAM_SEND_SHORT_MIN_READ_FAILURES
      )
        check = await readOriginalImage(image);
      checks.set(
        image.id,
        check.source === 'missing' ? { absent: check.reason } : { readable: true }
      );
    } catch {
      readFailures[image.id] = (readFailures[image.id] ?? 0) + 1;
      checks.set(image.id, { failed: true });
    }
  });
  const failed = images.filter((image) => 'failed' in (checks.get(image.id) ?? {}));
  const absent = images.filter((image) => 'absent' in (checks.get(image.id) ?? {}));
  if (failed.length > 0) await recordReadFailures(claim, readFailures);

  const hoursPending = hoursSinceFiled(report);
  if (failed.length + absent.length === images.length) {
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      subType: 'send-all-unreadable',
      message: `report ${report.id} has no readable file`,
      reportId: report.id,
      hoursPending,
      filesUnreadable: failed.length,
      filesAbsent: absent.length,
    });
    if (hoursPending >= CSAM_SEND_DECISION_AFTER_HOURS)
      logToAxiom({
        name: 'csam-report',
        type: 'error',
        subType: 'send-decision-needed',
        message: `report ${report.id} has had no readable file for ${hoursPending} hours`,
        reportId: report.id,
        hoursPending,
      });
    return logSendFailure(report, new Error('no file of the report could be read'), 'archive-data');
  }
  const sendShort =
    hoursPending >= CSAM_SEND_SHORT_AFTER_HOURS &&
    failed.every((image) => readFailures[image.id] >= CSAM_SEND_SHORT_MIN_READ_FAILURES);
  if (failed.length > 0 && !sendShort)
    return logSendFailure(
      report,
      new Error(`${failed.length} file(s) could not be read`),
      'archive-data'
    );

  // Read before the CyberTip is opened: a view recorded once the send has begun does not count.
  let viewed: Map<number, ShownRendition>;
  try {
    viewed = await getViewedImageIds(
      images.map((image) => image.id),
      report
    );
  } catch (e) {
    return logSendFailure(report, e, 'send-view-check');
  }
  // A supplemental report attaches only images a reviewer confirmed, so it is not sent short of one.
  const supplemental = report.details?.supplemental;
  const unviewed = supplemental ? images.filter((image) => !viewed.has(image.id)).length : 0;
  if (unviewed > 0)
    return logSendFailure(
      report,
      new Error(`${unviewed} file(s) of this supplemental report have no view record`),
      'supplemental-unviewed'
    );

  // Known before the CyberTip is opened, so NCMEC is told in the report itself what it lacks.
  const noLongerStored =
    absent.length +
    report.images.filter(({ id }) => !images.some((image) => image.id === id)).length;
  const omitted = [
    failed.length > 0 &&
      `${failed.length} file(s) named in this report could not be read from storage after repeated attempts and are not included.`,
    noLongerStored > 0 &&
      `${noLongerStored} file(s) named in this report are no longer stored and are not included.`,
  ].filter(Boolean);

  const fileDetailsOf = new Map<
    number,
    { fileDetails: FileDetailsXml; fileAnnotations: Ncmec.FileAnnotationsSchema }
  >();
  for (const image of images) {
    const imageReportInfo = report.images.find((x) => x.id === image.id);
    if (!imageReportInfo) continue;
    const fileAnnotations = imageReportInfo.fileAnnotations ?? ({} as Ncmec.FileAnnotationsSchema);
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
    const originalFileName = image.name?.split('?')[0];
    const prompts = promptFileDetails((image.meta ?? {}) as Record<string, unknown>, {
      storedOnImage: true,
    });
    if (isFeedbackCaptureOwner(image.userId))
      prompts.additionalInfo.unshift(xmlText(FEEDBACK_CAPTURE_FILE_NOTE));
    fileDetailsOf.set(image.id, {
      fileDetails: {
        originalFileName: originalFileName ? xmlText(originalFileName) : undefined,
        locationOfFile: xmlText(getEdgeUrl(image.url, { type: image.type })),
        fileViewedByEsp: viewed.has(image.id),
        fileAnnotations,
        ...(prompts.details && { details: prompts.details }),
        ...(prompts.additionalInfo.length && { additionalInfo: prompts.additionalInfo }),
      },
      fileAnnotations,
    });
  }

  let uploaded = 0;
  let failedAfterOpen = false;
  const started: Promise<unknown>[] = [];
  let uploadResult: (CsamReportImage | undefined)[] = [];
  const sendFiles = async (ncmecReportId: number) => {
    const limit = plimit(2);
    const sendFile = async (image: (typeof images)[number]) => {
      const imageReportInfo = report.images.find((x) => x.id === image.id);
      const described = fileDetailsOf.get(image.id);
      if (!imageReportInfo || !described) return;
      const { fileDetails, fileAnnotations } = described;

      const check = checks.get(image.id);
      if (check && 'failed' in check)
        return {
          ...imageReportInfo,
          source: 'missing',
          reason: SEND_SHORT_REASON,
        } satisfies CsamReportImage;
      if (check && 'absent' in check)
        return {
          ...imageReportInfo,
          source: 'missing',
          reason: check.absent,
        } satisfies CsamReportImage;

      let original: OriginalImageRead;
      try {
        original = await readOriginalImage(image);
      } catch (e) {
        readFailures[image.id] = (readFailures[image.id] ?? 0) + 1;
        failedAfterOpen = true;
        throw e;
      }
      if (original.source === 'missing')
        return {
          ...imageReportInfo,
          source: 'missing',
          reason: original.reason,
        } satisfies CsamReportImage;
      // Node Buffers are backed by a plain ArrayBuffer; the type only says ArrayBufferLike, which Blob rejects.
      const bytes = original.data as Uint8Array<ArrayBuffer>;
      const file = blobToFile(new Blob([bytes], { type: original.contentType }));

      const {
        data: { fileId, hash },
      } = await uploadToCyberTip(claim, file);

      const viewRendition = viewed.get(image.id);
      const viewedByEsp = !!viewRendition;
      await cybertipClient.submitFileDetails({ reportId: ncmecReportId, fileId, ...fileDetails });

      uploaded++;
      return {
        ...imageReportInfo,
        fileAnnotations,
        fileId,
        hash,
        viewedByEsp,
        viewRendition,
        source: original.source,
        sha256: original.sha256,
        bytes: original.data.length,
        contentType: original.contentType,
      } satisfies CsamReportImage;
    };
    uploadResult = await Promise.all(
      images.map((image) =>
        limit(() => {
          const sending = sendFile(image);
          started.push(sending);
          return sending.catch((e) => {
            // Before this slot frees: queued files would otherwise still go to a cancelled CyberTip.
            limit.clearQueue();
            throw e;
          });
        })
      )
    );
    if (uploaded === 0) throw new Error('no file of the report could be read');
    return {
      ...(failed.length > 0 && { readFailures }),
      images: uploadResult.filter(isDefined),
    };
  };

  const webPageIncidents = contextWebPageIncidents(report.details?.contextText).map(
    ({ url, additionalInfo }) => ({
      url: [xmlText(url)],
      additionalInfo: xmlText(additionalInfo),
      thirdPartyHostedContent: false,
    })
  );
  const sent = await sendCyberTip(
    claim,
    {
      ...initialReport,
      ...(webPageIncidents.length && { incidentDetails: { webPageIncidents } }),
      ...(supplemental && {
        personOrUserReported: {
          ...initialReport.personOrUserReported,
          priorCTReports: supplemental.priorReportNumbers,
        },
      }),
      ...((supplemental || omitted.length > 0) && {
        additionalInfo: [
          supplemental && supplementalReportText(supplemental.unreviewedImageIds.length),
          ...omitted,
        ]
          .filter(Boolean)
          .join('\n'),
      }),
    },
    {
      fileDetails: [...fileDetailsOf.values()].map(({ fileDetails }) => fileDetails),
      sendFiles,
      // A file already being sent finishes before the cancel, so its read failure is counted too.
      beforeCancel: async () => {
        await Promise.allSettled(started);
        if (failedAfterOpen) await recordReadFailures(claim, readFailures).catch(() => undefined);
      },
    }
  );
  if (!sent) return;

  const filesMissing = uploadResult.filter((entry) => entry?.source === 'missing').length;
  if (filesMissing > 0)
    logSendLine(
      claim,
      'send-short',
      {
        message: `report ${report.id} sent without ${filesMissing} file(s)`,
        filesMissing,
        filesAbsent: filesMissing - failed.length,
      },
      'error'
    );
}

/** The rows that count as a moderator having seen an image: opened or selected once on screen. */
export const shownActivities = (rendition: ShownRendition) =>
  SHOWN_ACTIONS.map((action) => shownActivity(action, rendition));

/** Each image's earliest counted row stamped before now, by the database's own clock, as the
 *  rendition it records. A CDN row counts only when the report's filer wrote it, from a day before
 *  the filing on. `createdAt` is zoneless and in UTC. */
export async function getViewedImageIds(
  imageIds: number[],
  report: Pick<CsamReportProps, 'reportedById' | 'createdAt'>
) {
  const viewed = new Map<number, ShownRendition>();
  if (!imageIds.length) return viewed;
  // The primary: a replica may not have a view recorded just before the send.
  const rows = await dbWrite.$queryRaw<{ entityId: number; activity: string }[]>`
    SELECT DISTINCT ON ("entityId") "entityId", activity FROM "ModActivity"
    WHERE "entityType" = 'image'
      AND "entityId" = ANY(${imageIds}::int[])
      AND "createdAt" < (now() AT TIME ZONE 'UTC')
      AND (
        activity = ANY(${shownActivities('original')}::text[])
        OR (
          activity = ANY(${shownActivities('cdn-450')}::text[])
          AND "userId" = ${report.reportedById}
          AND "createdAt" >= (${new Date(
            report.createdAt
          ).toISOString()}::timestamptz AT TIME ZONE 'UTC') - interval '24 hours'
        )
      )
    ORDER BY "entityId", "createdAt", id
  `;
  for (const { entityId, activity } of rows)
    viewed.set(entityId, activity.slice(activity.lastIndexOf(':') + 1) as ShownRendition);
  return viewed;
}

const GENERATED_FILE_DETAILS = {
  fileViewedByEsp: false,
  publiclyAvailable: false,
} satisfies FileDetailsXml;

async function reportGenerationData(claim: SendClaim) {
  const { report } = claim;
  if (isGeneratorEvidenceDetails(report.details)) return reportPreservedEvidence(claim);
  const initialReport = await getInitialReportData(claim);
  if (!initialReport) return;

  const generatedImages = report.details.generatedImages?.filter((x) => x.blobs.length > 0);
  // A moderator's filing is the record that it was reported, so a report with nothing to send is kept.
  if (!generatedImages?.length)
    return await logNoFiles(claim, `report ${report.id} names no generated image with a file`);

  // Named by claim, so two runs never share a scratch directory.
  const dir = `${baseDir}/generated-send/${report.id}-${claim.claimId}`;
  createDir(dir);
  try {
    await sendGenerationData(claim, initialReport, generatedImages, dir);
  } finally {
    if (fs.existsSync(dir)) removeDir(dir);
  }
}

async function sendGenerationData(
  claim: SendClaim,
  initialReport: Report,
  generatedImages: CsamReportGeneratedImages[],
  dir: string
) {
  const { report } = claim;
  // Fetched to disk before the CyberTip is opened, so a report that cannot be sent opens none. A file
  // that cannot be fetched is held for and sent without as an image's is.
  const budget = spoolBudget();
  let n = 0;
  // No fetch rejects, so every one has settled before the caller removes `dir`; a report past the cap
  // fails whole after they settle.
  const cap: { passed?: SpoolLimitError } = {};
  const blobs = await Limiter({ batchSize: 1, limit: 2 }).process(generatedImages, ([job]) =>
    Promise.all(
      job.blobs.map(async ({ url }) => {
        if (cap.passed) return { job, url, file: null };
        const path = `${dir}/file-${n++}`;
        // An error response is not the file, and a fetch that throws is one that failed.
        const fetched = await spoolUrl(url, path, budget).catch((e) => {
          if (e instanceof SpoolLimitError) cap.passed ??= e;
          return null;
        });
        const file = fetched && { path, filename: `${Date.now()}`, type: fetched.type };
        return { job, url, file };
      })
    )
  );
  if (cap.passed)
    return logSendFailure(
      report,
      new Error(spoolLimitMessage(report.id, cap.passed)),
      'evidence-too-large'
    );
  // One filing can name a URL twice: it is one file, counted and sent once, and a copy that was
  // fetched wins over one whose fetch failed.
  const byUrl = new Map<string, (typeof blobs)[number]>();
  for (const blob of blobs) if (!byUrl.get(blob.url)?.file) byUrl.set(blob.url, blob);
  const unique = [...byUrl.values()];
  const fetched = unique.flatMap(({ job, url, file }) => (file ? [{ job, url, file }] : []));
  const failed = unique.filter(({ file }) => !file);
  const readFailures = { ...report.details.readFailures };
  for (const { url } of failed) readFailures[url] = (readFailures[url] ?? 0) + 1;
  if (failed.length > 0) await recordReadFailures(claim, readFailures);
  if (!fetched.length)
    return await logNoFiles(
      claim,
      `report ${report.id} has no generated image that can be fetched`
    );
  const sendShort =
    hoursSinceFiled(report) >= CSAM_SEND_SHORT_AFTER_HOURS &&
    failed.every(({ url }) => readFailures[url] >= CSAM_SEND_SHORT_MIN_READ_FAILURES);
  if (failed.length > 0 && !sendShort)
    return logSendFailure(
      report,
      new Error(`${failed.length} file(s) could not be read`),
      'archive-data'
    );

  const detailsOf = ({ job }: (typeof fetched)[number]) => {
    const { details, additionalInfo } = promptFileDetails(job);
    return {
      ...GENERATED_FILE_DETAILS,
      ...(details && { details }),
      ...(additionalInfo.length && { additionalInfo }),
    } satisfies FileDetailsXml;
  };
  let sending: ReturnType<typeof sendEach> | undefined;
  const sent = await sendCyberTip(
    claim,
    {
      ...initialReport,
      ...(failed.length > 0 && {
        additionalInfo: `${failed.length} file(s) named in this report could not be read from storage after repeated attempts and are not included.`,
      }),
    },
    {
      fileDetails: fetched.map(detailsOf),
      sendFiles: async (reportId) => {
        sending = sendEach(
          fetched,
          async (item) => {
            const {
              data: { fileId, hash },
            } = await uploadToCyberTip(claim, await spooledFile(item.file));
            await cybertipClient.submitFileDetails({ fileId, reportId, ...detailsOf(item) });
            return { url: item.url, fileId, hash } satisfies CsamReportGeneratedImageData;
          },
          // The upload reads each file whole: one at a time.
          1
        );
        return {
          ...(failed.length > 0 && { readFailures }),
          generatedImageUploads: await sending.sent,
        };
      },
      beforeCancel: async () => sending?.settled(),
    }
  );
  if (sent && failed.length > 0)
    logSendLine(
      claim,
      'send-short',
      {
        message: `report ${report.id} sent without ${failed.length} file(s)`,
        filesMissing: failed.length,
        filesAbsent: 0,
      },
      'error'
    );
}

/**
 * A report of preserved generator evidence: every file is the copy made at preserve time, read back and
 * checked against its sha256 before the CyberTip is opened. Nothing is fetched from a URL.
 */
async function reportPreservedEvidence(claim: SendClaim) {
  const { report } = claim;
  const details = report.details as unknown as GeneratorEvidenceDetails;
  if (!details.generatorEvidence.approvedAt)
    return logSendLine(claim, 'send-awaiting-approval', {
      message: `report ${report.id} waits for a moderator to approve its evidence`,
    });
  const initialReport = await getInitialReportData(claim);
  if (!initialReport) return;

  const files = evidenceFilesToSend(details);
  if (!files.length)
    return await logNoFiles(claim, `report ${report.id} has no preserved generator file`);
  if (evidenceSizeProblem(details))
    return logSendFailure(
      report,
      new Error(`report ${report.id} holds ${files.length} files to send`),
      'evidence-too-large'
    );

  // A report can hold thousands of files: verified by streaming, then uploaded one at a time, so a
  // send holds at most one file.
  const reads: {
    file: (typeof files)[number];
    read: Awaited<ReturnType<typeof verifyStoredEvidence>>;
  }[] = [];
  for (const file of files)
    reads.push({ file, read: await verifyStoredEvidence(file.blob, hashEvidenceObject) });
  const mismatched = reads.filter(({ read }) => !read.ok && read.shaMismatch);
  if (mismatched.length)
    return logSendFailure(
      report,
      new Error(`${mismatched.length} preserved file(s) no longer match their sha256`),
      'evidence-sha-mismatch'
    );
  const unread = reads.filter(({ read }) => !read.ok);
  if (unread.length)
    return logSendFailure(
      report,
      new Error(`${unread.length} preserved file(s) could not be read`),
      'archive-data'
    );

  // Read before the CyberTip is opened: a view recorded once the send has begun does not count.
  let viewed: Map<string, number[]>;
  try {
    viewed = await getViewedEvidence(
      report,
      files.map(({ blob }) => blob)
    );
  } catch (e) {
    return logSendFailure(report, e, 'send-view-check');
  }

  const priorCTReports = details.generatorEvidence.priorCTReports;
  const notCarried = evidenceReportInfo(details);
  const toSend = reads.flatMap(({ file, read }) => {
    if (!read.ok) return [];
    const viewedByEsp = viewed.has(file.blob.blobId);
    return [{ file, viewedByEsp, fileDetails: evidenceFileDetails(file, viewedByEsp) }];
  });
  const cyberTip = {
    ...initialReport,
    ...(priorCTReports?.length && {
      personOrUserReported: { ...initialReport.personOrUserReported, priorCTReports },
    }),
    ...(notCarried.length && { additionalInfo: xmlText(notCarried.join('\n')) }),
  };
  let sending: ReturnType<typeof sendEach> | undefined;
  await sendCyberTip(claim, cyberTip, {
    fileDetails: toSend.map(({ fileDetails }) => fileDetails),
    sendFiles: async (reportId) => {
      sending = sendEach(
        toSend,
        async ({ file, viewedByEsp, fileDetails }) => {
          const {
            data: { fileId, hash },
          } = await uploadToCyberTip(claim, await readEvidenceFile(file.blob));
          await cybertipClient.submitFileDetails({ reportId, fileId, ...fileDetails });
          return { blobId: file.blob.blobId, fileId, hash, viewedByEsp };
        },
        1
      );
      return { generatedImageUploads: await sending.sent };
    },
    beforeCancel: async () => sending?.settled(),
  });
}

/** The verified copy as the File NCMEC's upload takes, built on the read's Blob without a copy. */
async function readEvidenceFile(blob: StoredEvidenceBlob) {
  const read = await readVerifiedEvidence(blob, streamEvidenceObject, MAX_EVIDENCE_BYTES);
  if (!read.ok) throw new Error(`preserved file ${blob.blobId} failed its re-read: ${read.reason}`);
  return new File([read.body], blob.blobId, { type: read.contentType });
}

async function reportTrainingData(claim: SendClaim) {
  const { report } = claim;
  const initialReport = await getInitialReportData(claim);
  if (!initialReport) return;

  const modelVersions = await getModelVersions([
    ...new Set([...(report.details.modelVersionIds ?? [])]),
  ]);

  const version = modelVersions[0];
  if (!version)
    return await logNoFiles(claim, `report ${report.id} names no model version that still exists`);

  const dir = `${baseDir}/training-data/${report.id}-${claim.claimId}`;
  const outPath = `${dir}/${report.userId ?? 'unknown'}_training-data.zip`;

  createDir(dir);
  try {
    // Downloaded and read before the CyberTip is opened, so a report that cannot be sent opens none.
    const inflated = spoolBudget();
    let files: SpooledFile[];
    try {
      const zipStream = await getTrainingDataZipStream({
        reportedById: report.reportedById,
        versionId: version.id,
      });
      await spoolStream(
        Readable.from(zipStream),
        outPath,
        spoolBudget(MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES)
      );
      createDir(`${dir}/entries`);
      files = await spoolZip(outPath, `${dir}/entries`, inflated);
      fs.rmSync(outPath, { force: true });
    } catch (e) {
      if (e instanceof SpoolLimitError)
        return logSendFailure(
          report,
          new Error(spoolLimitMessage(report.id, e)),
          'evidence-too-large'
        );
      return logSendFailure(report, e, 'archive-data');
    }
    await recordSkippedEntries(claim, inflated);
    if (!files.length)
      return await logNoFiles(claim, `report ${report.id} training data holds no image`);

    const fileDetailsOf = (filename: string) =>
      ({ originalFileName: xmlText(filename), fileViewedByEsp: false } satisfies FileDetailsXml);
    let sending: ReturnType<typeof sendEach> | undefined;
    await sendCyberTip(claim, initialReport, {
      fileDetails: files.map(({ filename }) => fileDetailsOf(filename)),
      sendFiles: async (reportId) => {
        sending = sendEach(
          files,
          async (file) => {
            const { filename } = file;
            const {
              data: { fileId, hash },
            } = await uploadToCyberTip(claim, await spooledFile(file));
            await cybertipClient.submitFileDetails({
              reportId,
              fileId,
              ...fileDetailsOf(filename),
            });
            return { filename, fileId, hash };
          },
          1
        );
        return { trainingData: await sending.sent };
      },
      beforeCancel: async () => sending?.settled(),
    });
  } finally {
    if (fs.existsSync(dir)) removeDir(dir);
  }
}

async function reportExternalLink(claim: SendClaim) {
  const { report } = claim;
  const reportingUser = await getReportingUser(report.reportedById);
  if (!reportingUser?.email || !report.userId)
    return await holdForDecision(claim, 'missing-user', 'no reporting user email or reported user');

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

  const dir = `${baseDir}/external-send/${report.id}-${claim.claimId}`;
  createDir(dir);
  try {
    await sendExternalLink(claim, dir, {
      details,
      reportInfo,
      reportedInfo,
      ipCaptureEvent,
      reportingUser: { email: reportingUser.email, name: reportingUser.name },
      userId: report.userId,
    });
  } finally {
    if (fs.existsSync(dir)) removeDir(dir);
  }
}

async function sendExternalLink(
  claim: SendClaim,
  dir: string,
  {
    details,
    reportInfo,
    reportedInfo,
    ipCaptureEvent,
    reportingUser,
    userId,
  }: {
    details: ExternalCsamReportDetails;
    reportInfo: string[];
    reportedInfo: string[];
    ipCaptureEvent: NonNullable<Report['personOrUserReported']>['ipCaptureEvent'];
    reportingUser: { email: string; name: string | null };
    userId: number;
  }
) {
  const { report } = claim;

  // Read before the CyberTip is opened, so a report whose evidence cannot be read opens none.
  const inflated = spoolBudget();
  const readZip = async (key: string, name: string) => {
    const zipFile = `${dir}/${name}.zip`;
    await downloadCsamBucketObject(key, zipFile);
    createDir(`${dir}/${name}`);
    try {
      return await spoolZip(zipFile, `${dir}/${name}`, inflated);
    } finally {
      fs.rmSync(zipFile, { force: true });
    }
  };
  let evidenceFiles: SpooledFile[] = [];
  let supplementalFiles: SpooledFile[] = [];
  try {
    if (details.evidence?.bucketKey)
      evidenceFiles = await readZip(details.evidence.bucketKey, 'evidence');
    if (details.supplementalEvidence?.bucketKey)
      supplementalFiles = await readZip(details.supplementalEvidence.bucketKey, 'supplemental');
  } catch (e) {
    if (e instanceof SpoolLimitError)
      return logSendFailure(
        report,
        new Error(spoolLimitMessage(report.id, e)),
        'evidence-too-large'
      );
    return logSendFailure(report, e, 'archive-data');
  }
  await recordSkippedEntries(claim, inflated);

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
  const evidenceDetails = (filename: string) =>
    ({
      originalFileName: xmlText(filename),
      locationOfFile: locationOfFile && xmlText(locationOfFile),
      fileViewedByEsp: false,
      publiclyAvailable: false,
      fileAnnotations,
    } satisfies FileDetailsXml);
  // Chat-log screenshots are contextual evidence, not the reported abuse
  // material: upload them as SupplementalReported with no CSAM annotations.
  const supplementalDetails = (filename: string) =>
    ({
      originalFileName: xmlText(filename),
      fileViewedByEsp: false,
      publiclyAvailable: false,
      fileRelevance: FileRelevance.SupplementalReported,
      additionalInfo: ['Chat log screenshot / supplemental evidence'],
    } satisfies FileDetailsXml);

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
      { url: details.externalUrls.map(xmlText), thirdPartyHostedContent: true },
    ];
  }
  if (details.chatLogs || details.chatPlatform) {
    incidentDetails.chatImIncidents = [
      {
        chatClient: details.chatPlatform && xmlText(details.chatPlatform),
        content: details.chatLogs && xmlText(details.chatLogs),
      },
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
        email: [{ email: xmlText(reportingUser.email) }],
        firstName: reportingUser.name ? xmlText(reportingUser.name) : undefined,
      },
      contactPerson: {
        email: [{ email: CYBERTIP_CONTACT_EMAIL }],
      },
    },
    personOrUserReported: {
      espIdentifier: userId.toString(),
      screenName: details.screenName && xmlText(details.screenName),
      personOrUserReportedPerson: {
        firstName: details.reportedName && xmlText(details.reportedName),
        email: [{ email: xmlText(details.email) }],
      },
      profileUrl: details.profileUrls?.map(xmlText),
      ipCaptureEvent,
      additionalInfo: xmlText(reportedInfo.join('\n')),
    },
    additionalInfo: xmlText(reportInfo.join('\n\n')),
  } satisfies Report;

  await sendCyberTip(claim, initialReport, {
    failureSubType: 'send-report',
    fileDetails: [
      ...evidenceFiles.map(({ filename }) => evidenceDetails(filename)),
      ...supplementalFiles.map(({ filename }) => supplementalDetails(filename)),
    ],
    sendFiles: async (reportId) => {
      // The upload reads each file whole: one at a time.
      const limit = plimit(1);
      const upload = (files: SpooledFile[], detailsOf: (filename: string) => FileDetailsXml) =>
        Promise.all(
          files.map((file) =>
            limit(async () => {
              const {
                data: { fileId },
              } = await uploadToCyberTip(claim, await spooledFile(file));
              await cybertipClient.submitFileDetails({
                reportId,
                fileId,
                ...detailsOf(file.filename),
              });
            })
          )
        );
      await upload(evidenceFiles, evidenceDetails);
      await upload(supplementalFiles, supplementalDetails);
    },
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
  const { client, Bucket } = getCsamBucket();
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

/** An object in the CSAM bucket written to `file`, under the archive cap. */
async function downloadCsamBucketObject(key: string, file: string) {
  const { client, Bucket } = getCsamBucket();
  const response = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  if (!response.Body) throw new Error('failed to download evidence from CSAM bucket');
  await spoolStream(
    response.Body as Readable,
    file,
    spoolBudget(MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES)
  );
}

const spoolLimitMessage = (reportId: number, e: SpoolLimitError) =>
  `report ${reportId} cannot be sent: ${e.message}`;

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
  return Readable.fromWeb(response.body as WebReadableStream);
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
  const { client, Bucket } = getCsamBucket();
  const passThroughStream = new stream.PassThrough();

  const date = new Date();
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

  return new Promise<StoredObject>(async (resolve, reject) => {
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
      const result = (await parallelUploads3.done()) as { ETag?: string } | undefined;
      resolve({ key: Key, etag: result?.ETag ?? null });
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

/** Every CommentV3 row `userId` wrote, keyset-paged. */
const userCommentRows = (userId: number) =>
  flattenPages(
    scanPagesById(({ afterId, take }) => {
      let query = kyselyV3Read
        .selectFrom('CommentV3')
        .selectAll()
        .where('userId', '=', userId)
        .orderBy('id', 'asc')
        .limit(take);
      if (afterId !== undefined) query = query.where('id', '>', afterId);
      return query.execute();
    })
  );

/** The reported user's own content, written to `data.json` under `name` after `images`. Comments are not held, so this archive may be their only copy. */
export const userContentSections: {
  name: string;
  rows: (userId: number) => AsyncIterable<unknown>;
}[] = [{ name: 'comments', rows: userCommentRows }];

/**
 * Writes every comment `userId` wrote to `comments.json` in the CSAM bucket, beside their reports'
 * archives. For accounts whose reports were archived before `data.json` carried comments.
 */
export async function archiveUserComments(userId: number) {
  let comments = 0;
  async function* counted<T>(rows: AsyncIterable<T>) {
    for await (const row of rows) {
      comments++;
      yield row;
    }
  }

  const sink = new stream.PassThrough();
  const [, stored] = await Promise.all([
    writeJsonObject({
      sink,
      replacer: bigintReplacer,
      entries: [
        ['userId', { value: userId }],
        ['archivedAt', { value: new Date().toISOString() }],
        ['comments', { items: counted(userCommentRows(userId)) }],
      ],
    }),
    uploadStream({ stream: sink, userId, filename: 'comments.json' }),
  ]);
  return { userId, ...stored, comments };
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
}): Promise<StoredObject> {
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
    return await uploadStream({ stream: readableStream, userId, filename });
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
    (stored) => stored,
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
  const stored = await uploadPromise;
  if (uploadError || !stored) throw uploadError ?? new Error(`failed to upload ${filename}`);
  return stored;
}

/** Serialises `bigint` columns (e.g. `Image.pHash`) as strings — `JSON.stringify` throws on them. */
const bigintReplacer: JsonReplacer = (_key, value) =>
  typeof value === 'bigint' ? value.toString() : value;

/** The error's name and code without its message, which can quote a storage key or a URL. */
const errorClass = (e: unknown) => ({
  errorName: (e as Error | undefined)?.name,
  errorCode: (e as { code?: unknown } | undefined)?.code,
});

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
   * `data.json` and `training-data.zip` are NOT affected by this flag. The first is staged on disk
   * and grows with the user's comment count; the second is a file this code downloads rather than
   * builds, and the NCMEC submission path reads it back off disk. Neither is the media archive whose
   * disk ceiling this removes.
   */
  const streamArchivesToStorage = await isFlipt(FLIPT_FEATURE_FLAGS.CSAM_ARCHIVE_STREAM_UPLOAD);

  /**
   * The media-archive path SELECTED for this report.
   *
   * 🔴 Not the same thing as the flag value: the flag governs
   * `archiveImages`/`archiveGeneratedImages` only, so a `TrainingData` or `ExternalLink`
   * report resolves to `none` however the flag is set. Derived in one place so the log
   * line and the counter cannot disagree about which path this report was routed to.
   */
  const archivePath = csamArchivePathFor(report.type, streamArchivesToStorage);

  /**
   * 🔴 EMITTED AT THE DECISION, AND BEFORE `createDir` — both deliberately.
   *
   * At the decision, because an archive that dies partway never reaches either counter
   * call, so a completion-only record would be silent for exactly the failures worth
   * investigating. This line is the one that survives a killed container.
   *
   * Before `createDir`, because that loop writes to the scratch volume and sits OUTSIDE
   * the try block below — so a failure there (the disk-pressure class this whole arc was
   * about) throws past both counter calls.
   *
   * 🔴 IT WAS NOT INVISIBLE BEFORE, AND SAYING SO WOULD BE WRONG: the caller already
   * catches and logs it — `process-csam.ts`'s per-report `catch` emits
   * `subType: 'archive-data'` carrying `errorMessage(e)`, which for the `mkdirSync` throw
   * is the real errno (`ENOSPC: … mkdir '<path>'`). What that record does NOT carry is any
   * of `reportId`, `reportType` or `archivePath`. So what emitting first actually buys is
   * ATTRIBUTION — which report, and which path it was routed to — not visibility. The
   * counter still cannot see it either way, which the counter's own help text states.
   *
   * 🔴 Do NOT "fix" that by moving the `createDir` loop inside the try: `removeDir` is
   * `fs.rmSync(dir, { recursive: true })` with no `force`, so it throws `ENOENT` on a
   * directory that was never created — and the catch's cleanup loop would then throw from
   * inside the catch. Documenting the blind spot is the cheaper correct answer.
   */
  logToAxiom({
    name: 'csam-report',
    type: 'info',
    subType: 'archive-path',
    message: `archiving report ${report.id} (${report.type}) via the ${archivePath} path`,
    reportId: report.id,
    reportType: report.type,
    archivePath,
    streamArchivesToStorage,
  });

  for (const dir of Object.values(reportDirs)) {
    createDir(dir);
  }

  /**
   * A fresh keyset-paged scan of every image the reported user owns. Each caller scans
   * separately, so neither holds more than one page of rows; an image listed in `data.json` but
   * absent from `images.zip` is recorded `missing` in `manifest.json`.
   */
  const scanUserImages = () =>
    scanPagesById(({ afterId, take }) =>
      dbRead.image.findMany({
        where: { userId, ...(afterId !== undefined ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' },
        take,
      })
    );

  const archived: ArchivedObject[] = [];

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

    await dbWrite.csamReportArchiveObject.createMany({
      data: archived.map((object) => ({ csamReportId: report.id, ...object })),
    });
    await dbWrite.csamReport.update({
      where: { id: report.id },
      data: {
        archivedAt: new Date(),
      },
    });

    recordCsamArchive(archivePath, report.type, 'success');

    for (const dir of Object.values(reportDirs)) removeDir(dir);
  } catch (e) {
    console.log(e);
    logToAxiom({
      name: 'csam-report',
      type: 'error',
      subType: 'archive-failed',
      message: `archiving report ${report.id} failed after ${archived.length} object(s)`,
      reportId: report.id,
      stored: archived.map((object) => object.kind),
      ...errorClass(e),
    });
    if (e instanceof Error) {
      if (e.message === 'training data not found') {
        await dbWrite.csamReport.update({
          where: { id: report.id },
          data: { details: { ...report.details, archiveSkipped: e.message } },
        });
      }
    }
    // 🔴 TWO THINGS THIS ROW DOES NOT MEAN, both easy to misread:
    //
    // (a) `path` here is the path SELECTED, not the path that failed. `archivePath` was
    //     resolved before any archiving began, so a failure upstream of the media archive
    //     — the base bundle, an image count — still records it. `{path="stream",
    //     outcome="error"}` does NOT establish that the streaming upload broke; use the
    //     log line's report id to find where it actually died.
    // (b) `error` includes the `training data not found` branch above, which records
    //     `archiveSkipped` and then rethrows. Left as one outcome rather than three — it is
    //     confined to a type the flag does not govern, and a third value would widen every
    //     series in the counter to describe one branch.
    recordCsamArchive(archivePath, report.type, 'error');

    for (const dir of Object.values(reportDirs)) removeDir(dir);
    throw e;
  }

  /**
   * Writes the base evidence bundle to disk, then uploads it: `user`, `reportId`, `models`,
   * `modelVersions`, `images`, then one section per `userContentSections` entry.
   *
   * Streamed because `JSON.stringify` cannot exceed V8's maximum string length: a bundle past it
   * could never be archived. Rows are written `id ASC`, so a bundle is not byte-comparable with one
   * written before paging.
   */
  async function archiveBaseReportData() {
    const { userId, reportId } = report;
    if (userId === -1) return;
    const user = await getReportedUser(userId);

    // Model IDs are accumulated because `modelVersions` is filtered by them.
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
        ...(report.details?.contextText?.length
          ? ([
              [
                'reportContext',
                {
                  value: {
                    webPageIncidents: contextWebPageIncidents(report.details.contextText),
                    contextText: report.details.contextText,
                  },
                },
              ],
            ] as const)
          : []),
        ['models', { items: streamModels() }],
        ['modelVersions', { items: streamModelVersions() }],
        ['images', { items: flattenPages(scanUserImages()) }],
        ...userContentSections.map(
          ({ name, rows }) =>
            [name, { items: rows(userId) }] as [string, { items: AsyncIterable<unknown> }]
        ),
      ],
    });

    const readableStream = fs.createReadStream(outPath);
    archived.push({
      kind: 'base',
      ...(await uploadStream({ stream: readableStream, userId, filename: 'data.json' })),
    });
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

    const namedIds = new Set(report.images.map((image) => image.id));
    const appendedIds = new Set<number>();
    let entries = 0;

    const stored = await archiveAndUpload({
      userId,
      filename: 'images.zip',
      diskPath: `${reportDirs.images}/${userId}_images.zip`,
      stream: streamArchivesToStorage,
      expectedBytes:
        imageCount !== undefined ? imageCount * ESTIMATED_BYTES_PER_ARCHIVED_IMAGE : undefined,
      append: async (boundedArchive) => {
        const limit = plimit(10);
        // Bounded in bytes, not count: original sizes vary too much for an entry count to bound memory.
        const budget = createByteBudget();
        // A failed archive stops its running reads and waits for them before its caller removes
        // the scratch dirs they write into.
        const readers = new AbortController();
        const running = new Set<Promise<void>>();
        const hoursSinceSent = report.reportSentAt
          ? (Date.now() - report.reportSentAt.getTime()) / 3_600_000
          : 0;
        // A supplemental report's unreviewed images are kept as evidence it did not send.
        const notSent = new Set(report.details?.supplemental?.unreviewedImageIds);
        const manifest: ({ imageId: number; preservedNotSent?: true } & EvidenceFileRecord)[] = [];
        const record = (entry: { imageId: number } & EvidenceFileRecord) =>
          manifest.push(notSent.has(entry.imageId) ? { ...entry, preservedNotSent: true } : entry);
        const archiveImage = async (
          image: Parameters<typeof readOriginalImage>[0] & { id: number }
        ) => {
          let original: OriginalImageRead | SpooledImage;
          let attempts = 1;
          try {
            original = await spoolOriginalImage(image, {
              reserve: budget.reserve,
              cancel: readers.signal,
              spoolDir: `${reportDirs.images}/spool`,
              onRetry: (failedAttempt) => {
                attempts = Math.max(attempts, failedAttempt + 1);
              },
            });
          } catch (e) {
            // Stopped because another image failed: not this image's failure.
            if (readers.signal.aborted) throw e;
            // A full URL may be on a host we do not control: after a day of retries its failing
            // no longer holds the archive back. A stored object's failure is always retried.
            const retried =
              !isEdgeUrlPassthrough(image.url) || hoursSinceSent < CSAM_ARCHIVE_GIVE_UP_AFTER_HOURS;
            logToAxiom({
              name: 'csam-report',
              type: retried ? 'error' : 'info',
              subType: 'archive-image-read',
              message: `report ${report.id}: image ${image.id} could not be read`,
              reportId: report.id,
              imageId: image.id,
              ...errorClass(e),
              fullUrl: isEdgeUrlPassthrough(image.url),
              retried,
              attempts,
            });
            if (retried) throw e;
            original = { source: 'missing', reason: 'full url unreadable' };
          }
          if (attempts > 1) {
            logToAxiom({
              name: 'csam-report',
              type: 'info',
              subType: 'archive-image-read-retried',
              message: `report ${report.id}: image ${image.id} read on attempt ${attempts}`,
              reportId: report.id,
              imageId: image.id,
              attempts,
            });
          }
          if (original.source === 'missing') {
            record({ imageId: image.id, source: 'missing', reason: original.reason });
            return;
          }
          // Named by id: Image.name is user input.
          const name = `${image.id}.${extensionForContentType(original.contentType)}`;
          let source: Buffer | Readable | undefined;
          try {
            // Opened here, so a failed open throws to this catch rather than from an unwatched stream.
            source =
              'path' in original
                ? (await fsAsync.open(original.path, 'r')).createReadStream()
                : original.data;
            await boundedArchive.append(source, { name }, original.release);
          } catch (e) {
            // An unread stream holds the deleted file's space until it is closed.
            if (source instanceof Readable) source.destroy();
            original.release();
            throw e;
          }
          entries += 1;
          // An edge copy counts only if it is image or video: an error page must not mark the image archived.
          if (original.source === 'original' || /^(image|video)\//.test(original.contentType))
            appendedIds.add(image.id);
          record({
            imageId: image.id,
            source: original.source,
            sha256: original.sha256,
            bytes: 'path' in original ? original.bytes : original.data.length,
            contentType: original.contentType,
          });
        };
        try {
          // Paged: a user's row set is unbounded.
          for await (const page of scanUserImages()) {
            await Promise.all(
              page.map((image) =>
                limit(() => {
                  const task = archiveImage(image).catch((e) => {
                    // Before this slot frees: queued reads would otherwise still open.
                    limit.clearQueue();
                    throw e;
                  });
                  running.add(task);
                  const done = () => running.delete(task);
                  task.then(done, done);
                  return task;
                })
              )
            );
          }
        } catch (e) {
          readers.abort(e);
          budget.abort(e);
          // Only reads that started: `clearQueue` leaves a queued task's promise unsettled.
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.allSettled(running),
            new Promise((resolve) => (settleTimer = setTimeout(resolve, FAILED_ARCHIVE_SETTLE_MS))),
          ]);
          clearTimeout(settleTimer);
          throw e;
        }

        const scanned = new Set(manifest.map((entry) => entry.imageId));
        for (const imageId of notSent)
          if (!scanned.has(imageId)) record({ imageId, source: 'missing', reason: 'no image row' });
        manifest.sort((a, b) => a.imageId - b.imageId);
        await boundedArchive.append(Buffer.from(JSON.stringify({ images: manifest }, null, 2)), {
          name: IMAGES_ARCHIVE_MANIFEST_NAME,
        });
        entries += 1;

        const counts = { original: 0, 'edge-fallback': 0, missing: 0 };
        for (const entry of manifest) counts[entry.source]++;
        logToAxiom({
          name: 'csam-report',
          type: 'info',
          subType: 'archive-images',
          message: `built the images archive for report ${report.id}`,
          reportId: report.id,
          original: counts.original,
          edgeFallback: counts['edge-fallback'],
          missing: counts.missing,
        });
      },
    });

    archived.push({
      kind: 'images',
      ...stored,
      entries,
      namedExpected: namedIds.size,
      namedMissing: [...namedIds].filter((id) => !appendedIds.has(id)).length,
    });
  }

  async function archiveGeneratedImages() {
    const { userId } = report;

    // The orchestrator no longer serves this list (404 for every consumer). That must not block the
    // report's own blobs; any other failure may be transient, so it fails the pass for the next run.
    let strikesNotFound = false;
    const flaggedData = await getConsumerStrikes({ consumerId: `civitai-${userId}` }).catch(
      (e: unknown) => {
        if (!(e instanceof FlaggedConsumerFetchError) || e.status !== 404) throw e;
        strikesNotFound = true;
        return [];
      }
    );
    const namedUrls = namedGeneratedImageUrls(report);
    const strikeUrls = new Set(
      flaggedData
        .flatMap((group) => group.strikes.flatMap(({ job }) => job.blobs))
        .filter(isDefined)
        .map((x) => x.previewUrl)
    );
    const imageUrls = [...new Set([...strikeUrls, ...namedUrls])];
    const appendedUrls = new Set<string>();
    let entries = 0;
    let unreadable = 0;
    const hoursSinceSent = report.reportSentAt
      ? (Date.now() - report.reportSentAt.getTime()) / 3_600_000
      : 0;
    const givenUp = hoursSinceSent >= CSAM_ARCHIVE_GIVE_UP_AFTER_HOURS;

    // Orchestrator URLs are a host we do not control, and a stamp ends archiving for good: any URL
    // that gives no media (an error status, a cut-off body, an error page) fails the hourly pass until
    // CSAM_ARCHIVE_GIVE_UP_AFTER_HOURS, then is recorded unreadable, as `archiveImages` does a full URL.
    const readBlob = async (url: string) => {
      // Never log the error: a fetch error can quote the presigned URL.
      const blob = await fetchBlob(url, undefined, { requireOk: true }).catch((e: unknown) => {
        if (!givenUp) throw e;
        return null;
      });
      const isMedia = !!blob && isArchivedMedia(blob);
      if (!isMedia && !givenUp) throw new Error('a generated image gave no media');
      return blob && { buffer: Buffer.from(await blob.arrayBuffer()), isMedia };
    };

    const stored = await archiveAndUpload({
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
          imageUrls.map((url, index) =>
            limit(async () => {
              try {
                const read = await readBlob(url);
                if (!read) {
                  unreadable += 1;
                  return;
                }
                // An append failure is the archive's own, so it fails the pass.
                await boundedArchive.append(read.buffer, { name: zipEntryNameForUrl(url, index) });
                entries += 1;
                if (read.isMedia) appendedUrls.add(url);
                else unreadable += 1;
              } catch (e) {
                // Before this slot frees: queued downloads would otherwise still run.
                limit.clearQueue();
                throw e;
              }
            })
          )
        );
      },
    });

    logToAxiom({
      name: 'csam-report',
      type: unreadable ? 'error' : 'info',
      subType: 'archive-generated-images',
      message: `report ${report.id}: archived ${entries} of ${imageUrls.length} generated images`,
      reportId: report.id,
      expected: imageUrls.length,
      strikeUrls: strikeUrls.size,
      namedUrls: namedUrls.size,
      entries,
      unreadable,
      strikesNotFound,
    });

    archived.push({
      kind: 'generatedImages',
      ...stored,
      entries,
      namedExpected: namedUrls.size,
      namedMissing: [...namedUrls].filter((url) => !appendedUrls.has(url)).length,
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
    archived.push({
      kind: 'trainingData',
      ...(await uploadStream({ stream: readableStream, userId, filename: 'training-data.zip' })),
    });
  }
}

function createDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function removeDir(dir: string) {
  fs.rmSync(dir, { recursive: true });
}
