import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  getRepoFiles,
  headHuggingFaceFile,
  huggingFaceResolveUrl,
  defaultGroupName,
  readHuggingFaceRange,
  suggestFileType,
  type HuggingFaceRepo,
} from '~/server/services/huggingface.service';
import { UploadType } from '~/server/common/enums';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  getGetUrlByKey,
  deleteObject,
  getBucket,
  getS3Client,
  urlsSafeToDelete,
  getUploadBucket,
  objectExists,
  getUploadS3Client,
  uploadPart,
} from '~/utils/s3-utils';
import { buildUploadKey } from '~/utils/upload-key';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { bytesToKB } from '~/utils/number-helpers';
import { getModelFileFormat } from '~/utils/file-helpers';
import type { ModelFileCreateInput } from '~/server/schema/model-file.schema';
import type { ModelFileType } from '~/server/common/constants';

/** A claim older than this belonged to a run that died mid-part. Sized well above one part's
 *  transfer time so a slow part is never mistaken for an abandoned one. */
const STALE_CLAIM_MINUTES = 20;
/**
 * 🔴 A LITERAL, never a bind. `make_interval` takes int4, and a JS number bound through `$queryRaw`
 * arrives as int8 — Postgres then finds no matching function and fails the whole statement with
 * 42883. No unit test can see it: the SQL is mocked wholesale, so this only ever surfaces against a
 * real database. (`minor-hash.service.ts` carries the same note for the same reason.)
 */
const STALE_CLAIM_INTERVAL = Prisma.raw(`make_interval(mins => ${STALE_CLAIM_MINUTES})`);
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MINUTES = 5;
/**
 * Fixed, and deliberately NOT `getUploadChunkSize`. That helper doubles the chunk to stay under
 * `MAX_UPLOAD_PARTS = 1000`, a bound that exists because the browser path presigns every part up
 * front — a cheap constraint there, and the wrong one to inherit here, where the part size IS the
 * pod's memory footprint. Under it a single 50GB file silently moved to 100MB parts and roughly
 * doubled resident memory. 16MB × 10,000 parts (what B2's S3 API allows) covers 160GB.
 */
export const PART_SIZE_BYTES = 16 * 1024 * 1024;
const partSizeFor = (size: number) => Math.max(PART_SIZE_BYTES, Math.ceil(size / 10_000));

type MultipartPart = { PartNumber: number; ETag: string };

export type HuggingFaceImportView = {
  id: number;
  repo: string;
  revision: string;
  filename: string;
  sourceUrl: string;
  sizeBytes: number | null;
  groupName: string;
  sourceSha256: string | null;
  status: 'Queued' | 'Transferring' | 'Completed' | 'Failed' | 'Canceled';
  bytesTransferred: number;
  url: string | null;
  error: string | null;
  modelFileId: number | null;
  modelVersionId: number | null;
  suggestedType: ReturnType<typeof suggestFileType>;
  userId: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

const importSelect = {
  id: true,
  repo: true,
  revision: true,
  filename: true,
  sourceUrl: true,
  groupName: true,
  sizeBytes: true,
  sourceSha256: true,
  status: true,
  bytesTransferred: true,
  url: true,
  error: true,
  modelFileId: true,
  modelVersionId: true,
  userId: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.HuggingFaceImportSelect;

/** BigInt columns arrive as `bigint`, which does not survive superjson to the client. */
function toView(row: Prisma.HuggingFaceImportGetPayload<{ select: typeof importSelect }>) {
  return {
    ...row,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    bytesTransferred: Number(row.bytesTransferred),
    suggestedType: suggestFileType(row.filename),
  } as HuggingFaceImportView;
}

/**
 * Transferred bytes no version has claimed. The only two ways off this list are attaching and
 * deleting — there is deliberately no dismissed-but-stored state, because a hidden row still costs
 * storage and would let the count understate what we hold.
 *
 * Shared so a tab's label and the rows under it cannot disagree about what unattached means.
 */
const UNATTACHED_WHERE = { status: 'Completed' as const, modelFileId: null };

/** The filters every list and count in this feature takes, including who may see a row. */
function scopeWhere({
  userId,
  isModerator,
  groupName,
  repo,
}: {
  userId: number;
  isModerator: boolean;
  groupName?: string;
  repo?: string;
}) {
  return {
    ...(isModerator ? {} : { userId }),
    ...(repo ? { repo } : {}),
    ...(groupName ? { groupName: { contains: groupName, mode: 'insensitive' as const } } : {}),
  };
}

/**
 * 🔴 Filtering happens HERE, not in the caller. Both surfaces take `limit` rows and used to filter
 * them client-side, so once the table passed that limit an older group returned nothing — and "no
 * results" is indistinguishable from "never imported". The skill's docs even attributed that empty
 * result to a casing mismatch and recommended a re-run that would also have found nothing.
 *
 * `repo` is an equality match and is what `HuggingFaceImport_groupName_idx`'s sibling indexes serve.
 * `groupName` is a substring search, which a plain btree cannot serve — at this table's size that is
 * a few milliseconds of seq scan, and if it ever stops being one the answer is a trigram index, not
 * a narrower filter.
 */
export async function getImports({
  userId,
  isModerator,
  limit = 100,
  groupName,
  repo,
  unattached,
}: {
  userId: number;
  isModerator: boolean;
  limit?: number;
  groupName?: string;
  repo?: string;
  unattached?: boolean;
}) {
  const rows = await dbRead.huggingFaceImport.findMany({
    where: {
      ...scopeWhere({ userId, isModerator, groupName, repo }),
      ...(unattached ? UNATTACHED_WHERE : {}),
    },
    select: importSelect,
    // A batch is one `createMany`, so its rows share `createdAt`, and every progress write moves a
    // row physically — without a full tiebreak the list reshuffles on each poll.
    orderBy: [{ createdAt: 'desc' }, { sizeBytes: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    take: limit,
  });
  return rows.map(toView);
}

/**
 * Counts for the queue's tabs. Separate from `getImports` because a page of rows cannot report how
 * many exist outside it — which is the mistake the client-side filter made. Takes the same filters
 * the rows do, or a label counts a population the list beneath it is not showing.
 */
export async function getImportCounts(input: {
  userId: number;
  isModerator: boolean;
  groupName?: string;
  repo?: string;
}) {
  const scope = scopeWhere(input);
  const [unattached, total] = await Promise.all([
    dbRead.huggingFaceImport.count({ where: { ...scope, ...UNATTACHED_WHERE } }),
    dbRead.huggingFaceImport.count({ where: scope }),
  ]);
  return { unattached, total };
}

/**
 * Files we already store under a byte-identical sha256. HF reports each LFS file's content hash
 * before any bytes move, so a text encoder shared by a dozen repos is transferred once and the next
 * import points at what we have.
 */
async function findExistingByHash(sha256List: string[]) {
  const hashes = [...new Set(sha256List.filter(Boolean).map((h) => h.toUpperCase()))];
  if (!hashes.length) return new Map<string, { fileId: number; name: string; url: string }>();

  const rows = await dbRead.modelFileHash.findMany({
    where: { type: 'SHA256', hash: { in: hashes } },
    select: { hash: true, file: { select: { id: true, name: true, url: true } } },
  });

  return new Map(
    rows.map((row) => [
      row.hash.toUpperCase(),
      { fileId: row.file.id, name: row.file.name, url: row.file.url },
    ])
  );
}

export async function resolveRepoForImport(input: { repo: string; revision?: string }) {
  const repo = await getRepoFiles(input);
  const existing = await findExistingByHash(
    repo.files.map((f) => f.sha256).filter((s): s is string => !!s)
  );
  return {
    ...repo,
    files: repo.files.map((file) => ({
      ...file,
      existing: file.sha256 ? existing.get(file.sha256.toUpperCase()) ?? null : null,
      suggestedType: suggestFileType(file.path),
    })),
  };
}

/** Model files go to B2 when it is configured, matching `/api/upload`. */
async function uploadTarget() {
  const useB2 = !!env.S3_UPLOAD_B2_ENDPOINT;
  return {
    s3: useB2 ? getUploadS3Client('b2') : getS3Client(),
    bucket: useB2 ? getUploadBucket('b2') : await getBucket(),
  };
}

/**
 * The bucket a row's bytes live in, and a client that can reach it.
 *
 * 🔴 The client follows the ROW's bucket, never the current config. A row keeps the bucket its
 * upload was opened in, which can belong to another backend — an import started where B2 is not
 * configured opens its upload in the default bucket, and a pod that has B2 then sent that bucket's
 * name to B2: "The specified bucket does not exist".
 */
async function rowTarget(row: { bucket: string | null }) {
  if (!row.bucket) return uploadTarget();
  const s3 = row.bucket === getUploadBucket('b2') ? getUploadS3Client('b2') : getS3Client();
  return { s3, bucket: row.bucket };
}

export async function enqueueImports({
  repo,
  paths,
  userId,
  groupName,
}: {
  repo: HuggingFaceRepo;
  paths: string[];
  userId: number;
  groupName?: string;
}) {
  const wanted = repo.files.filter((file) => paths.includes(file.path));
  if (!wanted.length) return { queued: 0, skipped: 0 };

  // `(repo, revision, filename)` is unique, so re-queueing a repo adds only what is new.
  const result = await dbWrite.huggingFaceImport.createMany({
    data: wanted.map((file) => ({
      repo: repo.repo,
      revision: repo.revision,
      filename: file.path,
      sourceUrl: huggingFaceResolveUrl(repo.repo, repo.revision, file.path),
      sizeBytes: file.size ? BigInt(file.size) : null,
      sourceSha256: file.sha256,
      groupName: groupName?.trim() || defaultGroupName(repo.repo),
      userId,
    })),
    skipDuplicates: true,
  });

  return { queued: result.count, skipped: wanted.length - result.count };
}

/** Scoped by owner as well as id — the page is moderator-only today, the service is not. */
async function ownedImport({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId: number;
  isModerator: boolean;
}) {
  const row = await dbRead.huggingFaceImport.findFirst({
    where: { id, userId: isModerator ? undefined : userId },
    select: {
      id: true,
      status: true,
      bucket: true,
      key: true,
      url: true,
      uploadId: true,
      modelFileId: true,
    },
  });
  if (!row) throw throwNotFoundError('Import not found');
  return row;
}

/**
 * Turns a finished import into the input `createFileHandler` takes. Going through that handler rather
 * than writing a `ModelFile` directly is what gets the storage-resolver registration and the inline
 * scan submission — an attached file has to be downloadable and scannable, not merely present.
 */
export async function buildAttachInput({
  id,
  modelVersionId,
  type,
  userId,
  isModerator,
}: {
  id: number;
  modelVersionId: number;
  type: ModelFileType;
  userId: number;
  isModerator: boolean;
}): Promise<ModelFileCreateInput & { importId: number }> {
  // Ownership is decided by `ownedImport` and nowhere else. This used to re-inline the same
  // predicate for the sake of a wider `select`, which left two copies of the rule — and this is the
  // copy that mints a `ModelFile` on a caller-supplied version, so it is the worst one to let drift.
  await ownedImport({ id, userId, isModerator });
  const row = await dbRead.huggingFaceImport.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      filename: true,
      url: true,
      key: true,
      bucket: true,
      sizeBytes: true,
      status: true,
      modelFileId: true,
    },
  });
  if (row.status !== 'Completed' || !row.url || !row.key)
    throw throwBadRequestError('That import has not finished transferring.');
  if (row.modelFileId)
    throw throwBadRequestError(
      `Already attached as file ${row.modelFileId}. Detach or delete that file first.`
    );
  if (!row.sizeBytes) throw throwBadRequestError('That import has no recorded size.');

  // 🔴 The row says Completed; the bytes may not be there. `deleteFile` refcounts live `ModelFile`
  // rows and knows nothing about imports, so deleting the one attached file — which this function's
  // own refusal message suggests — removes the object and leaves this row looking attachable.
  // Re-attaching would publish a model file pointing at nothing.
  //
  // `objectExists` is deliberately tri-state: `null` means the bucket could not be consulted, and a
  // guard that cannot ask must not block a legitimate attach.
  const { s3, bucket } = await rowTarget(row);
  const present = await objectExists(bucket, row.key, s3);
  if (present === false)
    throw throwBadRequestError(
      'The stored object for that import is gone. Re-import it before attaching.'
    );

  const name = row.filename.split('/').pop() ?? row.filename;
  return {
    importId: row.id,
    modelVersionId,
    type,
    name,
    url: row.url,
    sizeKB: bytesToKB(Number(row.sizeBytes)),
    // From the row, for the same reason the resume path reads `row.bucket`: these bytes are in the
    // bucket the transfer used, which is not necessarily what the env resolves to now.
    backend: row.bucket && row.bucket === getUploadBucket('b2') ? 'b2' : undefined,
    s3Path: row.key,
    metadata: { format: getModelFileFormat(name) },
  };
}

/**
 * Claims the import for exactly one model file. The `modelFileId: null` predicate is the real
 * double-attach guard — `buildAttachInput`'s check reads the REPLICA, so two attaches issued close
 * together both see null there and both create a file. Zero rows updated means someone else won.
 */
export async function linkImportToFile({
  id,
  modelFileId,
  modelVersionId,
}: {
  id: number;
  modelFileId: number;
  modelVersionId: number;
}) {
  const { count } = await dbWrite.huggingFaceImport.updateMany({
    where: { id, modelFileId: null },
    data: { modelFileId, modelVersionId },
  });
  return count === 1;
}

/**
 * Releases the import from its model file. Without this the refusal in `buildAttachInput` names a
 * recovery path that does not exist: attach to the wrong version, delete the file, and the row can
 * never be attached again — nor re-queued, since `(repo, revision, filename)` is unique.
 */
export async function detachImport(input: { id: number; userId: number; isModerator: boolean }) {
  const row = await ownedImport(input);
  const { count } = await dbWrite.huggingFaceImport.updateMany({
    where: { id: row.id, modelFileId: { not: null } },
    data: { modelFileId: null, modelVersionId: null },
  });
  return { ok: count === 1 };
}

/**
 * Renames a batch at any status — the name never reaches a storage key, so nothing desynchronises.
 *
 * Scoped by the CURRENT name as well as repo and revision: one repo at one revision can be imported
 * as two batches, and renaming by repo alone would silently merge them.
 */
export async function renameGroup({
  repo,
  revision,
  from,
  groupName,
  userId,
  isModerator,
}: {
  repo: string;
  revision: string;
  from: string;
  groupName: string;
  userId: number;
  isModerator: boolean;
}) {
  const name = groupName.trim();
  if (!name) throw throwBadRequestError('A group name cannot be empty.');
  if (name === from) return { renamed: 0, groupName: name };

  const { count } = await dbWrite.huggingFaceImport.updateMany({
    where: { repo, revision, groupName: from, ...(isModerator ? {} : { userId }) },
    data: { groupName: name },
  });
  if (!count) throw throwNotFoundError(`No files found in group "${from}".`);
  return { renamed: count, groupName: name };
}

/**
 * Removes an unattached import: the stored object first, then the row.
 *
 * 🔴 The row is hard-deleted rather than tombstoned. `(repo, revision, filename)` is unique, so a
 * tombstone would block ever re-importing that exact file — and a deliberate deletion is precisely
 * the case where you might want it back later. The cost is losing the record that we once held those
 * bytes, which is the cheaper of the two.
 *
 * Refuses while any `ModelFile` points at the object, which would leave a model version serving
 * nothing.
 */
export async function deleteImport(input: {
  id: number;
  userId: number;
  isModerator: boolean;
  force?: boolean;
}): Promise<ImportActionResult> {
  const row = await ownedImport(input);
  if (row.modelFileId)
    throw throwBadRequestError(
      `That import is attached as file ${row.modelFileId}. Detach it first.`
    );
  if (row.status === 'Queued' || row.status === 'Transferring')
    throw throwBadRequestError('Cancel the transfer before deleting it.');

  // 🔴 `modelFileId` is NOT a reference count — detach clears it and leaves the `ModelFile` alive,
  // so the check above passes on a row a published version is still serving. `ModelFile.url` is the
  // authoritative reference. Called directly rather than through `deleteModelFileObject`, which
  // skips silently when unsafe and would leave the row deleted while the bytes stayed.
  if (row.url) {
    const { safe } = await urlsSafeToDelete([row.url]);
    if (!safe.length)
      throw throwBadRequestError(
        'A model file still points at that object. Delete the model file first.'
      );
  }

  // The row is the only handle on what it stored, so by default a cleanup failure keeps it.
  const cleanup = await freeStorage(row);
  if (!cleanup.ok) {
    if (!input.force) return { ok: false, reason: 'storage', message: cleanup.message };
    logLeftBehind('delete', row, cleanup.message);
  }

  // The predicate rides into the write: `ownedImport` read the REPLICA, so an attach that committed
  // during the lag would otherwise have its brand-new model file left pointing at deleted bytes.
  const { count } = await dbWrite.huggingFaceImport.deleteMany({
    where: { id: row.id, modelFileId: null },
  });
  if (!count) throw throwBadRequestError('That import was attached while you were deleting it.');
  return { ok: true as const };
}

export async function retryImport(input: {
  id: number;
  userId: number;
  isModerator: boolean;
  force?: boolean;
}): Promise<ImportActionResult> {
  const row = await ownedImport(input);
  if (row.status !== 'Failed' && row.status !== 'Canceled') return { ok: false, reason: 'state' };

  // Always from nothing, in the backend configured now. Resuming after a failed abort is what kept
  // an import stuck: the upload that could not be aborted was the one that kept failing.
  const abort = await abortIfInFlight(row);
  if (!abort.ok) {
    if (!input.force) return { ok: false, reason: 'storage', message: abort.message };
    logLeftBehind('retry', row, abort.message);
  }
  await dbWrite.huggingFaceImport.update({
    where: { id: row.id },
    data: {
      status: 'Queued',
      error: null,
      attempts: 0,
      nextAttemptAt: null,
      bytesTransferred: BigInt(0),
      uploadId: null,
      parts: Prisma.DbNull,
      key: null,
      bucket: null,
      partSize: null,
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      startedAt: null,
    },
  });
  return { ok: true };
}

export async function cancelImport(input: { id: number; userId: number; isModerator: boolean }) {
  const row = await ownedImport(input);
  if (row.status !== 'Queued' && row.status !== 'Transferring') return { ok: false as const };

  // 🔴 The status predicate is in the WHERE, not only in the check above: `ownedImport` reads the
  // REPLICA, so a transfer that completed during the lag would otherwise have `Completed` overwritten
  // with `Canceled` — stranding a finished multi-GB object on a row that can no longer be attached,
  // re-queued (the unique key) or retried (aborting a completed upload throws).
  const { count } = await dbWrite.huggingFaceImport.updateMany({
    where: { id: row.id, status: { in: ['Queued', 'Transferring'] } },
    data: { status: 'Canceled' },
  });
  if (!count) return { ok: false as const };

  // 🔴 Re-read from the PRIMARY before aborting. `row` is the replica snapshot taken before the
  // cancel, and a run that created its multipart upload in between would not appear in it — aborting
  // with that stale row silently no-ops and leaves every transferred part in the bucket, billed,
  // with nothing holding the id needed to free them.
  const current = await dbWrite.huggingFaceImport.findUnique({
    where: { id: row.id },
    select: { bucket: true, key: true, uploadId: true },
  });
  const abort = current ? await abortIfInFlight(current) : ({ ok: true } as const);
  // The upload id stays on the row, so a later Restart or Delete tries the abort again.
  if (!abort.ok)
    logToAxiom({
      type: 'warn',
      name: 'huggingface-import',
      message: 'cancel could not abort',
      error: abort.message,
    });
  return { ok: true as const };
}

type StoredRow = { bucket: string | null; key: string | null; uploadId: string | null };
type Cleanup = { ok: true } | { ok: false; message: string };

export type ImportActionResult =
  | { ok: true }
  | { ok: false; reason: 'state' }
  | { ok: false; reason: 'storage'; message: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `ok` means the upload is known to be gone — only then may a caller forget its `uploadId`. */
const errorName = (error: unknown) => (error as { name?: string } | null)?.name;
/** The thing to remove is already gone — which is what removing it was for. */
const alreadyGone = (error: unknown) =>
  ['NoSuchUpload', 'NoSuchKey', 'NotFound'].includes(errorName(error) ?? '');

/**
 * Runs a removal against the row's storage. A bucket unknown to the backend `rowTarget` picked is
 * tried on the other configured backend before giving up: a bucket name is all a row records, and
 * guessing its backend wrong is exactly how "The specified bucket does not exist" arose.
 */
async function removeFromRowStorage(
  row: StoredRow,
  describe: string,
  remove: (bucket: string, s3: ReturnType<typeof getS3Client>) => Promise<unknown>
): Promise<Cleanup> {
  const { s3, bucket } = await rowTarget(row);
  const clients = [s3];
  if (bucket === getUploadBucket('b2')) clients.push(getS3Client());
  else if (env.S3_UPLOAD_B2_ENDPOINT) clients.push(getUploadS3Client('b2'));

  let lastError: unknown;
  for (const client of clients) {
    try {
      await remove(bucket, client);
      return { ok: true };
    } catch (error) {
      if (alreadyGone(error)) return { ok: true };
      lastError = error;
      if (errorName(error) !== 'NoSuchBucket') break;
    }
  }
  return { ok: false, message: `Could not ${describe}: ${errorText(lastError)}` };
}

async function abortIfInFlight(row: StoredRow): Promise<Cleanup> {
  const { key, uploadId } = row;
  if (!row.bucket || !key || !uploadId) return { ok: true };
  return removeFromRowStorage(row, 'abort the partial upload', (bucket, s3) =>
    abortMultipartUpload(bucket, key, uploadId, s3)
  );
}

/** Frees whatever the row stored: an unfinished multipart, a finished object, or both. */
async function freeStorage(row: StoredRow): Promise<Cleanup> {
  const abort = await abortIfInFlight(row);
  const { key } = row;
  if (!abort.ok || !key) return abort;
  return removeFromRowStorage(row, 'delete the stored file', (bucket, s3) =>
    deleteObject(bucket, key, s3)
  );
}

/** A forced action forgets the row's handle, so this log line is what is left to clean up from. */
function logLeftBehind(action: 'delete' | 'retry', row: StoredRow, reason: string) {
  logToAxiom({
    type: 'warn',
    name: 'huggingface-import',
    message: `forced ${action} left storage behind`,
    bucket: row.bucket,
    key: row.key,
    uploadId: row.uploadId,
    error: reason,
  });
}

type ClaimedRow = {
  id: number;
  repo: string;
  filename: string;
  sourceUrl: string;
  sizeBytes: bigint | null;
  status: string;
  uploadId: string | null;
  partSize: number | null;
  parts: unknown;
  bucket: string | null;
  key: string | null;
  attempts: number;
  userId: number | null;
  claimedBy: string | null;
};

/**
 * Claims one row for this run. `FOR UPDATE SKIP LOCKED` keeps two runs off the same file, and a NULL
 * `claimedAt` is what a cleanly-yielded row leaves behind — so a transfer that ran out of budget is
 * eligible again on the very next tick, while one whose run died waits out the stale window.
 */
async function claimNext(worker: string) {
  const rows = await dbWrite.$queryRaw<ClaimedRow[]>`
    UPDATE "HuggingFaceImport" SET
      status = 'Transferring',
      "claimedBy" = ${worker},
      "claimedAt" = now(),
      "heartbeatAt" = now(),
      "startedAt" = coalesce("startedAt", now()),
      "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "HuggingFaceImport"
      WHERE status IN ('Queued', 'Transferring')
        AND ("claimedAt" IS NULL OR "heartbeatAt" < now() - ${STALE_CLAIM_INTERVAL})
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
      ORDER BY "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, repo, filename, "sourceUrl", "sizeBytes", status, "uploadId", "partSize",
              parts, bucket, key, attempts, "userId", "claimedBy"
  `;
  return rows[0];
}

async function yieldClaim(id: number) {
  await dbWrite.huggingFaceImport.update({
    where: { id },
    data: { claimedBy: null, claimedAt: null },
  });
}

async function failOrRetry(row: ClaimedRow, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const attempts = row.attempts + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;

  const abort = giveUp ? await abortIfInFlight(row) : null;
  if (abort && !abort.ok)
    logToAxiom({
      type: 'warn',
      name: 'huggingface-import',
      message: 'gave up but could not abort; the upload id stays on the row',
      error: abort.message,
    });
  const aborted = abort?.ok ?? false;
  await dbWrite.huggingFaceImport.updateMany({
    where: { id: row.id, claimedBy: row.claimedBy, status: { not: 'Canceled' } },
    data: {
      status: giveUp ? 'Failed' : 'Transferring',
      attempts,
      error: message.slice(0, 1000),
      claimedBy: null,
      claimedAt: null,
      nextAttemptAt: giveUp
        ? null
        : new Date(Date.now() + RETRY_BACKOFF_MINUTES * attempts * 60_000),
      ...(aborted ? { uploadId: null, parts: Prisma.DbNull } : {}),
    },
  });

  logToAxiom({
    type: 'error',
    name: 'huggingface-import',
    message,
    importId: row.id,
    repo: row.repo,
    filename: row.filename,
    attempts,
    giveUp,
  });
}

/**
 * Moves one file as far as the deadline allows. Returns `true` when the file finished, `false` when
 * it yielded with work left — the caller reclaims either way.
 */
async function advanceImport(
  row: ClaimedRow,
  deadline: number,
  partsInFlight: number
): Promise<number> {
  const size = row.sizeBytes
    ? Number(row.sizeBytes)
    : (await headHuggingFaceFile(row.sourceUrl)) ?? 0;
  if (!size) throw new Error(`Hugging Face reported no size for ${row.repo}/${row.filename}`);

  let uploadId = row.uploadId;
  let key = row.key;
  // A resume addresses the bucket the multipart upload was opened in, through a client that reaches
  // it — see `rowTarget`.
  const { s3, bucket } = uploadId && key ? await rowTarget(row) : await uploadTarget();
  const partSize = row.partSize ?? partSizeFor(size);

  if (!uploadId || !key) {
    // Refuse rather than invent an owner: `model/0/…` is a key no upload path could produce, and the
    // userId segment is what `/api/upload/sign-part` authorises against.
    if (!row.userId)
      throw new Error(`Import ${row.id} has no owner; refusing to build a key for it`);
    key = buildUploadKey(
      UploadType.Model,
      row.userId,
      row.filename.split('/').pop() ?? row.filename
    );
    uploadId = await createMultipartUpload({ bucket, key, s3 });
    await dbWrite.huggingFaceImport.update({
      where: { id: row.id },
      data: { uploadId, key, bucket, partSize, sizeBytes: BigInt(size) },
    });
  }

  const parts: MultipartPart[] = Array.isArray(row.parts) ? (row.parts as MultipartPart[]) : [];
  const done = new Set(parts.map((part) => part.PartNumber));
  const totalParts = Math.ceil(size / partSize);

  const sizeOfPart = (partNumber: number) =>
    Math.min(partNumber * partSize, size) - (partNumber - 1) * partSize;
  const transferred = () => parts.reduce((sum, part) => sum + sizeOfPart(part.PartNumber), 0);

  // Parts complete out of order, so `done` is a set with holes and never a count. `parts.length + 1`
  // would re-upload a part already written the moment one finishes ahead of another.
  const pending: number[] = [];
  for (let partNumber = 1; partNumber <= totalParts; partNumber++)
    if (!done.has(partNumber)) pending.push(partNumber);

  let stopped = false;
  let canceled = false;
  let movedBytes = 0;

  const movePart = async (partNumber: number) => {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, size) - 1;

    const body = await readHuggingFaceRange({ url: row.sourceUrl, start, end });
    if (body.byteLength !== end - start + 1)
      throw new Error(
        `Range ${start}-${end} returned ${body.byteLength} bytes for ${row.repo}/${row.filename}`
      );

    const etag = await uploadPart({ bucket, key, uploadId, partNumber, body, s3 });
    parts.push({ PartNumber: partNumber, ETag: etag });
    done.add(partNumber);
    movedBytes += body.byteLength;

    // `heartbeatAt` is load-bearing, not telemetry: it is the only thing that stops another run
    // re-claiming this row once the stale window elapses, which would put two runs on one uploadId.
    await dbWrite.huggingFaceImport.updateMany({
      where: { id: row.id, claimedBy: row.claimedBy },
      data: {
        parts: parts as unknown as Prisma.InputJsonValue,
        bytesTransferred: BigInt(transferred()),
        heartbeatAt: new Date(),
      },
    });
  };

  const worker = async () => {
    for (;;) {
      if (stopped || canceled) return;
      if (Date.now() >= deadline) {
        stopped = true;
        return;
      }
      const current = await dbRead.huggingFaceImport.findUnique({
        where: { id: row.id },
        select: { status: true },
      });
      if (current?.status === 'Canceled') {
        canceled = true;
        return;
      }

      const partNumber = pending.shift();
      if (partNumber === undefined) return;
      await movePart(partNumber);
    }
  };

  await Promise.all(Array.from({ length: Math.min(partsInFlight, pending.length) }, worker));

  if (canceled || done.size < totalParts) return movedBytes;

  // Re-read the status immediately before finalizing. The workers' probe happens BEFORE each takes
  // its part, so the last one never checks again — without this, a cancel arriving during the final
  // part still completes the upload and stamps a URL on a row the moderator stopped.
  const beforeComplete = await dbWrite.huggingFaceImport.findUnique({
    where: { id: row.id },
    select: { status: true, claimedBy: true },
  });
  if (beforeComplete?.status === 'Canceled' || beforeComplete?.claimedBy !== row.claimedBy)
    return movedBytes;

  parts.sort((a, b) => a.PartNumber - b.PartNumber);
  await completeMultipartUpload(bucket, key, uploadId, parts, s3);

  // Presigned GET with the query stripped: the same `https://<endpoint>/<bucket>/<key>` shape the
  // browser path writes to `ModelFile.url`, without a second copy of the endpoint config here.
  // Deliberately not `getCustomPutUrl` — that bumps `recordB2PresignIssued`, a counter whose whole
  // purpose is measuring browser-direct uploads, and a server transfer is not one.
  const { url } = await getGetUrlByKey(key, { s3, bucket });
  await dbWrite.huggingFaceImport.updateMany({
    where: { id: row.id, claimedBy: row.claimedBy, status: { not: 'Canceled' } },
    data: {
      status: 'Completed',
      url: url.split('?')[0],
      bytesTransferred: BigInt(size),
      completedAt: new Date(),
      error: null,
      attempts: 0,
      // Spent. A retained id makes every later abort fail against a finished upload, burying the
      // one abort failure that means parts are still billed.
      uploadId: null,
    },
  });
  return movedBytes;
}

/**
 * Drains the queue until `deadline`. Bounded work per call by design: a transfer is a sequence of
 * resumable parts, so the job never needs a run longer than its own lock.
 */
export async function processImportQueue({
  deadline,
  worker,
  concurrency,
  partsInFlight,
}: {
  deadline: number;
  worker: string;
  concurrency: number;
  partsInFlight: number;
}) {
  let moved = 0;
  let bytes = 0;

  const drain = async () => {
    while (Date.now() < deadline) {
      const row = await claimNext(worker);
      if (!row) return;
      try {
        bytes += await advanceImport(row, deadline, partsInFlight);
        moved++;
      } catch (error) {
        await failOrRetry(row, error);
        continue;
      }
      await yieldClaim(row.id).catch(() => undefined);
    }
  };

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: concurrency }, drain));
  const seconds = (Date.now() - startedAt) / 1000;

  // Throughput is the number every question about this feature turns on — whether it is too slow,
  // whether it is starving the pod, what any bandwidth limit should be set to — and nothing else
  // records it. Emitted per run rather than per part so a quiet run is one line, not none.
  if (bytes)
    logToAxiom({
      type: 'info',
      name: 'huggingface-import-throughput',
      bytes,
      seconds: Math.round(seconds),
      bytesPerSecond: Math.round(bytes / Math.max(seconds, 1)),
      filesTouched: moved,
      concurrency,
      partsInFlight,
    });

  return { moved, bytes };
}
