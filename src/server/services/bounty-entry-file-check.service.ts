import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { findHashOwnership } from '~/server/services/model-file-hash-owner.service';
import { handleLogError, throwBadRequestError } from '~/server/utils/errorHandling';
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

export function fileCheckState(metadata: unknown): FileCheckState {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (meta.blockedReason) return 'blocked';
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
    SELECT f.id, f.url, f.name, f."sizeKB", be."userId" AS "authorId"
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
      await mergeFileMetadata(file, { hashAttemptedAt: attemptedAt });
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

/** Only while the file still has the url that was hashed: a re-upload is checked afresh. */
function mergeFileMetadata(file: PendingFile, patch: Record<string, string>) {
  return dbWrite.$executeRaw`
    UPDATE "File"
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${file.id} AND url = ${file.url}
  `;
}
