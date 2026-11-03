import type { EvidenceJob } from '~/server/services/generator-evidence/evidence-refs';
import type { StoredEvidenceBlob } from '~/server/services/generator-evidence/preserve-blob';
import { CsamReportType } from '~/shared/utils/prisma/enums';

export const GENERATOR_EVIDENCE_VERSION = 1;

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

export const generatorEvidenceReportWhere = (userId: number) => ({
  userId,
  type: CsamReportType.GeneratedImage,
  reportSentAt: null,
  details: { path: ['generatorEvidence', 'version'], equals: GENERATOR_EVIDENCE_VERSION },
});
