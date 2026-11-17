import type { SubmitFileDetails } from '@civitai/cybertipline-tools';
import { FileDetailType } from '@civitai/cybertipline-tools';
import { createHash } from 'crypto';
import type {
  GeneratorEvidenceDetails,
  StoredEvidenceJob,
} from '~/server/services/generator-evidence/evidence-meta';
import { EVIDENCE_MEDIA_TYPES } from '~/server/services/generator-evidence/evidence-meta';
import { escapeXml, xmlSafe, xmlText } from '~/server/services/ncmec-xml';
import type { StoredEvidenceBlob } from '~/server/services/generator-evidence/preserve-blob';

export type EvidenceFile = { job: StoredEvidenceJob; blob: StoredEvidenceBlob };

/**
 * The preserved files a send uploads, inputs first: a possible real photo is the most urgent. A file
 * that any workflow of the report produced is that output, wherever else it was used as an input.
 */
/** One CyberTip must finish sending inside the send job's run lock. */
export const MAX_EVIDENCE_FILES_PER_REPORT = 1_000;

/** Why the report can never be sent as it stands, or null. */
export function evidenceSizeProblem(details: GeneratorEvidenceDetails) {
  const count = evidenceFilesToSend(details).length;
  if (count <= MAX_EVIDENCE_FILES_PER_REPORT) return null;
  return `This report holds ${count.toLocaleString(
    'en-US'
  )} files to send; one report can send at most ${MAX_EVIDENCE_FILES_PER_REPORT.toLocaleString(
    'en-US'
  )}. Exclude files until it holds ${MAX_EVIDENCE_FILES_PER_REPORT.toLocaleString(
    'en-US'
  )} or fewer; splitting a larger report is not available yet.`;
}

export function evidenceFilesToSend(details: GeneratorEvidenceDetails): EvidenceFile[] {
  const producers = new Map<string, StoredEvidenceJob>();
  const excluded = new Set<string>();
  for (const job of details.generatedImages)
    for (const blob of job.blobs) {
      if (blob.role === 'output' && !producers.has(blob.blobId)) producers.set(blob.blobId, job);
      if (blob.status === 'excluded') excluded.add(blob.blobId);
    }
  const files = new Map<string, EvidenceFile>();
  for (const job of details.generatedImages)
    for (const blob of job.blobs) {
      if (blob.status !== 'preserved' || files.has(blob.blobId) || excluded.has(blob.blobId))
        continue;
      const producer = producers.get(blob.blobId);
      if (!producer) files.set(blob.blobId, { job, blob });
      else {
        const { derivedOutputIds: _derived, ...asOutput } = blob;
        files.set(blob.blobId, { job: producer, blob: { ...asOutput, role: 'output' } });
      }
    }
  return [...files.values()].sort(
    (a, b) => Number(a.blob.role === 'output') - Number(b.blob.role === 'output')
  );
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
  const text = promptFileDetails(job);
  return {
    originalFileName: xmlText(blob.blobId),
    fileViewedByEsp: viewedByEsp,
    publiclyAvailable: false,
    fileAnnotations: { generativeAi: blob.role === 'output' },
    ...(text.details && { details: text.details }),
    additionalInfo: [xmlText(describe(file)), ...text.additionalInfo],
  };
}

type PromptSource = { prompt?: unknown; negativePrompt?: unknown; resources?: unknown };
const asText = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

const WORD = /\w/;

/**
 * What `trimNonAlphanumeric` returns, in one pass: its pattern takes time in the square of a long run of
 * symbols, and prompt text reaches this unbounded.
 */
export function trimEdgeSymbols(text: string | undefined) {
  if (text === undefined) return undefined;
  let start = 0;
  while (start < text.length && !WORD.test(text[start])) start++;
  let end = text.length;
  while (end > start && !WORD.test(text[end - 1])) end--;
  return text.slice(start, end);
}

/**
 * An EXIF value, trimmed of edge symbols as the preserved-evidence send always has. Image metadata has
 * no length limit, so it is cut to the plain line's limit, marked, as that line is.
 */
function exifValue(text: string | undefined, storedOnImage: boolean) {
  if (!text || !storedOnImage) return trimEdgeSymbols(text);
  const chars = Array.from(text);
  if (chars.length <= MAX_GENERATION_LINE_CHARS) return trimEdgeSymbols(text);
  const cut = `… ${IMAGE_TRUNCATION_MARKER}`;
  const kept = trimEdgeSymbols(chars.slice(0, MAX_GENERATION_LINE_CHARS - cut.length).join(''));
  return kept ? `${kept}${cut}` : undefined;
}

/**
 * A file's prompts as NCMEC is sent them: EXIF pairs, and the same words as plain lines. `storedOnImage`
 * labels them as read from the image's own metadata, which its uploader can write.
 */
export function promptFileDetails(
  source: PromptSource,
  { storedOnImage = false }: { storedOnImage?: boolean } = {}
): Pick<SubmitFileDetails, 'details'> & { additionalInfo: string[] } {
  const prompt = asText(source.prompt);
  const negativePrompt = asText(source.negativePrompt);
  // Image metadata names no resources NCMEC could use, and its uploader writes it.
  const resources =
    !storedOnImage && Array.isArray(source.resources)
      ? source.resources.filter((r): r is string => typeof r === 'string' && !!r)
      : [];
  const valuePair: { name: string; value: string }[] = [];
  const trimmedPrompt = exifValue(prompt, storedOnImage);
  const trimmedNegative = exifValue(negativePrompt, storedOnImage);
  if (trimmedPrompt) valuePair.push({ name: 'prompt', value: xmlText(trimmedPrompt) });
  if (trimmedNegative) valuePair.push({ name: 'negativePrompt', value: xmlText(trimmedNegative) });
  if (resources.length) valuePair.push({ name: 'resources', value: xmlText(resources.join(',')) });

  const as = storedOnImage ? ', as stored on the image' : '';
  const marker = storedOnImage ? IMAGE_TRUNCATION_MARKER : TRUNCATION_MARKER;
  const lines = [
    prompt && line(`Prompt${as}: `, prompt, marker),
    negativePrompt && line(`Negative prompt${as}: `, negativePrompt, marker),
    resources.length && line(`Resources${as}: `, resources.join(', '), marker),
  ].filter((text): text is string => !!text);
  return {
    ...(valuePair.length && { details: [{ type: FileDetailType.EXIF, valuePair }] }),
    additionalInfo: lines.length ? [lines.join('\n')] : [],
  };
}

/** Each line, label and marker included, is at most this many code points before escaping. */
export const MAX_GENERATION_LINE_CHARS = 4000;
export const TRUNCATION_MARKER = '[truncated; full text preserved]';
/** For text read from an image's own metadata, which the report does not itself hold. */
export const IMAGE_TRUNCATION_MARKER = '[truncated]';

function line(label: string, text: string, marker = TRUNCATION_MARKER) {
  const CUT = `… ${marker}`;
  const chars = [...xmlSafe(text.trim())];
  const room = MAX_GENERATION_LINE_CHARS - label.length;
  const kept =
    chars.length <= room ? chars.join('') : chars.slice(0, room - CUT.length).join('') + CUT;
  return label + escapeXml(kept);
}

export const EXCLUDED_FILES_NOTICE =
  'Civitai has preserved additional content from this account and will provide it on lawful request.';

/** Report-level lines for files the report names but cannot carry. */
export function evidenceReportInfo(details: GeneratorEvidenceDetails) {
  const counts = { 'blocked-unreadable': 0, gone: 0, unavailable: 0, external: 0, excluded: 0 };
  const seen = new Set(evidenceFilesToSend(details).map(({ blob }) => blob.blobId));
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
    counts.excluded && EXCLUDED_FILES_NOTICE,
  ].filter((line): line is string => !!line);
}

export type VerifiedEvidence =
  | { ok: true; body: Blob; contentType: string }
  | { ok: false; reason: string; shaMismatch?: boolean; overLimit?: true };

export type EvidenceObjectStream = {
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  contentType?: string;
};

/** Whether the preserved copy still hashes to what was recorded, without holding the file. */
export async function verifyStoredEvidence(
  blob: StoredEvidenceBlob,
  hashObject: (key: string) => Promise<string>
): Promise<{ ok: true } | { ok: false; reason: string; shaMismatch?: boolean }> {
  if (!blob.evidenceKey || !blob.sha256) return { ok: false, reason: 'no preserved copy recorded' };
  if (!blob.contentType || !EVIDENCE_MEDIA_TYPES.has(blob.contentType.toLowerCase()))
    return {
      ok: false,
      reason: `${blob.contentType ?? 'an unknown type'} is not an evidence media type`,
    };
  let sha256: string;
  try {
    sha256 = await hashObject(blob.evidenceKey);
  } catch (e) {
    return { ok: false, reason: `read failed: ${(e as Error).message}` };
  }
  if (sha256 !== blob.sha256)
    return {
      ok: false,
      reason: 'the preserved copy no longer matches its sha256',
      shaMismatch: true,
    };
  return { ok: true };
}

/**
 * The preserved copy, only if it still hashes to what was recorded, read no further than `maxBytes`
 * or its recorded size. Each chunk is kept as its own Blob, so the file is held once.
 */
export async function readVerifiedEvidence(
  blob: StoredEvidenceBlob,
  open: (key: string) => Promise<EvidenceObjectStream>,
  maxBytes: number
): Promise<VerifiedEvidence> {
  if (!blob.evidenceKey || !blob.sha256) return { ok: false, reason: 'no preserved copy recorded' };
  const hash = createHash('sha256');
  const parts: Blob[] = [];
  let storedType: string | undefined;
  try {
    const object = await open(blob.evidenceKey);
    storedType = object.contentType;
    let size = 0;
    for await (const chunk of object.chunks) {
      size += chunk.byteLength;
      // Whatever now sits at the key is read only as far as the size the copy was recorded at.
      if (blob.bytes !== undefined && size > blob.bytes)
        return {
          ok: false,
          reason: `the preserved copy is larger than the ${blob.bytes} bytes recorded`,
          shaMismatch: true,
        };
      // A copy with no recorded size is still read only as far as the caller can hold.
      if (size > maxBytes)
        return {
          ok: false,
          reason: `the preserved copy is larger than ${maxBytes} bytes`,
          overLimit: true,
        };
      hash.update(chunk);
      parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
    }
  } catch (e) {
    return { ok: false, reason: `read failed: ${(e as Error).message}` };
  }
  if (hash.digest('hex') !== blob.sha256)
    return {
      ok: false,
      reason: 'the preserved copy no longer matches its sha256',
      shaMismatch: true,
    };
  const contentType = blob.contentType ?? storedType;
  if (!contentType || !EVIDENCE_MEDIA_TYPES.has(contentType.toLowerCase()))
    return {
      ok: false,
      reason: `${contentType ?? 'an unknown type'} is not an evidence media type`,
    };
  return { ok: true, body: new Blob(parts, { type: contentType }), contentType };
}
