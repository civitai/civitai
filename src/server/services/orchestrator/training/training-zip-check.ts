import type { S3Client } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import type { Readable } from 'stream';
import type * as yauzl from 'yauzl';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import {
  assertTrainingTextAllowed,
  takeTrainingTextCheckBudget,
  TRAINING_DATASET_MAX_FILES,
  TRAINING_TEXT_MAX_CHARS,
} from '~/server/services/orchestrator/training/training-label-check';
import { sleep } from '~/server/utils/concurrency-helpers';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import {
  InvalidZipError,
  openRangeZip,
  RangeReadError,
  s3ZipSource,
  type ZipSource,
} from '~/server/utils/zip-range-reader';
import { getB2S3Client, getS3Client, headObject, isB2Url, parseKey } from '~/utils/s3-utils';

// The trainer's dataset zip goes from the browser straight to storage, so the server never sees it
// pass. It is read when the file is registered, and the verdict is kept for the submit to read.

const TEXT_MAX_BYTES = 64 * 1024;
const DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;
/** Read with each local header so its name, extra field and data usually arrive in the same GET. */
const LOCAL_HEADER_ALLOWANCE = 30 + 1024;
const READ_CONCURRENCY = 16;
const READ_BUDGET_MS = 60_000;
const READ_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;
const HEAD_TIMEOUT_MS = 10_000;
/** Renewed while a check runs; a check that dies frees the zip for another after this. */
const LOCK_TTL_SECONDS = 60;
/** A draft can wait weeks between upload and submit; an expired verdict is checked again. */
const VERDICT_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A pass the classifier did not answer, or a check that could not finish, is redone after this. */
const RECHECK_TTL_SECONDS = 10 * 60;

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
async function readTrainingTexts(source: ZipSource): Promise<string[]> {
  const { zipfile, reader, directory } = await openRangeZip(source);
  try {
    if (directory.entries > TRAINING_DATASET_MAX_FILES)
      throw new DatasetLimitError(`it has more than ${TRAINING_DATASET_MAX_FILES} files`);
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
        if (++seen > TRAINING_DATASET_MAX_FILES)
          return reject(
            new DatasetLimitError(`it has more than ${TRAINING_DATASET_MAX_FILES} files`)
          );
        if (isTextEntry(entry)) {
          // Both sizes are declared by the uploader, and the compressed one sets how much is read.
          const size = Math.max(entry.uncompressedSize, entry.compressedSize);
          if (size > TEXT_MAX_BYTES)
            return reject(new DatasetLimitError(`${entry.fileName} is too large for a label file`));
          totalBytes += size;
          // In bytes, which a UTF-8 text never has fewer of than characters.
          if (totalBytes > TRAINING_TEXT_MAX_CHARS)
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

type StoredZip = { s3: S3Client; bucket: string; key: string };
/** A verdict with a `code` is not the dataset's: the check could not finish, so the user retries. */
type ZipVerdict =
  | { ok: true }
  | { ok: false; reason: string; code?: 'TOO_MANY_REQUESTS' | 'SERVICE_UNAVAILABLE' };
type Judged = { verdict: ZipVerdict; ttl: number };

const verdictKey = (id: string) =>
  `${REDIS_KEYS.TRAINING.ZIP_VERDICT}:${id}` as RedisKeyTemplateCache;

const RE_UPLOAD = 'Your training data could not be found. Re-upload your files and try again.';
const UNAVAILABLE = "We couldn't check your training data. Please try again in a few minutes.";

function locateTrainingZip(url: string): StoredZip {
  const { bucket, key } = parseKey(url);
  return {
    s3: isB2Url(url) ? getB2S3Client() : getS3Client(),
    bucket: bucket ?? env.S3_UPLOAD_BUCKET,
    key,
  };
}

/** The zip as stored now. A verdict is recorded against its ETag, so a replaced object is checked
 *  anew. `null` when storage could not be consulted. */
async function storedObject(zip: StoredZip) {
  const head = await headObject(zip.bucket, zip.key, zip.s3, {
    abortSignal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
  });
  if (head.status === 'absent') return 'absent' as const;
  if (head.status !== 'present' || !head.size || !head.etag) return null;
  return { size: head.size, id: `${zip.bucket}/${zip.key}/${head.etag}` };
}

const logCheckError = (e: unknown, log: { userId: number; modelVersionId: number }) =>
  logToAxiom({
    name: 'training-label-check',
    type: 'error',
    ...log,
    message: (e as Error)?.message,
  }).catch(() => undefined);

/** Reads and checks the zip's text. `null` when the zip went from storage while it was read. */
async function judgeTrainingZip(
  zip: StoredZip,
  size: number,
  log: { userId: number; modelVersionId: number }
): Promise<Judged | null> {
  const refusal = (reason: string): Judged => ({
    verdict: { ok: false, reason },
    ttl: VERDICT_TTL_SECONDS,
  });
  const retryLater = (e: unknown): Judged => {
    logCheckError(e, log);
    return {
      verdict: { ok: false, reason: UNAVAILABLE, code: 'SERVICE_UNAVAILABLE' },
      ttl: RECHECK_TTL_SECONDS,
    };
  };

  let texts: string[];
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(READ_BUDGET_MS)]);
      texts = await readTrainingTexts(s3ZipSource(zip.s3, zip.bucket, zip.key, size, signal));
      break;
    } catch (e) {
      if (e instanceof DatasetLimitError)
        return refusal(`Your training data could not be checked: ${e.message}.`);
      if (e instanceof InvalidZipError)
        return refusal(
          'Your training data zip could not be read. Re-upload your files and try again.'
        );
      if (e instanceof RangeReadError && e.notFound) return null;
      if (e instanceof RangeReadError && attempt < READ_ATTEMPTS) {
        await sleep(attempt * RETRY_DELAY_MS);
        continue;
      }
      return retryLater(e);
    } finally {
      // Stops reads still in flight when another one failed.
      controller.abort();
    }
  }

  try {
    const rate = await takeTrainingTextCheckBudget(log.userId, texts);
    if (!rate.allowed)
      return {
        verdict: {
          ok: false,
          reason: 'Too many training checks. Please try again later.',
          code: 'TOO_MANY_REQUESTS',
        },
        ttl: Math.max(1, rate.retryAfterSeconds),
      };
    // The trigger word is checked at submit, where it is read from the version.
    const { classifierFailed } = await assertTrainingTextAllowed({
      triggerWord: '',
      captions: texts,
      log: { ...log, source: 'trainer' },
    });
    return {
      verdict: { ok: true },
      ttl: classifierFailed ? RECHECK_TTL_SECONDS : VERDICT_TTL_SECONDS,
    };
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'BAD_REQUEST') return refusal(e.message);
    return retryLater(e);
  }
}

async function runTrainingZipCheck(
  zip: StoredZip,
  object: { size: number; id: string },
  log: { userId: number; modelVersionId: number }
) {
  // One check per stored zip at a time; a check already running is left to finish.
  await withDistributedLock(
    {
      key: `training-zip-check:${object.id}`,
      ttl: LOCK_TTL_SECONDS,
      maxRetries: 0,
      autoRenew: true,
    },
    async () => {
      const judged = await judgeTrainingZip(zip, object.size, log);
      if (judged) await redis.packed.set(verdictKey(object.id), judged.verdict, { EX: judged.ttl });
    }
  );
}

/**
 * Checks an uploaded training zip and records the verdict for the submit to read. Called without
 * awaiting when the dataset file is registered, so the user configures the run while it reads.
 * Never throws.
 */
export async function startTrainingZipCheck({
  url,
  userId,
  modelVersionId,
}: {
  url: string;
  userId: number;
  modelVersionId: number;
}): Promise<void> {
  try {
    const zip = locateTrainingZip(url);
    const object = await storedObject(zip);
    if (!object || object === 'absent') return;
    if (await redis.packed.get(verdictKey(object.id))) return;
    await runTrainingZipCheck(zip, object, { userId, modelVersionId });
  } catch (e) {
    logCheckError(e, { userId, modelVersionId });
  }
}

/**
 * The submit's half: the verdict recorded for the zip as stored now, plus the trigger word, which
 * the version holds and can change after upload. BAD_REQUEST on a refusal; PRECONDITION_FAILED
 * while no verdict exists yet (one is started); SERVICE_UNAVAILABLE or TOO_MANY_REQUESTS when the
 * zip could not be checked, so nothing is submitted unchecked.
 */
export async function assertTrainingZipAllowed({
  url,
  triggerWord,
  userId,
  modelVersionId,
}: {
  url: string;
  triggerWord: string;
  userId: number;
  modelVersionId: number;
}): Promise<void> {
  const unavailable = () => new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: UNAVAILABLE });

  let zip: StoredZip;
  let object: Awaited<ReturnType<typeof storedObject>>;
  let verdict: ZipVerdict | null;
  try {
    zip = locateTrainingZip(url);
    object = await storedObject(zip);
    if (object === 'absent') throw throwBadRequestError(RE_UPLOAD);
    if (!object) throw unavailable();
    verdict = await redis.packed.get<ZipVerdict>(verdictKey(object.id));
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    logCheckError(e, { userId, modelVersionId });
    throw unavailable();
  }

  if (!verdict) {
    // Uploaded before upload checks existed, expired, or the upload check has not finished.
    const found = object;
    void runTrainingZipCheck(zip, found, { userId, modelVersionId }).catch((e) =>
      logCheckError(e, { userId, modelVersionId })
    );
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Your training data is still being checked. Please try again in a minute.',
    });
  }
  if (!verdict.ok) {
    if (verdict.code) throw new TRPCError({ code: verdict.code, message: verdict.reason });
    logToAxiom({
      name: 'training-text-refused',
      type: 'info',
      userId,
      modelVersionId,
      source: 'trainer',
      via: 'upload',
      reasons: [verdict.reason],
    }).catch(() => undefined);
    throw throwBadRequestError(verdict.reason);
  }

  await assertTrainingTextAllowed({
    triggerWord,
    captions: [],
    log: { userId, source: 'trainer', modelVersionId },
  });
}
