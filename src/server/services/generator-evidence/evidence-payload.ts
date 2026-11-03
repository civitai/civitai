import type { SubmitFileDetails } from '@civitai/cybertipline-tools';
import { FileDetailType } from '@civitai/cybertipline-tools';
import type {
  GeneratorEvidenceDetails,
  StoredEvidenceJob,
} from '~/server/services/generator-evidence/evidence-meta';
import type { StoredEvidenceBlob } from '~/server/services/generator-evidence/preserve-blob';
import { trimNonAlphanumeric } from '~/utils/string-helpers';

export type EvidenceFile = { job: StoredEvidenceJob; blob: StoredEvidenceBlob };

/** The preserved files a send uploads, inputs first: a possible real photo is the most urgent. */
export function evidenceFilesToSend(details: GeneratorEvidenceDetails): EvidenceFile[] {
  const files = details.generatedImages.flatMap((job) =>
    job.blobs.filter((blob) => blob.status === 'preserved').map((blob) => ({ job, blob }))
  );
  const seen = new Set<string>();
  return files
    .filter(({ blob }) => !seen.has(blob.blobId) && !!seen.add(blob.blobId))
    .sort((a, b) => Number(a.blob.role === 'output') - Number(b.blob.role === 'output'));
}

function describe({ job, blob }: EvidenceFile) {
  if (blob.role === 'input') {
    const where =
      job.source === 'workflow'
        ? `an image-edit step of private generator workflow ${job.workflowId}`
        : `a generation request refused at submission${job.dateTime ? ` (${job.dateTime})` : ''}`;
    const derived = blob.derivedOutputIds?.length
      ? `; outputs ${blob.derivedOutputIds.join(', ')} were derived from it`
      : '';
    return `User-uploaded input to ${where}; may be a real photo${derived}.`;
  }
  return `Private generator output, workflow ${
    job.workflowId ?? job.jobId
  }; never publicly available.`;
}

/**
 * What NCMEC is told about one file. Never a URL or storage location: the file was never public, so it
 * is described in words, and only an input is marked not generative.
 */
export function evidenceFileDetails(
  file: EvidenceFile,
  viewedByEsp: boolean
): Omit<SubmitFileDetails, 'reportId' | 'fileId'> {
  const { job, blob } = file;
  const valuePair: { name: string; value: string }[] = [];
  const prompt = trimNonAlphanumeric(job.prompt);
  const negativePrompt = trimNonAlphanumeric(job.negativePrompt);
  if (prompt) valuePair.push({ name: 'prompt', value: prompt });
  if (negativePrompt) valuePair.push({ name: 'negativePrompt', value: negativePrompt });
  if (job.resources?.length) valuePair.push({ name: 'resources', value: job.resources.join(',') });
  return {
    originalFileName: blob.blobId,
    fileViewedByEsp: viewedByEsp,
    publiclyAvailable: false,
    fileAnnotations: { generativeAi: blob.role === 'output' },
    ...(valuePair.length && { details: [{ type: FileDetailType.EXIF, valuePair }] }),
    additionalInfo: [describe(file)],
  };
}

/** Report-level lines for files the report names but cannot carry. */
export function evidenceReportInfo(details: GeneratorEvidenceDetails) {
  const counts = { 'blocked-unreadable': 0, gone: 0, unavailable: 0, external: 0 };
  const seen = new Set<string>();
  for (const job of details.generatedImages)
    for (const blob of job.blobs) {
      if (seen.has(blob.blobId) || blob.status === 'preserved') continue;
      seen.add(blob.blobId);
      counts[blob.status] += 1;
    }
  return [
    counts['blocked-unreadable'] &&
      `${counts['blocked-unreadable']} generated file(s) were withheld by the generator's own screening and could not be read for this report; they are being retained.`,
    counts.gone && `${counts.gone} file(s) had already expired from the generator's storage.`,
    counts.unavailable && `${counts.unavailable} file(s) could not be read for this report.`,
    counts.external &&
      `${counts.external} input file(s) came from another source and are not attached.`,
  ].filter((line): line is string => !!line);
}

export type VerifiedEvidence =
  | { ok: true; bytes: Uint8Array; contentType?: string }
  | { ok: false; reason: string; shaMismatch?: boolean };

/** The preserved copy, only if it still hashes to what was recorded at preserve time. */
export async function readVerifiedEvidence(
  blob: StoredEvidenceBlob,
  read: (key: string) => Promise<{ bytes: Uint8Array; contentType?: string }>,
  sha256Hex: (bytes: Uint8Array) => string
): Promise<VerifiedEvidence> {
  if (!blob.evidenceKey || !blob.sha256) return { ok: false, reason: 'no preserved copy recorded' };
  let object: { bytes: Uint8Array; contentType?: string };
  try {
    object = await read(blob.evidenceKey);
  } catch (e) {
    return { ok: false, reason: `read failed: ${(e as Error).message}` };
  }
  if (sha256Hex(object.bytes) !== blob.sha256)
    return {
      ok: false,
      reason: 'the preserved copy no longer matches its sha256',
      shaMismatch: true,
    };
  return { ok: true, bytes: object.bytes, contentType: blob.contentType ?? object.contentType };
}
