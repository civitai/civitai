import { logToAxiom } from '~/server/logging/client';

/** A file this large can still be downloading when a short-lived link expires. */
const LARGE_FILE_KB = 1024 * 1024;
const SMALL_FILE_EXPIRY_SAMPLE_RATE = 0.01;

/**
 * How long the signed URL a download was redirected to has left. Never the URL itself: it carries
 * a signature. The download route and download links share this event; `linkId` tells them apart.
 */
export function logUrlExpiry({
  fileId,
  sizeKB,
  urlExpiresAt,
  linkId,
}: {
  fileId: number;
  sizeKB: number;
  urlExpiresAt: Date;
  linkId?: string;
}) {
  const large = sizeKB >= LARGE_FILE_KB;
  if (!large && Math.random() >= SMALL_FILE_EXPIRY_SAMPLE_RATE) return;
  const expiresAt = Number.isNaN(urlExpiresAt.getTime()) ? null : urlExpiresAt;
  logToAxiom({
    name: 'download-model-endpoint',
    type: 'info',
    message: 'url-expiry',
    fileId,
    sizeKB,
    linkId,
    expiresAt: expiresAt?.toISOString() ?? null,
    remainingSeconds: expiresAt ? Math.round((expiresAt.getTime() - Date.now()) / 1000) : null,
    sampleRate: large ? 1 : SMALL_FILE_EXPIRY_SAMPLE_RATE,
  }).catch(() => {
    // swallow logging failure
  });
}
