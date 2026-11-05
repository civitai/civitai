import { TRPCError } from '@trpc/server';
import type { TriggerRef } from '~/server/services/generator-evidence/evidence-meta';
import { EVIDENCE_MEDIA_TYPES } from '~/server/services/generator-evidence/evidence-meta';
import { workflowOwnerId } from '~/server/services/generator-evidence/evidence-refs';
import type {
  EvidenceStore,
  StoredEvidenceBlob,
} from '~/server/services/generator-evidence/preserve-blob';

/** A copy another preserve run already made, as its manifest records it. */
export type AdoptableCopy = {
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
};

const MANIFEST_KEY =
  /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/(\d{1,10})\/manifest-[0-9A-Za-z]{1,32}\.jsonl$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const RESERVED_PREFIXES = new Set(['external-reports', 'generator-evidence']);

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const int = (value: unknown) => (Number.isInteger(value) ? (value as number) : undefined);

/** The user a manifest key is filed under, or null when the key is not a manifest's. */
export function manifestUserId(key: string) {
  const match = MANIFEST_KEY.exec(key);
  if (!match || RESERVED_PREFIXES.has(match[1])) return null;
  return { prefix: `${match[1]}/${match[2]}/`, userId: Number(match[2]) };
}

const notThisUsers = () =>
  new TRPCError({ code: 'BAD_REQUEST', message: 'This manifest is not one of this user.' });

/** The manifest's text, read only when its key is this user's and its size is within the cap. */
export async function readManifest(store: EvidenceStore, key: string, userId: number) {
  if (manifestUserId(key)?.userId !== userId) throw notThisUsers();
  const head = await store.head(key);
  if (!head) throw new TRPCError({ code: 'NOT_FOUND', message: 'No manifest at this key.' });
  if (head.bytes > MAX_MANIFEST_BYTES) throw tooLarge();
  // The object can change after its HEAD, so the read is bounded too.
  const bytes = await store.read(key, MAX_MANIFEST_BYTES);
  if (bytes.length > MAX_MANIFEST_BYTES) throw tooLarge();
  return new TextDecoder().decode(bytes);
}

const tooLarge = () =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: `This manifest is over ${MAX_MANIFEST_BYTES / 1024 / 1024} MiB.`,
  });

/**
 * What a preserve run's manifest offers for one user: the copies it made, by blob id, and the
 * workflows and triggers it covered. Only rows for that user whose copy sits under the manifest's
 * own folder count; nothing is trusted until it is read back.
 */
export function parseManifest(text: string, key: string, userId: number) {
  const scope = manifestUserId(key);
  if (!scope || scope.userId !== userId) throw notThisUsers();
  const copies = new Map<string, AdoptableCopy>();
  const workflowIds = new Set<string>();
  const triggers = new Map<string, TriggerRef>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.userId !== userId) continue;
    const workflowId = str(row.workflowId);
    if (workflowId && workflowOwnerId(workflowId) === userId) workflowIds.add(workflowId);
    const restrictionId = int(row.restrictionId);
    const index = int(row.triggerIndex);
    if (restrictionId && index !== undefined && index >= 0)
      triggers.set(`${restrictionId}:${index}`, { restrictionId, index });

    const imageId = str(row.imageId);
    const objectKey = str(row.objectKey);
    const sha256 = str(row.sha256);
    const bytes = int(row.bytes);
    const contentType = str(row.contentType);
    if (row.status !== 'copied' || !imageId || !objectKey || !sha256 || !bytes || !contentType)
      continue;
    if (!objectKey.startsWith(scope.prefix) || objectKey.includes('..') || !SHA256.test(sha256))
      continue;
    if (!EVIDENCE_MEDIA_TYPES.has(contentType.toLowerCase())) continue;
    copies.set(imageId, { objectKey, sha256, bytes, contentType });
  }
  return { copies, workflowIds: [...workflowIds], triggers: [...triggers.values()] };
}

/** A manifest's copy of one blob, if it still reads back as recorded; null means copy it afresh. */
export async function adoptCopy(
  store: EvidenceStore,
  copy: AdoptableCopy,
  base: Pick<StoredEvidenceBlob, 'blobId' | 'role' | 'stepName'>,
  moderatorId: number,
  now: Date
): Promise<StoredEvidenceBlob | null> {
  const head = await store.head(copy.objectKey).catch(() => null);
  if (!head || head.bytes !== copy.bytes) return null;
  const sha256 = await store.sha256(copy.objectKey).catch(() => null);
  if (sha256 !== copy.sha256) return null;
  return {
    ...base,
    status: 'preserved',
    evidenceKey: copy.objectKey,
    sha256,
    bytes: copy.bytes,
    contentType: copy.contentType,
    preservedAt: now.toISOString(),
    preservedById: moderatorId,
  };
}
