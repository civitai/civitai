import type { S3Client } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import type { Readable } from 'stream';
import type * as yauzl from 'yauzl';
import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { classifyPromptExternally } from '~/server/services/orchestrator/promptAuditing';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';
import {
  InvalidZipError,
  openRangeZip,
  RangeReadError,
  s3ZipSource,
  type ZipSource,
} from '~/server/utils/zip-range-reader';
import { headObject } from '~/utils/s3-utils';
import {
  auditTrainingLabels,
  packCaptionsForAudit,
  type TrainingLabelMemo,
} from '~/utils/metadata/training-label-audit';

// The text rule every training path applies before a run is submitted: the trainer's label rules
// tag by tag (hard hits refuse, soft hits pass, as after the trainer's "Continue anyway"), then the
// external classifier over the joined text.

const TEXT_MAX_BYTES = 64 * 1024;
const TEXT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const TEXT_MAX_TOTAL_CHARS = TEXT_MAX_TOTAL_BYTES;
const MAX_ENTRIES = 5000;
const DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;
/** Read with each local header so its name, extra field and data usually arrive in the same GET. */
const LOCAL_HEADER_ALLOWANCE = 30 + 1024;
const READ_CONCURRENCY = 16;
const READ_BUDGET_MS = 60_000;
/** Text audited per tick of the synchronous word check. */
const AUDIT_CHUNK_CHARS = 100_000;
const CLASSIFY_CONCURRENCY = 4;

const REFUSAL =
  'One or more labels/trigger words have been blocked. Please review these and resubmit.';

/**
 * Refuses (BAD_REQUEST) when the run's text breaks the rule. `captions` are what the model trains
 * on, as the dataset holds them.
 */
export async function assertTrainingTextAllowed({
  triggerWord,
  captions,
  log,
}: {
  triggerWord: string;
  captions: string[];
  /** Identifies the run in the refusal log. */
  log: { userId: number; source: string } & Record<string, unknown>;
}): Promise<void> {
  const refuse = (reasons: string[], via: 'labels' | 'external'): never => {
    logToAxiom({ name: 'training-text-refused', type: 'info', ...log, via, reasons }).catch(
      () => undefined
    );
    throw throwBadRequestError(`${REFUSAL} Reason: ${reasons.join(', ')}`);
  };

  // Invisible formatting characters are dropped from the checked copy, so they cannot split a word.
  const clean = (text: string) => text.replace(/\p{Cf}/gu, '').trim();
  const trigger = clean(triggerWord);
  const trimmed = captions.map(clean).filter(Boolean);
  // Bounds the classifier calls one check can make, whichever caller sent the text.
  if (trigger.length + trimmed.reduce((sum, text) => sum + text.length, 0) > TEXT_MAX_TOTAL_CHARS)
    throw throwBadRequestError('Your training data has more text than can be checked.');
  // A text is never split across classifier batches, so one over the audit's cap is refused outright.
  if ([trigger, ...trimmed].some((text) => text.length > MAX_AUDIT_PROMPT_LENGTH))
    refuse(['a label is too long'], 'labels');

  // In chunks, yielding between them: the audit is synchronous, and a dataset of distinct tags would
  // otherwise hold the event loop for seconds. The trigger word is audited whole in each.
  const memo: TrainingLabelMemo = new Map();
  let i = 0;
  do {
    const chunk: { key: string; label: string }[] = [];
    for (let chars = 0; i < trimmed.length && chars < AUDIT_CHUNK_CHARS; i++) {
      chunk.push({ key: String(i), label: trimmed[i] });
      chars += trimmed[i].length;
    }
    const audit = auditTrainingLabels({
      triggerWord: trigger,
      labels: chunk,
      // The green-only word list yields soft hits alone, which pass: skipping it changes nothing.
      checkProfanity: false,
      memo,
    });
    if (audit.severity === 'hard') refuse(audit.offendingWords, 'labels');
    await new Promise((resolve) => setImmediate(resolve));
  } while (i < trimmed.length);

  // Batches not yet sent are skipped once one is flagged: the run is refused either way.
  let flagged = false;
  const limit = pLimit(CLASSIFY_CONCURRENCY);
  const verdicts = await Promise.all(
    packCaptionsForAudit([trigger, ...trimmed]).map((batch) =>
      limit(async () => {
        if (flagged) return { categories: [], externalError: null };
        const verdict = await classifyPromptExternally(batch, 'other');
        if (verdict.categories.length > 0) flagged = true;
        return verdict;
      })
    )
  );
  const failed = verdicts.filter((v) => v.externalError).length;
  if (failed > 0)
    logToAxiom({ name: 'training-text-classifier-error', type: 'warning', ...log, failed }).catch(
      () => undefined
    );
  const categories = [...new Set(verdicts.flatMap((v) => v.categories))];
  if (categories.length > 0) refuse(categories, 'external');
}

/** The dataset is refused on its shape; the message goes to the user as is. */
class DatasetLimitError extends Error {}

/** Entries named like these are skipped; every other entry is read as text. */
const MEDIA_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'mp4',
  'webm',
  'mov',
  'mp3',
  'wav',
  'flac',
  'ogg',
  'm4a',
]);

const extensionOf = (name: string) => {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** Checked unless every reading of its name says folder or media: an unzip tool may read a name
 *  another way. A folder holds no data. */
const isTextEntry = (entry: yauzl.Entry) => {
  const names = [
    entry.fileName,
    entry.fileNameRaw.toString('utf8'),
    entry.fileNameRaw.toString('latin1'),
  ];
  const isFolder =
    names.every((name) => name.endsWith('/')) &&
    entry.uncompressedSize === 0 &&
    entry.compressedSize === 0;
  return !isFolder && names.some((name) => !MEDIA_EXTENSIONS.has(extensionOf(name)));
};

/** The text files in a training zip, without reading its media. */
export async function readTrainingTexts(source: ZipSource): Promise<string[]> {
  const { zipfile, reader, directory } = await openRangeZip(source);
  try {
    if (directory.entries > MAX_ENTRIES)
      throw new DatasetLimitError(`it has more than ${MAX_ENTRIES} files`);
    if (directory.length > DIRECTORY_MAX_BYTES)
      throw new DatasetLimitError('its file list is too large');

    const entries: yauzl.Entry[] = [];
    let totalBytes = 0;
    let seen = 0;
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', () => resolve());
      zipfile.on('entry', (entry: yauzl.Entry) => {
        // The count in the directory record can understate the real number of entries.
        if (++seen > MAX_ENTRIES)
          return reject(new DatasetLimitError(`it has more than ${MAX_ENTRIES} files`));
        if (isTextEntry(entry)) {
          // Both sizes are declared by the uploader, and the compressed one sets how much is read.
          const size = Math.max(entry.uncompressedSize, entry.compressedSize);
          if (size > TEXT_MAX_BYTES)
            return reject(new DatasetLimitError(`${entry.fileName} is too large for a label file`));
          totalBytes += size;
          if (totalBytes > TEXT_MAX_TOTAL_BYTES)
            return reject(new DatasetLimitError('its label files are too large in total'));
          entries.push(entry);
        }
        zipfile.readEntry();
      });
      zipfile.readEntry();
    });

    // Strict: text that is not UTF-8 could read one way here and another way to the trainer.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const limit = pLimit(READ_CONCURRENCY);
    return await Promise.all(
      entries.map((entry) =>
        limit(async () => {
          const start = entry.relativeOffsetOfLocalHeader;
          const end = start + LOCAL_HEADER_ALLOWANCE + entry.fileNameLength + entry.compressedSize;
          await reader.prefetch(start, end);
          const stream = await new Promise<Readable>((resolve, reject) =>
            zipfile.openReadStream(entry, (error, readable) =>
              error || !readable
                ? reject(error ?? new InvalidZipError('Unreadable entry'))
                : resolve(readable)
            )
          );
          // yauzl stops an entry that inflates past its declared size, which was capped above.
          const chunks: Buffer[] = [];
          for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
          reader.evict(start);
          try {
            return decoder.decode(Buffer.concat(chunks));
          } catch {
            throw new DatasetLimitError(`${entry.fileName} is not UTF-8 text`);
          }
        })
      )
    );
  } finally {
    zipfile.close();
  }
}

/**
 * The trainer's zip, checked as the model will train on it: the trigger word and every text file
 * as written (the browser writes the trigger word into each label). BAD_REQUEST on a refusal or an
 * unreadable zip, SERVICE_UNAVAILABLE on a storage failure, so nothing is submitted unchecked.
 */
export async function assertTrainingZipAllowed({
  s3,
  bucket,
  key,
  triggerWord,
  userId,
  modelVersionId,
}: {
  /** The client for the bucket holding the dataset (B2 or S3). */
  s3: S3Client;
  bucket: string;
  key: string;
  triggerWord: string;
  userId: number;
  modelVersionId: number;
}): Promise<void> {
  let texts: string[];
  const controller = new AbortController();
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(READ_BUDGET_MS)]);
    const head = await headObject(bucket, key, s3, { abortSignal: signal });
    if (head.status === 'absent') throw new RangeReadError('Training data not found', true);
    if (head.status !== 'present' || !head.size)
      throw new RangeReadError('Training data could not be consulted');
    texts = await readTrainingTexts(s3ZipSource(s3, bucket, key, head.size, signal));
  } catch (e) {
    if (e instanceof DatasetLimitError)
      throw throwBadRequestError(`Your training data could not be checked: ${e.message}.`);
    if (e instanceof RangeReadError && e.notFound)
      throw throwBadRequestError(
        'Your training data could not be found. Re-upload your files and try again.'
      );
    logToAxiom({
      name: 'training-label-check',
      type: 'error',
      userId,
      modelVersionId,
      message: (e as Error)?.message,
    }).catch(() => undefined);
    if (e instanceof RangeReadError)
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: "We couldn't check your training data. Please try again in a few minutes.",
      });
    throw throwBadRequestError(
      'Your training data zip could not be read. Re-upload your files and try again.'
    );
  } finally {
    // Stops reads still in flight when another one failed.
    controller.abort();
  }

  await assertTrainingTextAllowed({
    triggerWord,
    captions: texts,
    log: { userId, source: 'trainer', modelVersionId },
  });
}
