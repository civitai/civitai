import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { findHashOwnership } from '~/server/services/model-file-hash-owner.service';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  handleLogError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { BountyType } from '~/shared/utils/prisma/enums';
import { getDownloadUrl } from '~/utils/delivery-worker';

/**
 * Bounty entry files must not be another user's model. The bounty entry form checks this in the
 * browser; this is the server's check. A job hashes each entry file of an open model bounty and
 * records the result in the file's metadata; award refuses an entry until every file is checked
 * and clean, and a blocked file can't be downloaded. Behind BOUNTY_ENTRY_FILE_CHECK.
 */

export const FILE_CHECKED_BOUNTY_TYPES: BountyType[] = [
  BountyType.ModelCreation,
  BountyType.LoraCreation,
  BountyType.EmbedCreation,
];

export const BLOCKED_FILE_REASON = 'other-users-model';

type FileCheckState = 'clean' | 'blocked' | 'unchecked';

/**
 * A moderator's ruling that a blocked file is fine. Dropped with the other check keys on a new url.
 * `replaced` is the malformed value the clear wrote over, kept so a re-block puts it back.
 */
export type FileCheckOverride = { by: number; at: string; reason: string; replaced?: unknown };

/**
 * Only the shape the clear writes counts: metadata from before these keys were server-only may hold
 * anything. Kept to rules SQL states identically (VALID_OVERRIDE_SQL): an id of at most 15 digits,
 * and ASCII whitespace only.
 */
export function isFileCheckOverride(value: unknown): value is FileCheckOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { by, at, reason } = value as Record<string, unknown>;
  return (
    Number.isInteger(by) &&
    (by as number) > 0 &&
    (by as number) <= 999_999_999_999_999 &&
    typeof at === 'string' &&
    typeof reason === 'string' &&
    /[^ \t\n\v\f\r]/.test(reason)
  );
}

/**
 * `isFileCheckOverride` in SQL, over the File row aliased as `f`. The moderator app keeps a copy,
 * pinned equal to this one by a test.
 */
export const VALID_OVERRIDE_SQL = Prisma.sql`(
  jsonb_typeof(f.metadata->'checkOverride'->'by') = 'number'
  AND (f.metadata->'checkOverride'->>'by') ~ '^[1-9][0-9]{0,14}$'
  AND jsonb_typeof(f.metadata->'checkOverride'->'at') = 'string'
  AND jsonb_typeof(f.metadata->'checkOverride'->'reason') = 'string'
  AND (f.metadata->'checkOverride'->>'reason')
    ~ ('[^ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || ']')
)`;

/**
 * The stored hash failure count of the File row aliased as `f`, 0 unless it is a small whole
 * number: a bare `::int` throws on a planted value and would fail every run of the job. The
 * moderator app keeps a copy, pinned equal to this one by a test.
 */
export const HASH_FAIL_COUNT_SQL = Prisma.sql`CASE WHEN jsonb_typeof(f.metadata->'hashFailCount') = 'number'
  AND (f.metadata->>'hashFailCount') ~ '^[0-9]{1,6}$'
  THEN (f.metadata->>'hashFailCount')::int ELSE 0 END`;

export function fileCheckState(metadata: unknown): FileCheckState {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (meta.blockedReason && !isFileCheckOverride(meta.checkOverride)) return 'blocked';
  return meta.hashCheckedAt ? 'clean' : 'unchecked';
}

export const isBountyEntryFileCheckOn = () => isFlipt(FLIPT_FEATURE_FLAGS.BOUNTY_ENTRY_FILE_CHECK);

/** Whether this bounty's entry files are checked: a model bounty, with the check on. */
async function isCheckedBounty(tx: Prisma.TransactionClient, bountyId: number, checkOn: boolean) {
  if (!checkOn) return false;
  const bounty = await tx.bounty.findUnique({ where: { id: bountyId }, select: { type: true } });
  return !!bounty && FILE_CHECKED_BOUNTY_TYPES.includes(bounty.type);
}

/**
 * Throws unless every file of the entry has been checked and none is another user's model.
 * `checkOn` is the flag, read before the transaction.
 */
export async function assertBountyEntryFilesChecked({
  tx,
  entryId,
  bountyId,
  checkOn,
}: {
  tx: Prisma.TransactionClient;
  entryId: number;
  bountyId: number;
  checkOn: boolean;
}) {
  if (!(await isCheckedBounty(tx, bountyId, checkOn))) return;

  const files = await tx.file.findMany({
    where: { entityId: entryId, entityType: 'BountyEntry' },
    select: { metadata: true },
  });
  const states = files.map((f) => fileCheckState(f.metadata));
  if (states.includes('blocked'))
    throw throwBadRequestError(
      "This entry's files match a model that belongs to another user and can't be awarded."
    );
  if (states.includes('unchecked'))
    throw throwBadRequestError(
      "This entry's files are still being checked. Try again in a few minutes."
    );
}

/** The check state of every entry of a bounty, for the expiry auto-award. Null when not checked. */
export async function getBountyEntryFileStates({
  tx,
  bountyId,
  checkOn,
}: {
  tx: Prisma.TransactionClient;
  bountyId: number;
  checkOn: boolean;
}) {
  if (!(await isCheckedBounty(tx, bountyId, checkOn))) return null;

  const files = await tx.$queryRaw<{ entryId: number; metadata: unknown }[]>`
    SELECT be.id AS "entryId", f.metadata
    FROM "BountyEntry" be
    JOIN "File" f ON f."entityType" = 'BountyEntry' AND f."entityId" = be.id
    WHERE be."bountyId" = ${bountyId}
  `;
  const blockedEntryIds = new Set<number>();
  let unchecked = false;
  for (const { entryId, metadata } of files) {
    const state = fileCheckState(metadata);
    if (state === 'blocked') blockedEntryIds.add(entryId);
    if (state === 'unchecked') unchecked = true;
  }
  return { blockedEntryIds: [...blockedEntryIds], unchecked };
}

/** SHA256 of a stored file, uppercase like ModelFileHash. Streams it; never buffers it whole. */
export async function hashStoredFile({ url, name }: { url: string; name: string }) {
  const { url: downloadUrl } = await getDownloadUrl(url, name);
  const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  const hash = createHash('sha256');
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
  return hash.digest('hex').toUpperCase();
}

type PendingFile = {
  id: number;
  url: string;
  name: string;
  sizeKB: number;
  authorId: number | null;
  hashFailCount: number;
};

/**
 * Hashes the oldest unchecked entry files of open model bounties, up to `limit` files and
 * `maxBytes` (the first file always runs, so one large file can't stall the queue). A file that
 * fails to hash stays unchecked, so award keeps refusing it, and goes to the back of the queue.
 */
export async function checkPendingBountyEntryFiles({
  limit = 20,
  maxBytes = 8 * 1024 ** 3,
  hashFile = hashStoredFile,
  checkCanceled = () => undefined,
}: {
  limit?: number;
  maxBytes?: number;
  hashFile?: (file: { url: string; name: string }) => Promise<string>;
  checkCanceled?: () => void;
} = {}) {
  const pending = await dbRead.$queryRaw<PendingFile[]>`
    SELECT f.id, f.url, f.name, f."sizeKB", be."userId" AS "authorId",
      ${HASH_FAIL_COUNT_SQL} AS "hashFailCount"
    FROM "Bounty" b
    JOIN "BountyEntry" be ON be."bountyId" = b.id
    JOIN "File" f ON f."entityType" = 'BountyEntry' AND f."entityId" = be.id
    WHERE b.type::text = ANY(${FILE_CHECKED_BOUNTY_TYPES})
      AND NOT b.complete
      AND NOT b.refunded
      AND f.metadata->>'hashCheckedAt' IS NULL
    ORDER BY f.metadata->>'hashAttemptedAt' ASC NULLS FIRST, f.id ASC
    LIMIT ${limit}
  `;

  const result = { checked: 0, blocked: 0, failed: 0, bytes: 0 };
  for (const file of pending) {
    const bytes = file.sizeKB * 1024;
    if (result.checked + result.failed > 0 && result.bytes + bytes > maxBytes) break;
    checkCanceled();
    result.bytes += bytes;

    const attemptedAt = new Date().toISOString();
    let sha256: string;
    try {
      sha256 = await hashFile(file);
    } catch (error) {
      result.failed++;
      logToAxiom({
        type: 'error',
        name: 'bounty-entry-file-check',
        message: 'hash failed',
        fileId: file.id,
        error: (error as Error).message,
      }).catch(handleLogError);
      await mergeFileMetadata(file, {
        hashAttemptedAt: attemptedAt,
        hashFailCount: file.hashFailCount + 1,
        hashLastError: shortHashError(error),
      });
      continue;
    }

    // An entry with no author has nobody whose model it could be: every match counts.
    const [match] = await findHashOwnership({ hashes: [sha256], userId: file.authorId ?? -1 });
    const blocked = !!match?.ownedByOther;
    await mergeFileMetadata(file, {
      sha256Server: sha256,
      hashAttemptedAt: attemptedAt,
      hashCheckedAt: new Date().toISOString(),
      ...(blocked ? { blockedReason: BLOCKED_FILE_REASON } : {}),
    });
    result.checked++;
    if (blocked) {
      result.blocked++;
      logToAxiom({
        type: 'warning',
        name: 'bounty-entry-file-check',
        message: 'blocked',
        fileId: file.id,
      }).catch(handleLogError);
    }
  }
  return result;
}

/** Shown to moderators: short, and without the signed download url a fetch error can carry. */
function shortHashError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[a-z][\w+.-]*:\/\/\S+/gi, '<url>').slice(0, 200);
}

/** Only while the file still has the url that was hashed: a re-upload is checked afresh. */
function mergeFileMetadata(file: PendingFile, patch: Record<string, string | number>) {
  return dbWrite.$executeRaw`
    UPDATE "File"
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${file.id} AND url = ${file.url}
  `;
}

/**
 * A moderator rules that a blocked entry file is fine: award and download then treat it as clean.
 * Applies only to the url the moderator reviewed; a re-upload is checked afresh.
 */
export async function clearBountyEntryFileCheck({
  fileId,
  userId,
  reason,
}: {
  fileId: number;
  userId: number;
  reason: string;
}) {
  const file = await dbWrite.file.findUnique({
    where: { id: fileId },
    select: { id: true, url: true, entityType: true, entityId: true, metadata: true },
  });
  if (!file || file.entityType !== 'BountyEntry')
    throw throwNotFoundError(`No bounty entry file ${fileId}.`);
  if (fileCheckState(file.metadata) !== 'blocked')
    throw throwBadRequestError('This file is not blocked.');

  // The stored value just read, which fileCheckState judged no clear (absent, or malformed).
  const meta = (file.metadata ?? {}) as Record<string, unknown>;
  const hadOverride = 'checkOverride' in meta;
  const readOverride = hadOverride ? JSON.stringify(meta.checkOverride) : null;
  const override: FileCheckOverride = {
    by: userId,
    at: new Date().toISOString(),
    reason,
    ...(hadOverride ? { replaced: meta.checkOverride } : {}),
  };
  // One transaction, so a clear is never left without its ModActivity row.
  await dbWrite.$transaction(async (tx) => {
    const count = await tx.$executeRaw`
      UPDATE "File" f
      SET metadata = f.metadata || jsonb_build_object('checkOverride', ${JSON.stringify(
        override
      )}::jsonb)
      WHERE f.id = ${file.id}
        AND f.url = ${file.url}
        AND f."entityType" = 'BountyEntry'
        AND f.metadata->>'blockedReason' IS NOT NULL
        AND f.metadata->'checkOverride' IS NOT DISTINCT FROM ${readOverride}::jsonb
    `;
    if (count !== 1)
      throw throwBadRequestError(
        'This file changed while you were reviewing it. Reload and try again.'
      );

    // The reason goes in the row too: the file's copy is dropped on a re-upload.
    await trackModActivity(
      userId,
      {
        entityType: 'bountyEntry',
        entityId: file.entityId,
        activity: `clearFileCheck:${JSON.stringify({ fileId: file.id, reason })}`,
      },
      tx
    );
  });

  logToAxiom({
    type: 'info',
    name: 'bounty-entry-file-check',
    message: 'override cleared',
    fileId: file.id,
  }).catch(handleLogError);

  return { fileId: file.id, entryId: file.entityId };
}

/**
 * A moderator undoes a clear: the file is blocked again exactly as the check left it. Never touches
 * an award already made; it only withholds the file again.
 */
export async function reblockBountyEntryFileCheck({
  fileId,
  userId,
  reason,
}: {
  fileId: number;
  userId: number;
  reason: string;
}) {
  const file = await dbWrite.file.findUnique({
    where: { id: fileId },
    select: { id: true, url: true, entityType: true, entityId: true, metadata: true },
  });
  if (!file || file.entityType !== 'BountyEntry')
    throw throwNotFoundError(`No bounty entry file ${fileId}.`);
  const meta = (file.metadata ?? {}) as Record<string, unknown>;
  if (!meta.blockedReason || !isFileCheckOverride(meta.checkOverride))
    throw throwBadRequestError('This file has no clear to undo.');

  // Guarded on the exact clear the moderator saw: a newer clear by someone else is not this one.
  const readOverride = JSON.stringify(meta.checkOverride);
  await dbWrite.$transaction(async (tx) => {
    // A `replaced` that is itself a valid clear was planted, not written over by a clear: putting it
    // back would leave the file cleared. VALID_OVERRIDE_SQL reads `f`, so it judges `replaced` here
    // through a row of that shape.
    const rows = await tx.$queryRaw<{ metadata: unknown }[]>`
      UPDATE "File" f
      SET metadata = CASE
        WHEN f.metadata->'checkOverride'->'replaced' IS NOT NULL
          AND NOT COALESCE((
            SELECT ${VALID_OVERRIDE_SQL}
            FROM (
              SELECT jsonb_build_object('checkOverride', f.metadata->'checkOverride'->'replaced')
                AS metadata
            ) f
          ), false)
          THEN jsonb_set(f.metadata, '{checkOverride}', f.metadata->'checkOverride'->'replaced')
        ELSE f.metadata - 'checkOverride'
      END
      WHERE f.id = ${file.id}
        AND f.url = ${file.url}
        AND f."entityType" = 'BountyEntry'
        AND f.metadata->>'blockedReason' IS NOT NULL
        AND ${VALID_OVERRIDE_SQL}
        AND f.metadata->'checkOverride' = ${readOverride}::jsonb
      RETURNING f.metadata
    `;
    if (rows.length !== 1)
      throw throwBadRequestError(
        'This file changed while you were reviewing it. Reload and try again.'
      );
    // A re-block that leaves the file unblocked must not be recorded as one; throwing rolls it back.
    if (fileCheckState(rows[0].metadata) !== 'blocked') {
      logToAxiom({
        type: 'error',
        name: 'bounty-entry-file-check',
        message: 're-block would leave the file unblocked',
        fileId: file.id,
      }).catch(handleLogError);
      throw throwBadRequestError("This file couldn't be re-blocked.");
    }

    await trackModActivity(
      userId,
      {
        entityType: 'bountyEntry',
        entityId: file.entityId,
        activity: `reblockFileCheck:${JSON.stringify({ fileId: file.id, reason })}`,
      },
      tx
    );
  });

  logToAxiom({
    type: 'info',
    name: 'bounty-entry-file-check',
    message: 'override revoked',
    fileId: file.id,
  }).catch(handleLogError);

  return { fileId: file.id, entryId: file.entityId };
}
