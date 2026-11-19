import {
  SERVICE_ATTACHMENT_MAX_FILES,
  SERVICE_FINAL_EXTENSIONS,
  SERVICE_FINAL_MAX_BYTES,
  SERVICE_FINAL_MAX_FILES,
  SERVICE_FINAL_VIDEO_EXTENSIONS,
  SERVICE_FINAL_VIDEO_MAX_BYTES,
  SERVICE_FINAL_VIDEO_MAX_SECONDS,
  SERVICE_PREVIEW_ANIMATED_MAX_BYTES,
  SERVICE_PREVIEW_MAX_BYTES,
  SERVICE_PREVIEW_MAX_FILES,
  SERVICE_PREVIEW_MIME_TYPES,
  SERVICE_PREVIEW_VIDEO_MAX_BYTES,
  SERVICE_PREVIEW_VIDEO_MIME_TYPES,
  isVideoPreviewMime,
} from '~/shared/constants/creator-services.constants';
import type {
  ServiceDealFileKind,
  ServiceDealFileScanStatus,
  ServiceDealFileStatus,
  ServiceDealStatus,
  ServicePreviewKind,
} from '~/shared/utils/prisma/enums';

const VIDEO_LIKE_EXTENSIONS = ['mov', 'mkv', 'avi', 'm4v', 'wmv', 'mpg', 'mpeg', 'flv', '3gp'];
const isVideoLike = (file: { type?: string }, extension: string) =>
  !!file.type?.startsWith('video/') ||
  VIDEO_LIKE_EXTENSIONS.includes(extension) ||
  (SERVICE_FINAL_VIDEO_EXTENSIONS as readonly string[]).includes(extension);

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

/** What the preview picker offers: video only where the deal takes a video preview. */
export const previewAccept = (previewKind: ServicePreviewKind) =>
  [
    ...SERVICE_PREVIEW_MIME_TYPES,
    ...(previewKind === 'Video' ? SERVICE_PREVIEW_VIDEO_MIME_TYPES : []),
  ].join(',');
const megabytes = (bytes: number) => `${Math.floor(bytes / MB)} MB`;

/**
 * Why a file would be refused before it is sent, or null. Mirrors the server's checks so a seller
 * isn't made to upload 2 GB to learn the type is wrong; the server still decides. An animated
 * preview's frame count can't be read here cheaply, so the server's failReason reports that one.
 */
export function uploadRefusal(
  kind: ServiceDealFileKind,
  file: { name: string; type: string; size: number },
  previewKind?: ServicePreviewKind
) {
  if (kind === 'Preview' && isVideoPreviewMime(file.type)) {
    if (previewKind !== 'Video') return 'Previews must be JPEG, PNG, WebP or GIF images.';
    if (file.size > SERVICE_PREVIEW_VIDEO_MAX_BYTES)
      return `Preview is too large (max ${megabytes(SERVICE_PREVIEW_VIDEO_MAX_BYTES)}).`;
    return null;
  }
  if (kind === 'Preview') {
    if (!(SERVICE_PREVIEW_MIME_TYPES as readonly string[]).includes(file.type))
      return previewKind === 'Video'
        ? 'Previews must be MP4 or WebM videos, or JPEG, PNG, WebP or GIF images.'
        : 'Previews must be JPEG, PNG, WebP or GIF images.';
    // GIF and WebP may be animated, so they get the animated allowance, as on the server.
    const cap =
      file.type === 'image/gif' || file.type === 'image/webp'
        ? SERVICE_PREVIEW_ANIMATED_MAX_BYTES
        : SERVICE_PREVIEW_MAX_BYTES;
    if (file.size > cap) return `Preview is too large (max ${megabytes(cap)}).`;
    return null;
  }
  const verb = kind === 'Attachment' ? 'attached' : 'delivered';
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const finalVideo = (SERVICE_FINAL_VIDEO_EXTENSIONS as readonly string[]).includes(extension);
  // A video is never sent to a .zip: one inside an archive is refused.
  if (kind === 'Attachment' && (finalVideo || isVideoLike(file, extension)))
    return "Videos can't be attached.";
  if (!finalVideo && isVideoLike(file, extension))
    return `Upload a video as .mp4 or .webm, up to ${SERVICE_FINAL_VIDEO_MAX_SECONDS} seconds.`;
  if (!(SERVICE_FINAL_EXTENSIONS as readonly string[]).includes(extension))
    return `.${extension || '(none)'} files can't be ${verb}. Use a .zip for anything else.`;
  if (file.size > SERVICE_FINAL_MAX_BYTES)
    return `That file is too large to be ${verb} (max 2 GB).`;
  if (finalVideo && file.size > SERVICE_FINAL_VIDEO_MAX_BYTES)
    return `A video cannot be more than ${megabytes(SERVICE_FINAL_VIDEO_MAX_BYTES)}.`;
  return null;
}

/** A buyer may attach files from the request until the seller delivers; the server enforces it. */
export const canAttachInStatus = (status: ServiceDealStatus) =>
  status === 'Requested' || status === 'Accepted' || status === 'InRevision';

/** A closed deal's files are on the retention clock, so its parties are told when they go. */
export const showsRetentionNotice = (status: ServiceDealStatus) =>
  status === 'Declined' || status === 'Expired' || status === 'Cancelled' || status === 'Completed';

/** How many more files the buyer may attach to the deal, across all rounds. */
export const attachmentSlotsLeft = (files: DealFileFacts[]) =>
  Math.max(
    0,
    SERVICE_ATTACHMENT_MAX_FILES - files.filter((file) => file.kind === 'Attachment').length
  );

/** One attached file as its viewer sees it. The seller only ever receives files that passed. */
export function attachmentStatus(file: DealFileFacts): { label: string; color: string } {
  if (file.status === 'Uploading') return { label: 'Uploading', color: 'gray' };
  if (file.status === 'Failed' || file.scanStatus === 'Failed')
    return { label: 'Not accepted', color: 'red' };
  if (file.scanStatus === 'Passed') return { label: 'Shared', color: 'green' };
  return { label: 'Being checked', color: 'blue' };
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
  slots: number,
  previewKind?: ServicePreviewKind
) {
  const refused: { name: string; reason: string }[] = [];
  const valid: T[] = [];
  for (const file of picked) {
    const reason = uploadRefusal(kind, file, previewKind);
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
 * How often to re-read the list, or false. While a preview is being prepared, while an attachment
 * is being checked (only its uploader sees it then), and while a final of a delivered round waits
 * for its check, which decides whether the buyer may accept. Only
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
    files.some(
      (file) =>
        file.kind === 'Attachment' && file.status === 'Ready' && file.scanStatus === 'Pending'
    )
  )
    return SCAN_POLL_MS;
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

/**
 * What the seller still has to add before Deliver can work, or null. Mirrors the server's
 * `dealReadyToDeliver`: a Ready preview (unless the offering takes none) and a Ready, scan-passed
 * final in the round in progress, and no failed file in it (the server refuses a round holding one).
 * The server stays the authority; this only keeps the button from
 * inviting a click that is certain to be refused.
 */
export function deliverNeeds(
  files: DealFileFacts[],
  round: number,
  previewKind: ServicePreviewKind
) {
  const current = files.filter((file) => file.round === round);
  const hasPreview = current.some((file) => file.kind === 'Preview' && file.status === 'Ready');
  const hasFinal = current.some(
    (file) => file.kind === 'Final' && file.status === 'Ready' && file.scanStatus === 'Passed'
  );
  const hasFailed = current.some(
    (file) => file.status === 'Failed' || (file.kind === 'Final' && file.scanStatus === 'Failed')
  );
  if (hasFailed) return 'Remove or replace the file that failed.';
  const needsPreview = previewKind !== 'None' && !hasPreview;
  if (needsPreview && !hasFinal) return 'Add a preview and your final files to deliver.';
  if (needsPreview) return 'Add a preview to deliver.';
  if (!hasFinal) return 'Add your final files to deliver.';
  return null;
}

export const serviceDealDownloadHref = (fileId: number) =>
  `/api/service-deals/files/${fileId}/download`;
