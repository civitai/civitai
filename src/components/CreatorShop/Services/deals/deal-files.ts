import {
  SERVICE_FINAL_EXTENSIONS,
  SERVICE_FINAL_MAX_BYTES,
  SERVICE_FINAL_MAX_FILES,
  SERVICE_PREVIEW_ANIMATED_MAX_BYTES,
  SERVICE_PREVIEW_MAX_BYTES,
  SERVICE_PREVIEW_MAX_FILES,
  SERVICE_PREVIEW_MIME_TYPES,
} from '~/shared/constants/creator-services.constants';
import type {
  ServiceDealFileKind,
  ServiceDealFileScanStatus,
  ServiceDealFileStatus,
  ServiceDealStatus,
  ServicePreviewKind,
} from '~/shared/utils/prisma/enums';

/** The fields of `creatorServiceDealFile.list` these rules read. */
export type DealFileFacts = {
  id: number;
  round: number;
  kind: ServiceDealFileKind;
  status: ServiceDealFileStatus;
  scanStatus: ServiceDealFileScanStatus | null;
  canDownload: boolean;
};

const MB = 1024 * 1024;
const megabytes = (bytes: number) => `${Math.floor(bytes / MB)} MB`;

/**
 * Why a file would be refused before it is sent, or null. Mirrors the server's checks so a seller
 * isn't made to upload 2 GB to learn the type is wrong; the server still decides. An animated
 * preview's frame count can't be read here cheaply, so the server's failReason reports that one.
 */
export function uploadRefusal(
  kind: ServiceDealFileKind,
  file: { name: string; type: string; size: number }
) {
  if (kind === 'Preview') {
    if (!(SERVICE_PREVIEW_MIME_TYPES as readonly string[]).includes(file.type))
      return 'Previews must be JPEG, PNG, WebP or GIF images.';
    // GIF and WebP may be animated, so they get the animated allowance, as on the server.
    const cap =
      file.type === 'image/gif' || file.type === 'image/webp'
        ? SERVICE_PREVIEW_ANIMATED_MAX_BYTES
        : SERVICE_PREVIEW_MAX_BYTES;
    if (file.size > cap) return `Preview is too large (max ${megabytes(cap)}).`;
    return null;
  }
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (!(SERVICE_FINAL_EXTENSIONS as readonly string[]).includes(extension))
    return `.${extension || '(none)'} files can't be delivered. Use a .zip for anything else.`;
  if (file.size > SERVICE_FINAL_MAX_BYTES) return 'That file is too large to deliver (max 2 GB).';
  return null;
}

/** How many more files of a kind the seller may add to the round in progress. */
export function uploadSlotsLeft(
  kind: ServiceDealFileKind,
  previewKind: ServicePreviewKind,
  files: DealFileFacts[],
  round: number
) {
  const max = kind === 'Preview' ? SERVICE_PREVIEW_MAX_FILES[previewKind] : SERVICE_FINAL_MAX_FILES;
  const used = files.filter((file) => file.round === round && file.kind === kind).length;
  return Math.max(0, max - used);
}

/**
 * The files the seller picked, split into what to send, what is refused and why, and how many
 * did not fit. Refused files are set aside first, so a bad pick never takes a good one's slot.
 */
export function sortPicked<T extends { name: string; type: string; size: number }>(
  kind: ServiceDealFileKind,
  picked: T[],
  slots: number
) {
  const refused: { name: string; reason: string }[] = [];
  const valid: T[] = [];
  for (const file of picked) {
    const reason = uploadRefusal(kind, file);
    if (reason) refused.push({ name: file.name, reason });
    else valid.push(file);
  }
  return {
    send: valid.slice(0, slots),
    refused,
    overflow: Math.max(0, valid.length - slots),
  };
}

const PREVIEW_POLL_MS = 10_000;
const SCAN_POLL_MS = 30_000;

/**
 * How often to re-read the list, or false. While a preview is being prepared, and while a final
 * of a delivered round waits for its check, which decides whether the buyer may accept. Only
 * then: a pending check anywhere else changes nothing on this page, and each read hits the
 * primary. Not for an Uploading file: an upload the seller abandoned stays Uploading, and the
 * uploader refreshes the list itself when one finishes.
 */
export function filesPollMs(
  files: DealFileFacts[],
  deal: { status: ServiceDealStatus; revisionsUsed: number }
) {
  if (files.some((file) => file.kind === 'Preview' && file.status === 'Processing'))
    return PREVIEW_POLL_MS;
  if (
    deal.status === 'Delivered' &&
    files.some(
      (file) =>
        file.kind === 'Final' &&
        file.round === deal.revisionsUsed &&
        file.status === 'Ready' &&
        file.scanStatus === 'Pending'
    )
  )
    return SCAN_POLL_MS;
  return false;
}

export function filesByRound<T extends { round: number }>(files: T[]) {
  const rounds = new Map<number, T[]>();
  for (const file of files) rounds.set(file.round, [...(rounds.get(file.round) ?? []), file]);
  return [...rounds.entries()]
    .sort(([a], [b]) => b - a)
    .map(([round, roundFiles]) => ({ round, files: roundFiles }));
}

export type FinalsState = 'sealed' | 'checking' | 'checkingOwned' | 'failed' | 'available';

/**
 * Where the buyer's final files for a round stand. Never "available" until the server says each
 * one can be downloaded, and never "sealed" (unlocks on accept) while a check is still running:
 * a sealed file the buyer accepted must actually unlock.
 */
export function buyerFinalsState(
  finals: DealFileFacts[],
  { owned }: { owned: boolean }
): FinalsState | null {
  if (finals.length === 0) return null;
  if (finals.every((file) => file.canDownload)) return 'available';
  if (finals.some((file) => file.scanStatus === 'Failed')) return 'failed';
  if (finals.some((file) => file.scanStatus !== 'Passed'))
    return owned ? 'checkingOwned' : 'checking';
  // Owned, passed and still not downloadable: the server knows why; say nothing it hasn't said.
  return owned ? 'checkingOwned' : 'sealed';
}

/** The buyer owns a deal's final files once it completed, and still does while disputed after. */
export const buyerOwnsFinals = (deal: { status: ServiceDealStatus; completedAt: Date | null }) =>
  deal.status === 'Completed' || (deal.status === 'Disputed' && deal.completedAt !== null);

/**
 * The state line under a round's files on the buyer's page, or null. Only the delivered round of
 * a deal the buyer can accept, or one they own, has one: earlier rounds were sent back, and in any
 * other status (a cancellation, a refund) nothing will unlock, so nothing promises it.
 */
export function buyerRoundFinalsState(
  deal: { status: ServiceDealStatus; revisionsUsed: number; completedAt: Date | null },
  round: number,
  finals: DealFileFacts[]
) {
  if (round !== deal.revisionsUsed) return null;
  if (deal.status === 'Delivered') return buyerFinalsState(finals, { owned: false });
  if (buyerOwnsFinals(deal)) return buyerFinalsState(finals, { owned: true });
  return null;
}

export const finalsCopy: Record<FinalsState, string> = {
  sealed: 'The final files unlock when you accept the delivery.',
  checking:
    "The seller's files are being checked. You can accept the delivery once they're cleared.",
  checkingOwned: "Your files are being checked. They unlock for download once they're cleared.",
  failed: 'A file failed our check, so this delivery is with our moderators.',
  available: 'Your final files are ready to download.',
};

/**
 * Why Accept delivery is shown but disabled, or null. The server refuses completion until every
 * final in the round has passed its check; this says so before the buyer tries. Disabled while
 * the list loads, so an unchecked delivery is never one click away. Only if the list was never
 * read is the button left to the server, rather than locked with no way forward: a failed refresh
 * keeps the files it last read, and they still decide.
 */
export function acceptDeliveryBlocked(
  deal: { status: ServiceDealStatus; revisionsUsed: number },
  { files, failed }: { files: DealFileFacts[] | undefined; failed: boolean }
) {
  if (deal.status !== 'Delivered') return null;
  if (!files) return failed ? null : 'Loading the delivery…';
  const finals = files.filter((file) => file.kind === 'Final' && file.round === deal.revisionsUsed);
  return finals.some((file) => file.scanStatus !== 'Passed')
    ? "Files are still being checked. You can accept once they're cleared."
    : null;
}

/** The seller's view of one file in the round they are working on. */
export function sellerFileStatus(file: DealFileFacts): { label: string; color: string } {
  if (file.status === 'Uploading') return { label: 'Uploading', color: 'gray' };
  if (file.status === 'Failed') return { label: 'Failed', color: 'red' };
  if (file.kind === 'Preview')
    return file.status === 'Processing'
      ? { label: 'Preparing preview', color: 'blue' }
      : { label: 'Preview ready', color: 'green' };
  if (file.scanStatus === 'Passed') return { label: 'Cleared', color: 'green' };
  if (file.scanStatus === 'Failed') return { label: 'Failed check', color: 'red' };
  return { label: 'Being checked', color: 'blue' };
}

/**
 * Why Deliver must wait on the round in progress, or null: a final still awaiting its scan or a
 * preview still being built. A file that failed or is mid-upload does not wait; the server still
 * decides when Deliver is accepted.
 */
export function deliverWait(files: DealFileFacts[], round: number) {
  const current = files.filter(
    (file) => file.round === round && file.status !== 'Uploading' && file.status !== 'Failed'
  );
  if (
    current.some(
      (file) => file.kind === 'Final' && (!file.scanStatus || file.scanStatus === 'Pending')
    )
  )
    return 'Checking files…';
  if (current.some((file) => file.kind === 'Preview' && file.status === 'Processing'))
    return 'Building preview…';
  return null;
}

export const serviceDealDownloadHref = (fileId: number) =>
  `/api/service-deals/files/${fileId}/download`;
