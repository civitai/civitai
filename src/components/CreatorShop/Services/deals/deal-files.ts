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
 * Re-read the list while a preview is being prepared. Not while one is Uploading: an upload the
 * seller abandoned stays Uploading, and the uploader refreshes the list itself when it finishes.
 */
export const isPreparingPreviews = (files: DealFileFacts[]) =>
  files.some((file) => file.kind === 'Preview' && file.status === 'Processing');

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
 * final in the round has passed its check; this says so before the buyer tries.
 */
export function acceptDeliveryBlocked(
  deal: { status: ServiceDealStatus; revisionsUsed: number },
  files: DealFileFacts[] | undefined
) {
  if (deal.status !== 'Delivered' || !files) return null;
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

export const serviceDealDownloadHref = (fileId: number) =>
  `/api/service-deals/files/${fileId}/download`;
