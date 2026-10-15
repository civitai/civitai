import { callModEndpoint, readModEndpoint } from './user-actions.service';

// The Buzz decision lives in the main app's `resolveServiceDealDispute`, under the deal lock. This
// file only carries the moderator's choice there and reports the answer.

export type DisputeEvent = {
  id: number;
  type: string;
  actorId: number;
  round: number | null;
  comment: string | null;
  createdAt: string;
};

export type DisputeRow = {
  id: number;
  offering: { id: number; title: string };
  buyer: { id: number; username: string | null };
  seller: { id: number; username: string | null; unavailable: boolean };
  price: number;
  buzzType: 'yellow' | 'green';
  revisionsUsed: number;
  disputeOpenedAt: string | null;
  disputeReason: string | null;
  cancellationReason: string | null;
  completedAt: string | null;
  deliveredAt: string | null;
  finalsClear: boolean;
  events: DisputeEvent[];
};

export type DisputePage = { items: DisputeRow[]; nextCursor?: number };

export type DisputeResolution = 'Refund' | 'Release';

export type DealFile = {
  id: number;
  round: number;
  kind: 'Preview' | 'Final';
  fileName: string;
  mimeType: string;
  size: number;
  status: 'Uploading' | 'Processing' | 'Ready' | 'Failed';
  failReason: string | null;
  scanStatus: 'Pending' | 'Passed' | 'Failed' | 'NotScanned';
  previewUrl: string | null;
  canDownload: boolean;
};

/** Every file of the deal, failed and unscanned included: a moderator reviews what the buyer cannot see. */
export async function listDealFiles(
  dealId: number
): Promise<{ ok: true; files: DealFile[] } | { ok: false; error: string }> {
  const result = await readModEndpoint('creator-services/deal-files', { dealId }, 'Deal files');
  if (!result.ok) return result;
  if (!Array.isArray(result.body.items))
    return { ok: false, error: 'Deal files returned an unexpected body.' };
  return { ok: true, files: result.body.items as DealFile[] };
}

export async function listDisputes(
  cursor?: number,
  limit = 25
): Promise<{ ok: true; page: DisputePage } | { ok: false; error: string }> {
  const result = await readModEndpoint(
    'creator-services/disputes',
    { cursor, limit },
    'Dispute queue'
  );
  if (!result.ok) return result;
  const { items, nextCursor } = result.body;
  if (!Array.isArray(items))
    return { ok: false, error: 'Dispute queue returned an unexpected body.' };
  return {
    ok: true,
    page: {
      items: items as DisputeRow[],
      nextCursor: typeof nextCursor === 'number' ? nextCursor : undefined,
    },
  };
}

export type ResolveOutcome =
  | { ok: true; status: 'resolved' | 'already-resolved'; resolution: DisputeResolution }
  | { ok: false; refused: true; message: string }
  | { ok: false; refused?: false; error: string };

const isResolution = (v: unknown): v is DisputeResolution => v === 'Refund' || v === 'Release';

/**
 * Idempotent on the far side: a deal that is already resolved answers `already-resolved` with the
 * EXISTING resolution, which can differ from the one sent — callers must show that one, not their own.
 * A lost response is therefore safe to retry, unlike most writes in this app.
 */
export async function resolveDispute(input: {
  dealId: number;
  resolution: DisputeResolution;
  note?: string;
}): Promise<ResolveOutcome> {
  const result = await callModEndpoint(
    'creator-services/resolve-dispute',
    {
      dealId: input.dealId,
      resolution: input.resolution,
      ...(input.note ? { note: input.note } : {}),
    },
    'Dispute resolution'
  );
  if (!result.ok) {
    // Anything but a refusal that proves nothing happened may have committed on the far side.
    const lost =
      !result.requestNeverSent &&
      (result.status === undefined || result.status >= 500 || result.status === 408);
    return {
      ok: false,
      error: lost
        ? `${result.error} The ruling may have gone through: reload to check.`
        : result.error,
    };
  }

  const { status, resolution, message } = result.body;
  if (status === 'refused')
    return {
      ok: false,
      refused: true,
      message:
        typeof message === 'string' && message
          ? message
          : 'The final files have not passed scanning. Refund, or clear the file in moderation first.',
    };
  if ((status === 'resolved' || status === 'already-resolved') && isResolution(resolution))
    return { ok: true, status, resolution };
  return { ok: false, error: 'Dispute resolution returned an unexpected body. Reload to check.' };
}
