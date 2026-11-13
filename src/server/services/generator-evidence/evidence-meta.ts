import { createHash } from 'crypto';
import type { EvidenceJob } from '~/server/services/generator-evidence/evidence-refs';
import type { StoredEvidenceBlob } from '~/server/services/generator-evidence/preserve-blob';
import { CsamReportType } from '~/shared/utils/prisma/enums';

export const GENERATOR_EVIDENCE_VERSION = 1;

export type TriggerRef = { restrictionId: number; index: number };

/** Raster images and video only: nothing a browser could run as a document. */
export const EVIDENCE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

/** Report-level state of a report filed with preserved generator evidence, in `details.generatorEvidence`. */
export type GeneratorEvidenceMeta = {
  version: typeof GENERATOR_EVIDENCE_VERSION;
  /** CyberTip numbers already filed on this user, sent as `priorCTReports`. */
  priorCTReports?: number[];
  /** Nothing is sent until a moderator approves the report; new evidence clears it. */
  approvedAt?: string | null;
  approvedById?: number | null;
};

export type StoredEvidenceJob = Omit<EvidenceJob, 'refs'> & { blobs: StoredEvidenceBlob[] };

export type GeneratorEvidenceDetails = {
  generatedImages: StoredEvidenceJob[];
  generatorEvidence: GeneratorEvidenceMeta;
};

export const isGeneratorEvidenceDetails = (details: unknown): details is GeneratorEvidenceDetails =>
  !!details &&
  typeof details === 'object' &&
  (details as { generatorEvidence?: { version?: unknown } }).generatorEvidence?.version ===
    GENERATOR_EVIDENCE_VERSION;

/** A report waiting on a moderator's approval is not one the send job may pick up. */
export const isAwaitingEvidenceApproval = (details: unknown) =>
  isGeneratorEvidenceDetails(details) && !details.generatorEvidence.approvedAt;

export const unsentGeneratorEvidenceWhere = {
  type: CsamReportType.GeneratedImage,
  reportSentAt: null,
  details: { path: ['generatorEvidence', 'version'], equals: GENERATOR_EVIDENCE_VERSION },
};

export const generatorEvidenceReportWhere = (userId: number) => ({
  userId,
  ...unsentGeneratorEvidenceWhere,
});

/** What a moderator reviewed: the report's files and their states. An approval must name it. */
export function evidenceVersion(details: GeneratorEvidenceDetails) {
  const files = details.generatedImages
    .flatMap((job) =>
      job.blobs.map((blob) => `${job.jobId}|${blob.blobId}|${blob.status}|${blob.sha256 ?? ''}`)
    )
    .sort();
  return createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 32);
}
