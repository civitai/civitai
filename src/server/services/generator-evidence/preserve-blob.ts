import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import type { EvidenceRole } from '~/server/services/generator-evidence/evidence-refs';
import type { OrchestratorConfig } from '~/server/services/generator-evidence/orchestrator-evidence';
import {
  fetchBlobContent,
  probeBlob,
  refreshBlob,
} from '~/server/services/generator-evidence/orchestrator-evidence';

export type EvidenceStatus =
  | 'preserved'
  | 'blocked-unreadable'
  | 'gone'
  | 'unavailable'
  | 'external';

/** One file of `details.generatedImages[].blobs[]` on a report filed with preserved evidence. */
export type StoredEvidenceBlob = {
  blobId: string;
  role: EvidenceRole;
  status: EvidenceStatus;
  stepName?: string;
  reason?: string;
  blockedReason?: string;
  /** Lifetime restarted at the orchestrator, for a file it withholds from us. */
  refreshedAt?: string;
  host?: string;
  evidenceKey?: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  preservedAt?: string;
  preservedById?: number;
  /** For an input: the outputs of the same workflow, which were made from it. */
  derivedOutputIds?: string[];
};

export type EvidenceStore = {
  upload(key: string, body: Readable, contentType: string): Promise<void>;
  head(key: string): Promise<{ bytes: number } | null>;
  sha256(key: string): Promise<string>;
};

export const MAX_EVIDENCE_BYTES = 512 * 1024 * 1024;

export const evidenceKeyFor = (userId: number, jobKey: string, blobId: string) =>
  `generator-evidence/${userId}/${jobKey}/${blobId}`;

function hashing(limit: number) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) return done(new Error(`larger than ${limit} bytes`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { stream, result: () => ({ sha256: hash.digest('hex'), bytes }) };
}

/**
 * Copies one blob's original bytes into the evidence store, hashing them on the way, and reads the copy
 * back before calling it preserved. A withheld blob is never copied: it is recorded as unreadable and
 * its lifetime restarted, so it is still there when a read that can reach it exists.
 */
export async function preserveBlob(
  deps: { config: OrchestratorConfig; store: EvidenceStore; now?: () => Date },
  input: {
    userId: number;
    jobKey: string;
    blobId: string;
    role: EvidenceRole;
    stepName?: string;
    blockedReason?: string;
    moderatorId: number;
  }
): Promise<StoredEvidenceBlob> {
  const now = deps.now ?? (() => new Date());
  const base = {
    blobId: input.blobId,
    role: input.role,
    ...(input.stepName && { stepName: input.stepName }),
  };
  const blocked = async (reason?: string): Promise<StoredEvidenceBlob> => {
    const refreshed = await refreshBlob(deps.config, input.blobId).catch(() => false);
    return {
      ...base,
      status: 'blocked-unreadable',
      blockedReason: reason ?? input.blockedReason ?? 'withheld',
      ...(refreshed && { refreshedAt: now().toISOString() }),
    };
  };

  const probe = await probeBlob(deps.config, input.blobId).catch((e: Error) => ({
    kind: 'unavailable' as const,
    status: 0,
    reason: e.message,
  }));
  if (probe.kind === 'blocked') return blocked(probe.reason);
  if (probe.kind === 'gone')
    return { ...base, status: 'gone', reason: 'not found at the orchestrator' };
  if (probe.kind === 'unavailable') return { ...base, status: 'unavailable', reason: probe.reason };

  const content = await fetchBlobContent(deps.config, probe.url).catch((e: Error) => ({
    ok: false as const,
    reason: e.message,
    blocked: false,
  }));
  if (!content.ok) {
    if (content.blocked) return blocked();
    return { ...base, status: 'unavailable', reason: content.reason };
  }
  if (content.contentLength && content.contentLength > MAX_EVIDENCE_BYTES) {
    void content.body.cancel();
    return { ...base, status: 'unavailable', reason: 'too large to preserve' };
  }

  const evidenceKey = evidenceKeyFor(input.userId, input.jobKey, input.blobId);
  const hasher = hashing(MAX_EVIDENCE_BYTES);
  try {
    const source = Readable.fromWeb(content.body as NodeReadableStream<Uint8Array>);
    source.on('error', (e) => hasher.stream.destroy(e));
    await deps.store.upload(evidenceKey, source.pipe(hasher.stream), content.contentType);
  } catch (e) {
    return { ...base, status: 'unavailable', reason: `copy failed: ${(e as Error).message}` };
  }
  const { sha256, bytes } = hasher.result();

  const head = await deps.store.head(evidenceKey).catch(() => null);
  const stored = head ? await deps.store.sha256(evidenceKey).catch(() => null) : null;
  if (!head || head.bytes !== bytes || stored !== sha256)
    return { ...base, status: 'unavailable', reason: 'the stored copy did not read back the same' };

  return {
    ...base,
    status: 'preserved',
    evidenceKey,
    sha256,
    bytes,
    contentType: content.contentType,
    preservedAt: now().toISOString(),
    preservedById: input.moderatorId,
  };
}
