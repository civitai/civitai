import { responseMayHaveLanded } from './rest-error-reason';
import { callModEndpoint, readModEndpoint } from './user-actions.service';

// The Buzz decision lives in the main app's `resolveServiceDealDispute`, under the deal lock. This
// file only carries the moderator's choice there and reports the answer.

export type DisputeEvent = {
  id: number;
  type: string;
  actorId: number;
  round: number | null;
  comment: string | null;
  /** Set when the party chose a code; `comment` is then null if they were muted or sent a code only. */
  reasonCode?: string | null;
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
  /** Absent from a main app that predates dispute reviews. */
  latestReview?: DisputeReview | null;
};

export type DisputeReview = {
  id: number;
  class: string;
  proposal: DisputeResolution | null;
  confidence: number | null;
  rationale: string;
  agentVersion: string;
  mode: 'shadow' | 'propose' | 'settle';
  createdAt: string;
};

/** `nextCursor` is opaque: it goes back as `?cursor=` untouched. */
export type DisputePage = { items: DisputeRow[]; nextCursor?: string };

export type DisputeResolution = 'Refund' | 'Release';

export type DealFile = {
  dealId: number;
  id: number;
  round: number;
  kind: 'Preview' | 'Final';
  /** Null only for a buyer who has not paid for the file; a moderator always gets the name. */
  fileName: string | null;
  mimeType: string;
  size: number;
  status: 'Uploading' | 'Processing' | 'Ready' | 'Failed';
  failReason: string | null;
  scanStatus: 'Pending' | 'Passed' | 'Failed' | 'NotScanned';
  previewUrl: string | null;
  canDownload: boolean;
  /** Who has taken the file. Absent from a main app that predates it. */
  access?: DealFileAccess[];
};

/** One role's accesses of one file. `ModeratorFetch` is the dispute tool, never a party's download. */
export type DealFileAccess = {
  role: 'Buyer' | 'Seller' | 'Moderator';
  kind: 'Download' | 'ModeratorFetch';
  count: number;
  firstAt: string;
  lastAt: string;
};

/**
 * Every file of the given deals (the endpoint takes at most 25), failed and unscanned included: a
 * moderator reviews what the buyer cannot see. A deal with no files, or no such deal, contributes no rows.
 */
export async function listDealFiles(dealIds: number[]): Promise<
  | {
      ok: true;
      files: DealFile[];
      /** When file accesses started being recorded; nothing earlier is in `access`. */
      accessRecordedSince: string | null;
    }
  | { ok: false; error: string }
> {
  if (dealIds.length === 0) return { ok: true, files: [], accessRecordedSince: null };
  const result = await readModEndpoint(
    'creator-services/deal-files',
    { dealIds: dealIds.join(',') },
    'Deal files'
  );
  if (!result.ok) return result;
  if (!Array.isArray(result.body.items))
    return { ok: false, error: 'Deal files returned an unexpected body.' };
  const { accessRecordedSince } = result.body;
  return {
    ok: true,
    files: result.body.items as DealFile[],
    accessRecordedSince: typeof accessRecordedSince === 'string' ? accessRecordedSince : null,
  };
}

/** A short-lived signed URL for the ORIGINAL file, in any status. Fetched here so the browser needs no
 *  main-app session of its own. */
export async function getDealFileUrl(
  fileId: number
): Promise<{ ok: true; url: string } | { ok: false; status: number; error: string }> {
  const result = await readModEndpoint('creator-services/deal-file-url', { fileId }, 'File link');
  if (!result.ok)
    return { ok: false, status: result.status === 404 ? 404 : 502, error: result.error };
  const { url } = result.body;
  // Only ever sent on as a redirect target, so anything but an absolute https URL is refused.
  if (typeof url !== 'string' || !/^https:\/\//i.test(url))
    return { ok: false, status: 502, error: 'File link returned an unexpected body.' };
  return { ok: true, url };
}

export async function listDisputes(
  cursor?: string,
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
      nextCursor: typeof nextCursor === 'string' && nextCursor ? nextCursor : undefined,
    },
  };
}

export type ResolveOutcome =
  | { ok: true; status: 'resolved' | 'already-resolved'; resolution: DisputeResolution }
  | { ok: true; status: 'held-for-review'; reason: string | null }
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
    return {
      ok: false,
      error: responseMayHaveLanded(result)
        ? `${result.error} The ruling may have gone through: reload to check.`
        : result.error,
    };
  }

  const { status, resolution, message, reason } = result.body;
  // A Release was recorded but the payout claim held the deal again; it is back in the queue.
  if (status === 'held-for-review')
    return { ok: true, status, reason: typeof reason === 'string' ? reason : null };
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
